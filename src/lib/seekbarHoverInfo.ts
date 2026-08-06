/**
 * Pure formatter for the seekbar hover-preview tooltip.
 *
 * Mirrors PyQt SLEAP's `get_val_tooltip` (sleap/gui/widgets/slider.py:1264-1300).
 * Given the LabeledFrame under the cursor (or `null` if none) and whether that
 * frame is a video suggestion, it produces the tooltip lines:
 *
 *   Frame {frameIdx + 1}          — 1-based, exactly like PyQt
 *   <semantic line>               — one line describing the frame's mark
 *   {n} predicted instance(s)     — only when > 0 (PyQt lists predicted first)
 *   {n} user instance(s)          — only when > 0
 *
 * The semantic line reproduces PyQt's mark-priority. PyQt assigns each frame at
 * most one "simple" mark (priority: negative > suggested > user > prediction-
 * without-track) plus, independently, a "track" mark when an instance carries a
 * track identity; the tooltip then reports the highest-priority mark present.
 * Because at most one simple mark exists per frame, that reduces to the ordered
 * checks below, with the track mark as the final fallback.
 *
 * Keeping this a pure function (no React, no DOM, no store) makes the semantics
 * unit-testable and keeps the Seekbar wiring thin.
 */
import type { LabeledFrame } from "@talmolab/sleap-io.js";

/** The subset of a LabeledFrame the formatter reads. Real frames satisfy it. */
type HoverFrame = Pick<
  LabeledFrame,
  "isNegative" | "userInstances" | "predictedInstances" | "instances"
>;

export interface FrameHoverInfoOptions {
  /** Whether this frame appears in the current video's suggestion list. */
  isSuggested?: boolean;
}

export interface FrameHoverInfo {
  /** Tooltip lines, top to bottom (already 1-based, PyQt-worded). */
  lines: string[];
}

/**
 * Build the hover-tooltip lines for `frameIdx`.
 *
 * @param lf The LabeledFrame at this frame, or `null` if none exists.
 * @param frameIdx 0-based frame index (rendered 1-based in the header line).
 * @param options `isSuggested` marks the frame as a video suggestion.
 */
export function frameHoverInfo(
  lf: HoverFrame | null,
  frameIdx: number,
  options: FrameHoverInfoOptions = {},
): FrameHoverInfo {
  const lines: string[] = [`Frame ${frameIdx + 1}`];

  const isSuggested = options.isSuggested ?? false;
  const userCount = lf ? lf.userInstances.length : 0;
  const predCount = lf ? lf.predictedInstances.length : 0;

  const semantic = semanticLine({
    isNegative: lf?.isNegative ?? false,
    isSuggested,
    hasUser: userCount > 0,
    // PyQt's `labeled_marks` membership: an lf exists for this frame at all.
    hasLabeledFrame: lf !== null,
    hasUntracked: lf ? lf.instances.some((inst) => inst.track == null) : false,
    hasTracked: lf ? lf.instances.some((inst) => inst.track != null) : false,
  });
  if (semantic) lines.push(semantic);

  // PyQt appends the predicted count before the user count.
  if (predCount > 0) {
    lines.push(`${predCount} predicted instance${predCount > 1 ? "s" : ""}`);
  }
  if (userCount > 0) {
    lines.push(`${userCount} user instance${userCount > 1 ? "s" : ""}`);
  }

  return { lines };
}

/** The single semantic descriptor for a frame, or `null` for a bare frame. */
function semanticLine(s: {
  isNegative: boolean;
  isSuggested: boolean;
  hasUser: boolean;
  hasLabeledFrame: boolean;
  hasUntracked: boolean;
  hasTracked: boolean;
}): string | null {
  // Negative frames take priority in both PyQt's mark loop and its tooltip.
  if (s.isNegative) return "negative (background) frame";

  // A suggested frame gets exactly one suggested-* mark (never a plain user /
  // prediction mark), so it must be resolved before those.
  if (s.isSuggested) {
    if (s.hasUser) return "suggested frame with user labels";
    if (s.hasLabeledFrame) return "suggested frame with prediction";
    return "suggested frame (no labels)";
  }

  if (s.hasUser) return "user labeled";
  if (s.hasUntracked) return "prediction without track identity";
  if (s.hasTracked) return "prediction with track identity";
  return null;
}
