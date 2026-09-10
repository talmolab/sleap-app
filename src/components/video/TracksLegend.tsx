/**
 * Tracks legend overlay component.
 *
 * Shows a semi-transparent overlay listing all tracks with their
 * number (1-N), color swatch, and name when the Ctrl key is held.
 * Used during proofreading to quickly see track-to-number mappings
 * for Ctrl+1-9 track assignment.
 */

import { useEffect, useState } from "react";
import { useAppStore } from "../../stores/appStore";
import { getTrackColor, rgbToCSS } from "../../lib/colorPalettes";
import { getActiveTrackOverrides } from "../../lib/trackColorOverrides";

export function TracksLegend() {
  const [ctrlHeld, setCtrlHeld] = useState(false);
  const labels = useAppStore((s) => s.labels);
  const palette = useAppStore((s) => s.palette);
  const overrides = useAppStore((s) =>
    getActiveTrackOverrides(s.trackColorOverrides, s.projectPath, s.filename),
  );

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Control") setCtrlHeld(true);
    };
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === "Control") setCtrlHeld(false);
    };
    // Also hide on window blur (user switches away while holding Ctrl)
    const handleBlur = () => setCtrlHeld(false);

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  if (!ctrlHeld || !labels || labels.tracks.length === 0) return null;

  return (
    <div
      className="absolute top-2 right-2 z-50 rounded-md bg-black/80 px-3 py-2 text-xs text-white shadow-lg backdrop-blur-sm"
      style={{ pointerEvents: "none" }}
    >
      <div className="mb-1 font-semibold text-white/70">Tracks</div>
      {labels.tracks.map((track, i) => {
        const color = getTrackColor(palette, i, track.name, overrides);
        return (
          <div key={i} className="flex items-center gap-2 py-0.5">
            <span className="w-4 text-right font-mono text-white/60">
              {i + 1}
            </span>
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ backgroundColor: rgbToCSS(color) }}
            />
            <span className="text-white/90">{track.name}</span>
          </div>
        );
      })}
    </div>
  );
}
