import { useEffect, useRef } from "react";
import { AppShell } from "./components/layout/AppShell";
import { QuitConfirmDialog } from "./components/dialogs/QuitConfirmDialog";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useWindowTitle } from "./hooks/useWindowTitle";
import { useAppStore } from "./stores/appStore";
import { applyHashState, initUrlStateSync } from "./lib/urlState";
import { loadProjectFromPath } from "./lib/loadProject";
import { readOpenFileParam } from "./lib/windowRouting";
import { isTauri } from "./platform";
import { setupCloseHandler } from "./lib/quit";
import { toast } from "./lib/notify";
import {
  configureLibavDecoder,
  registerLibavH264Decoder,
  nativeH264DecodableSync,
  overrideNativeH264Decodable,
} from "@talmolab/sleap-io.js";
import { sleapCmd } from "./lib/sleapPlugin";

// Drain (take, once) the pending "initial file" slot in Rust. The slot is
// populated from a CLI argument on launch OR a macOS file-association open
// (RunEvent::Opened). get_initial_file take()s the slot, so draining it from
// both the launch poll and the `open-file` listener is race-safe: whoever runs
// first gets the path, the other gets null (no double-handling).
async function takeInitialFile(): Promise<string | null> {
  const { invoke } = await import("@tauri-apps/api/core");
  // Prefixed for the inlined `sleap` plugin so it resolves from the
  // http://localhost origin (bundled builds) as well as the dev origin.
  return invoke<string | null>(sleapCmd("get_initial_file"));
}

// Load `path` into THIS window directly (bypassing routing). Used for cold-start
// opens and for a window spawned specifically to hold a file.
async function loadPathHere(path: string): Promise<void> {
  const { readFile, exists } = await import("@tauri-apps/plugin-fs");
  await loadProjectFromPath(path, readFile, exists);
}

// Guards the one-time "software decoding" toast against React StrictMode, which
// double-invokes effects in dev (the toast would otherwise appear twice).
let softwareDecodingToastShown = false;

