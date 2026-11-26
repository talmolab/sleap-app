/**
 * Boxes around poses: the tight box around each instance's visible points,
 * padded. Shared by View ▸ Show Boxes Around Poses (drawn, never saved) and the
 * Boxes from Poses command (saved as user boxes).
 *
 * The rules match sleap-nn's `_derived_frame_bboxes` (`sleap_nn/data/bboxes.py`,
 * v0.3.5), which builds a box detector's training boxes from user poses when
 * `data_config.bbox_source` resolves to `instances`:
 *  - `Instance.to_bbox(mode="tight", padding=bbox_padding)` over the visible,
 *    non-NaN points;
 *  - an instance with no visible points is skipped;
 *  - a box with zero width or height (one visible point and no padding) is
 *    skipped.
 * sleap-nn requires `bbox_padding >= 0`, so padding is clamped to 0.
 */
import {
  PredictedInstance,
  type BoundingBox,
  type Instance,
  type LabeledFrame,
} from "@talmolab/sleap-io.js";

export interface PoseBbox {
  instance: Instance;
  /** A `UserBoundingBox` for a user instance, a `PredictedBoundingBox` for a prediction; linked to `instance`. */
  box: BoundingBox;
}

export interface DerivePoseBboxOptions {
  /** Pixels added on every side. Clamped to ≥ 0, as sleap-nn requires. */
  padding: number;
  /** Also box predicted instances. sleap-nn's training boxes come from user instances only. */
  includePredicted?: boolean;
}

/** Padding as sleap-nn accepts it: a finite number ≥ 0. */
export function normalizeBboxPadding(padding: unknown): number {
  const n = Number(padding);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The box around each instance on `lf` that has no stored box of its own:
 * a user instance with a linked user box, or a prediction with any linked box,
 * is skipped (its stored box already says where it is).
 */
export function derivePoseBboxes(lf: LabeledFrame, opts: DerivePoseBboxOptions): PoseBbox[] {
  const padding = normalizeBboxPadding(opts.padding);
  const userBoxed = new Set<unknown>();
  const anyBoxed = new Set<unknown>();
  for (const b of lf.bboxes) {
    if (!b.instance) continue;
    anyBoxed.add(b.instance);
    if (!b.isPredicted) userBoxed.add(b.instance);
  }
  const out: PoseBbox[] = [];
  for (const instance of lf.instances) {
    const predicted = instance instanceof PredictedInstance;
    if (predicted ? !opts.includePredicted || anyBoxed.has(instance) : userBoxed.has(instance)) continue;
    if (instance.isEmpty) continue;
    const box = instance.toBbox({ mode: "tight", padding });
    if (box.isEmpty || !(box.width > 0) || !(box.height > 0)) continue;
    out.push({ instance, box });
  }
  return out;
}

/** How well a project's drawn boxes cover its labeled poses, for a box detector's training data. */
export interface DrawnBoxCoverage {
  /** The project has at least one usable drawn (user) box, so sleap-nn's `auto` source trains on drawn boxes only. */
  hasDrawnBoxes: boolean;
  /** Frames with user poses but no drawn box: left out of detector training. */
  posesWithoutBoxes: number;
  /** Frames with drawn boxes but fewer boxes than user poses: the animals without one count as background. */
  partlyBoxed: number;
}

/**
 * Coverage of drawn boxes over user poses. Counts the way sleap-nn does
 * (`frame_user_bboxes`): only user boxes with width and height > 0, and only
 * user instances with a visible point.
 */
export function drawnBoxCoverage(labels: { labeledFrames: readonly LabeledFrame[] }): DrawnBoxCoverage {
  let hasDrawnBoxes = false;
  let posesWithoutBoxes = 0;
  let partlyBoxed = 0;
  for (const lf of labels.labeledFrames) {
    const boxes = lf.bboxes.filter((b) => !b.isPredicted && !b.isEmpty && b.width > 0 && b.height > 0).length;
    const poses = lf.instances.filter((i) => !(i instanceof PredictedInstance) && !i.isEmpty).length;
    if (boxes > 0) hasDrawnBoxes = true;
    if (poses > 0 && boxes === 0) posesWithoutBoxes++;
    else if (boxes > 0 && boxes < poses) partlyBoxed++;
  }
  return { hasDrawnBoxes, posesWithoutBoxes, partlyBoxed };
}
