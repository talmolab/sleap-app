/**
 * Keeps the window/tab title in sync with the open project, mirroring PyQt
 * SLEAP's MainWindow.setWindowTitle ("{filename} - SLEAP v{version}").
 *
 * - Browser: sets document.title (tab title; no native title bar exists).
 * - Tauri: also calls getCurrentWindow().setTitle (native title bar). This
 *   requires the `core:window:allow-set-title` capability (see
 *   src-tauri/capabilities/default.json).
 *
 * The app version comes from @/lib/version (the Vite-injected
 * `__APP_VERSION__`, stamped per build by CI), shared with the About dialog
 * and the web menu-bar wordmark so all three can never disagree.
 */
import { useEffect } from "react";
import { useAppStore } from "@/stores/appStore";
import { isTauri } from "@/lib/platform";
import { APP_VERSION } from "@/lib/version";

// Memoized dynamic import of the Tauri window API. The setTitle effect re-runs
// on every filename/hasChanges change; caching the import promise avoids
// re-invoking import() each time (the module itself is stable).
let windowApiPromise: Promise<
  typeof import("@tauri-apps/api/window")
> | null = null;
function loadTauriWindowApi() {
  if (!windowApiPromise) windowApiPromise = import("@tauri-apps/api/window");
  return windowApiPromise;
}

/** Pure title formatter (unit-tested). */
export function formatWindowTitle(
  filename: string | null,
  hasChanges: boolean,
  version: string,
): string {
  const suffix = `SLEAP v${version}`;
  if (!filename) return suffix;
  return `${filename}${hasChanges ? " *" : ""} - ${suffix}`;
}

/** Effect hook: sync document.title and (in Tauri) the native window title. */
export function useWindowTitle(): void {
  const filename = useAppStore((s) => s.filename);
  const hasChanges = useAppStore((s) => s.hasChanges);

  useEffect(() => {
    const title = formatWindowTitle(filename, hasChanges, APP_VERSION);
    document.title = title;
    if (isTauri) {
      loadTauriWindowApi()
        .then(({ getCurrentWindow }) => getCurrentWindow().setTitle(title))
        .catch((err) => {
          console.warn("[title] setTitle failed:", err);
        });
    }
  }, [filename, hasChanges]);
}
