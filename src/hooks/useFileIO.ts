/**
 * Hook for file I/O operations (open/save SLP files).
 *
 * Uses the platform abstraction layer to work in both Tauri and browser.
 */

import { useCallback, useState } from "react";
import { getPlatform } from "../platform";
import { loadProjectFromFile } from "../lib/loadProject";

export function useFileIO() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openProject = useCallback(async () => {
    setError(null);
    const platform = await getPlatform();

    const result = await platform.showOpenDialog({
      filters: [{ name: "SLEAP Labels", extensions: ["slp"] }],
      excludeAcceptAll: true,
    });

    if (!result) return; // User cancelled

    setLoading(true);
    try {
      if (typeof result === "string") {
        // Desktop path: route through the window gate (focus existing window /
        // load into an empty one / spawn a new window) so an open never
        // clobbers a loaded project and the same file never opens twice.
        const { openOrFocusPath } = await import("../lib/windowRouting");
        await openOrFocusPath(result);
      } else if (result instanceof File) {
        // Browser File object
        await loadProjectFromFile(result);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      console.error("Failed to open project:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  const openFromDrop = useCallback(async (file: File) => {
    setError(null);
    setLoading(true);
    try {
      await loadProjectFromFile(file);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      console.error("Failed to load dropped file:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  return { openProject, openFromDrop, loading, error };
}
