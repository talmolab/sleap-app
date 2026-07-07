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
import { probeWebCodecs, readWebCodecsEnv } from "./lib/webcodecsProbe";

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

  // One-time WebCodecs capability check (cross-platform build stability). The
  // Mp4Box / MediaBunny video backends require the VideoDecoder API; the Linux
  // desktop WebView (WebKitGTK) frequently lacks it, so MP4/WebM/MKV would
  // silently decode to blank frames. Warn up front instead of per-file.
  // (Browsers and macOS/Windows desktop normally have WebCodecs → no-op.)
  useEffect(() => {
    const result = probeWebCodecs(readWebCodecsEnv());
    if (!result.supported && result.title) {
      toast.warning(result.title, {
        description: result.description,
        duration: 12000,
      });
    }
  }, []);

  const projectLoaded = useAppStore((s) => s.projectLoaded);
  const hashApplied = useRef(false);

  // Open file passed as CLI argument (Tauri only)
  useEffect(() => {
    import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<string | null>("get_initial_file"))
      .then(async (path) => {
        if (!path) {
          console.log("[app] No CLI file argument received");
          return;
        }
        console.log("[app] Loading CLI file argument:", path);
        const { readFile, exists } = await import("@tauri-apps/plugin-fs");
        await loadProjectFromPath(path, readFile, exists);
      })
      .catch((err) => {
        console.warn("[app] Failed to load CLI file argument:", err);
      });
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
