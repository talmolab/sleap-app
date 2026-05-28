import { useEffect, useRef } from "react";
import { AppShell } from "./components/layout/AppShell";
import { QuitConfirmDialog } from "./components/dialogs/QuitConfirmDialog";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useAppStore } from "./stores/appStore";
import { applyHashState, initUrlStateSync } from "./lib/urlState";
import { loadProjectFromPath } from "./lib/loadProject";
import { isTauri } from "./platform";
import { setupCloseHandler } from "./lib/quit";

export default function App() {
  useKeyboardShortcuts();

  useEffect(() => {
    setupCloseHandler();
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
