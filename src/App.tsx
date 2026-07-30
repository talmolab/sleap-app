import { useEffect, useRef } from "react";
import { AppShell } from "./components/layout/AppShell";
import { QuitConfirmDialog } from "./components/dialogs/QuitConfirmDialog";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useWindowTitle } from "./hooks/useWindowTitle";
import { useAppStore } from "./stores/appStore";
import { applyHashState, initUrlStateSync } from "./lib/urlState";
import { loadProjectFromPath } from "./lib/loadProject";
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

// Consume the pending "initial file" slot in Rust and load it. The slot is
// populated either from a CLI argument on launch or from a macOS file-association
// open (RunEvent::Opened). get_initial_file take()s the slot, so calling this
// from both the launch poll and the `open-file` listener is race-safe: whoever
// runs first loads the file, the other gets null and no-ops (no double-load).
async function loadInitialFileIfAny() {
  const { invoke } = await import("@tauri-apps/api/core");
  // Prefixed for the inlined `sleap` plugin so it resolves from the
  // http://localhost origin (bundled builds) as well as the dev origin.
  const path = await invoke<string | null>(sleapCmd("get_initial_file"));
  if (!path) return;
  console.log("[app] Loading initial file:", path);
  const { readFile, exists } = await import("@tauri-apps/plugin-fs");
  await loadProjectFromPath(path, readFile, exists);
}

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

      if (nativeH264DecodableSync() === false) {
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

  // Open a file passed on launch — a CLI argument, or a macOS file-association
  // open that fired before the webview was ready (Tauri only). Crash-recovery
  // drafts are NOT auto-restored here — the WelcomeScreen "Restore unsaved work?"
  // card surfaces them for both runtimes (see recoverableDrafts.ts), so recovery
  // is a user click (never a racy auto-prompt) and is trivially escapable.
  useEffect(() => {
    if (!isTauri) return;
    (async () => {
      await loadInitialFileIfAny().catch((err) => {
        console.warn("[app] Failed to load initial file:", err);
      });
    })();
  }, []);

  // macOS file-association / "Open With" opens while the app is already running
  // (or that land after the launch poll above). Finder delivers these as an Apple
  // Event, which Rust forwards as an `open-file` event; we then drain the same
  // initial-file slot. Reuses loadProjectFromPath, so it inherits the
  // unsaved-changes confirm and works on the welcome screen or in the editor.
  useEffect(() => {
    if (!isTauri) return;
    let active = true;
    let unlisten: (() => void) | undefined;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const fn = await listen("open-file", () => {
        loadInitialFileIfAny().catch((err) => {
          console.warn("[app] Failed to load opened file:", err);
        });
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
        const { readFile, exists } = await import("@tauri-apps/plugin-fs");
        await loadProjectFromPath(slp, readFile, exists);
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