export default function App() {
  useKeyboardShortcuts();
  useWindowTitle();

  useEffect(() => {
    setupCloseHandler();
  }, []);

  // Re-apply the persisted UI scale to the CSS var on boot. uiScale is restored
  // into the store by zustand-persist, but the --ui-scale var is otherwise only
  // set inside the +/- handlers, so without this a reload would not re-scale.
  useEffect(() => {
    const scale = useAppStore.getState().uiScale;
    document.documentElement.style.setProperty("--ui-scale", String(scale));
  }, []);

  // Register the libav.js H.264 software-decoder fallback, and warn only when it
  // is actually needed. On Linux/WebKitGTK many systems can't decode H.264 with
  // hardware acceleration; the fallback decodes it in WASM so MP4 videos render
  // instead of showing blank frames. macOS, Windows, and Linux-with-codec keep
  // using native decode — the decoder self-gates on a real `isConfigSupported`
  // probe (this supersedes the old API-presence-only webcodecsProbe check).
  useEffect(() => {
    (async () => {
      configureLibavDecoder({
        wasmBaseUrl: `${import.meta.env.BASE_URL}decoders/libav-h264`,
      });
      // Dev/test: force the software path even where native H.264 works, to
      // exercise the fallback end-to-end. Enable with VITE_FORCE_LIBAV_H264=1 or
      // a `?forceLibavH264` URL parameter.
      const forced =
        import.meta.env.VITE_FORCE_LIBAV_H264 === "1" ||
        new URLSearchParams(window.location.search).has("forceLibavH264");
      if (forced) overrideNativeH264Decodable(false);

      await registerLibavH264Decoder(); // registers + resolves the native probe

      if (nativeH264DecodableSync() === false && !softwareDecodingToastShown) {
        softwareDecodingToastShown = true;
        toast.info("Using software video decoding", {
          description:
            "This system can't decode H.264 with hardware acceleration, so video is " +
            "decoded in software (WASM). Playback and scrubbing may be slower, " +
            "especially at 1080p.",
          duration: 9000,
        });
      }
    })().catch((err) => {
      console.warn("[app] libav H.264 fallback setup failed:", err);
    });
  }, []);

  const projectLoaded = useAppStore((s) => s.projectLoaded);
  const hashApplied = useRef(false);

  // Cold-start open (Tauri only): either this window was spawned to hold a
  // specific file (`?openFile=` — the "open in a new window" routing) or it's
  // the initial window receiving a CLI-arg / macOS file-association path from the
  // Rust slot. Both load directly into THIS window (no routing needed — a spawned
  // window is dedicated, and at cold start nothing else is open). Crash-recovery
  // drafts are NOT auto-restored here — the WelcomeScreen "Restore unsaved work?"
  // card surfaces them (recoverableDrafts.ts), so recovery is an escapable click.
  useEffect(() => {
    if (!isTauri) return;
    (async () => {
      const spawned = readOpenFileParam(window.location.search);
      if (spawned) {
        // Strip the param so a later reload of this window doesn't reopen the
        // original file (this window may hold a different project by then).
        const url = new URL(window.location.href);
        url.searchParams.delete("openFile");
        window.history.replaceState(null, "", url.toString());
        await loadPathHere(spawned).catch((err) =>
          console.warn("[app] Failed to open spawned-window file:", err)
        );
        return;
      }
      const path = await takeInitialFile();
      if (path) {
        console.log("[app] Loading initial file:", path);
        await loadPathHere(path).catch((err) =>
          console.warn("[app] Failed to load initial file:", err)
        );
      }
    })();
  }, []);

  // macOS "Open With" / file-association while the app is ALREADY running (or
  // that lands after the launch poll). Finder delivers it as an Apple Event,
  // which Rust forwards as a broadcast `open-file`; the first window to drain the
  // slot routes the path through openOrFocusPath — focus the window that already
  // has it, load into an empty window, or spawn a new one — so a running project
  // is never clobbered.
  useEffect(() => {
    if (!isTauri) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const fn = await listen("open-file", async () => {
        const path = await takeInitialFile();
        if (!path) return;
        const { openOrFocusPath } = await import("./lib/windowRouting");
        await openOrFocusPath(path).catch((err) =>
          console.warn("[app] Failed to route opened file:", err)
        );
      });
      // Component may have unmounted before the listener resolved.
      if (active) unlisten = fn;
      else fn();
    })();
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  // Targeted load: openOrFocusPath sends `load-file` (emitTo) to a specific
  // empty window when it routes an open there. Only the targeted window receives
  // it; load the payload path in place.
  useEffect(() => {
    if (!isTauri) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const fn = await listen<{ path: string }>("load-file", async (event) => {
        const path = event.payload?.path;
        if (!path) return;
        await loadPathHere(path).catch((err) =>
          console.warn("[app] Failed to load routed file:", err)
        );
      });
      if (active) unlisten = fn;
      else fn();
    })();
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  // Keep the cross-window open-file registry (Rust WindowFiles) in sync with this
  // window's project. Seeds `null` (empty/Welcome) immediately so routing can
  // reuse this window, then updates on every projectPath change — which covers
  // load, Save-As (path changes), and close-to-Welcome (clears to null).
  useEffect(() => {
    if (!isTauri) return;
    let unsub: (() => void) | undefined;
    (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const label = getCurrentWindow().label;
      const { windowSetFile } = await import("./lib/windowRouting");
      unsub = useAppStore.subscribe(
        (s) => s.projectPath,
        (projectPath) => {
          windowSetFile(label, projectPath ?? null).catch(() => {});
        },
        { fireImmediately: true }
      );
    })();
    return () => unsub?.();
  }, []);

  useEffect(() => {
    // Prevent browser default drag-and-drop behavior
    const prevent = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  // Desktop drag-and-drop (#132). The Tauri webview intercepts OS file drops, so
  // the HTML drop event never fires in the desktop app — wire Tauri's own
  // drag-drop event to load a dropped .slp by path. Reuses loadProjectFromPath,
  // so it inherits the unsaved-changes confirm + toasts and works whether the
  // welcome screen or the editor is showing. (Browser keeps its HTML drop.)
  useEffect(() => {
    if (!isTauri) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    (async () => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const fn = await getCurrentWebview().onDragDropEvent(async (event) => {
        if (event.payload.type !== "drop") return;
        // Only open via drag-drop on the welcome screen; never replace a project
        // that's already loaded (a stray drop could discard unsaved work).
        if (useAppStore.getState().projectLoaded) return;
        const slp = event.payload.paths.find((p) =>
          p.toLowerCase().endsWith(".slp")
        );
        if (!slp) return;
        // Route so a drop of an already-open file focuses that window instead of
        // loading a duplicate; on this empty window it otherwise loads in place.
        const { openOrFocusPath } = await import("./lib/windowRouting");
        await openOrFocusPath(slp);
      });
      // Component may have unmounted before the listener resolved.
      if (active) unlisten = fn;
      else fn();
    })();
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  // Check for updates on startup (Tauri only)
  useEffect(() => {
    if (!isTauri) return;
    (async () => {
      try {
        const { check } = await import("@tauri-apps/plugin-updater");
        const update = await check();
        if (update) {
          console.log(`[updater] Update available: ${update.version}`);
          const yes = window.confirm(
            `A new version of SLEAP is available (${update.version}). Download and install?`
          );
          if (yes) {
            await update.downloadAndInstall();
            const { relaunch } = await import("@tauri-apps/plugin-process");
            await relaunch();
          }
        }
      } catch (e) {
        console.warn("[updater] Update check failed:", e);
      }
    })();
  }, []);

  // Apply hash state once after project loads, then start syncing
  useEffect(() => {
    if (!projectLoaded) return;
    if (!hashApplied.current) {
      applyHashState();
      hashApplied.current = true;
    }
    return initUrlStateSync();
  }, [projectLoaded]);

  return (
    <>
      <AppShell />
      <QuitConfirmDialog />
    </>
  );
}
