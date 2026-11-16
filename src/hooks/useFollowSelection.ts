/**
 * View ▸ Fit View to Selection (toggle, PyQt `fit_selection`).
 *
 * PyQt zooms to the selection only when it redraws a frame (`plotFrame`), so
 * this does the same: it fits when the toggle is turned on and each time the
 * frame changes, never when the selection changes on the current frame. That
 * keeps a mousedown on a node (which selects its instance) from zooming in the
 * middle of a drag.
 *
 * Moving to another frame clears the selection, so on the new frame it fits
 * the instance on the last selected instance's track (zoom only; nothing gets
 * selected). If something is selected on the new frame (e.g. Label QC's
 * "go to flag"), that wins.
 */
import { useEffect, useRef } from "react";
import type { RenderedInstance } from "@/canvas/SkeletonRenderer";

export interface FollowSelectionInputs {
  /** The toggle. */
  followSelection: boolean;
  /** The selected instance's track name, or null (nothing selected / untracked). */
  selectedTrackName: string | null;
  /** Whether an instance is selected at all. */
  hasSelection: boolean;
  /** The current frame: any identity that changes when the frame does. */
  frame: unknown;
  /** The current frame's drawn instances (`isSelected` marks the selection). */
  renderedInstances: RenderedInstance[];
  /** Fit the view to these instance's visible nodes. */
  onFit: (instance: RenderedInstance) => void;
}

/** Which drawn instance to fit: the selected one, else one on `trackName` (user before predicted). */
export function followTarget(
  rendered: RenderedInstance[],
  trackName: string | null,
): RenderedInstance | null {
  const selected = rendered.find((ri) => ri.isSelected);
  if (selected) return selected;
  if (!trackName) return null;
  const sameTrack = rendered.filter((ri) => ri.trackName === trackName);
  return sameTrack.find((ri) => !ri.isPredicted) ?? sameTrack[0] ?? null;
}

export function useFollowSelection({
  followSelection,
  selectedTrackName,
  hasSelection,
  frame,
  renderedInstances,
  onFit,
}: FollowSelectionInputs): void {
  // Latest values, read when the frame changes without making them triggers.
  const latest = useRef({ renderedInstances, onFit });
  latest.current = { renderedInstances, onFit };

  // Remember which track to follow. Selecting doesn't zoom by itself.
  const trackRef = useRef<string | null>(null);
  useEffect(() => {
    if (hasSelection) trackRef.current = selectedTrackName;
  }, [hasSelection, selectedTrackName]);

  useEffect(() => {
    if (!followSelection) return;
    const target = followTarget(latest.current.renderedInstances, trackRef.current);
    if (target) latest.current.onFit(target);
  }, [followSelection, frame]);
}
