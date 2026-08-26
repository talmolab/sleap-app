import { useEffect, useRef } from "react";
import { isTauri } from "@/lib/platform";
import { pickedFromPaths, type PickedVideoFile } from "@/lib/resolveVideos";

/**
 * Desktop-only: fire `onFiles` with the supported video files dropped OVER the
 * given element in the Tauri WebView.
 *
 * The Tauri WebView never fires the HTML5 `drop` event, so we hook Tauri's own
 * window-global `onDragDropEvent` and scope it to the element by hit-testing the
 * drop position (reported in PHYSICAL pixels → divide by devicePixelRatio) against
 * the element's CSS-pixel bounding rect. Paths are filtered to supported video
 * formats and mapped to by-path {@link PickedVideoFile}s (no bytes read here).
 *
 * No-op in the browser (React's `onDrop` covers that). Coexists with the global
 * `.slp` welcome-screen drop handler in App.tsx: a dropped video isn't `.slp`, and
 * a dropped `.slp` isn't a supported video, so the two never both act on one file.
 */
export function useTauriFileDrop(
  ref: React.RefObject<HTMLElement | null>,
  onFiles: (files: PickedVideoFile[]) => void,
  onDragState?: (over: boolean) => void,
): void {
  // Keep the latest callbacks in refs so the (async) listener is registered once,
  // not re-subscribed on every render of a parent passing inline functions.
  const filesRef = useRef(onFiles);
  filesRef.current = onFiles;
  const stateRef = useRef(onDragState);
  stateRef.current = onDragState;

  useEffect(() => {
    if (!isTauri) return;
    let active = true;
    let unlisten: (() => void) | undefined;

    const overBox = (pos: { x: number; y: number }): boolean => {
      const el = ref.current;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const x = pos.x / dpr;
      const y = pos.y / dpr;
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };

    (async () => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const fn = await getCurrentWebview().onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          stateRef.current?.(overBox(p.position));
          return;
        }
        if (p.type === "leave") {
          stateRef.current?.(false);
          return;
        }
        // type === "drop"
        stateRef.current?.(false);
        if (!overBox(p.position)) return;
        const picked = pickedFromPaths(p.paths);
        if (picked.length) filesRef.current(picked);
      });
      if (active) unlisten = fn;
      else fn();
    })();

    return () => {
      active = false;
      unlisten?.();
    };
  }, [ref]);
}
