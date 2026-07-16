/**
 * Phase-2 multi-pass keypoint-labeling engine (issue #212).
 *
 * PURE + React-free + side-effect-free so it is fully unit-testable. Given the
 * project's seeded instances and the active-learning config, it produces the
 * ordered "work list" the Phase-2 sweep walks, and the cursor transitions that
 * advance/step-back through it. All data mutation (placing points, navigating
 * frames, undo snapshots) lives in the store/VideoPlayer — this module only
 * decides WHAT to label next, never touches the data model.
 *
 * Sweep order is PASS-MAJOR (the config default): for each pass in order,
 * visit every work item, and within an item place each of that pass's nodes;
 * then move to the next pass. The cursor nests pass → item → node.
 */

import type { Labels, Instance } from "@talmolab/sleap-io.js";
import type { ActiveLearningConfig, LabelPass, PassOrder } from "./config";
import { instanceCropCenter } from "./generateCrops";

/**
 * One (frame, instance) unit that every pass labels. Resolved to a live
 * `Instance` on demand via {@link resolveItemInstance} — indices survive undo
 * (which clones instances in place), a live reference would not.
 */
export interface PassItem {
  /** Index into `labels.videos`. */
  videoIdx: number;
  /** Source frame index within that video. */
  frameIdx: number;
  /**
   * Index into the frame's `instances` (ALL instances, not just user ones) —
   * the instance the passes label. Predicted centroids are included so the
   * locator scale-up path works; the placement flow adopts a predicted instance
   * as a user instance in place (same index) on first touch, so this index
   * stays valid across that conversion and across undo.
   */
  instanceIdx: number;
  /** Zoom anchor (the centroid/anchor point) in SOURCE coords. Static per item. */
  centroidXY: [number, number];
}

/** Cursor into the pass-major sweep. */
export interface PassCursor {
  /** Which pass (index into `config.labelKeypoints.passes`). */
  passIdx: number;
  /** Which work item (index into the work list). */
  itemIdx: number;
  /** Which node WITHIN the current pass (index into that pass's node list). */
  nodeIdx: number;
}

/** Fixed dimensions the cursor transitions need; computed once at enter time. */
export interface PassDims {
  /** Number of passes. */
  passCount: number;
  /** Number of work items (the same set is visited by every pass). */
  itemCount: number;
  /** Placeable node count for each pass (length === passCount). */
  nodeCountForPass: number[];
  /**
   * Sweep order. `pass-major` (default) visits every item within a pass before
   * the next pass (node → item → pass); `crop-major` finishes all passes on one
   * item before the next item (node → pass → item).
   */
  order: PassOrder;
}

/** First pass at/after `from` that has ≥1 placeable node, or -1 if none. */
function firstNonEmptyPass(nodeCountForPass: number[], from: number): number {
  let p = from;
  while (p < nodeCountForPass.length && nodeCountForPass[p] === 0) p += 1;
  return p < nodeCountForPass.length ? p : -1;
}

/** Last pass at/before `from` that has ≥1 placeable node, or -1 if none. */
function lastNonEmptyPass(nodeCountForPass: number[], from: number): number {
  let p = from;
  while (p >= 0 && nodeCountForPass[p] === 0) p -= 1;
  return p;
}

/**
 * Skeleton node indices for a pass, in click order, deduped. Pass node names
 * that aren't in the skeleton are dropped (validation surfaces them separately),
 * so a pass can legitimately end up with fewer placeable nodes than names.
 */
export function nodeIndicesForPass(pass: LabelPass, skeletonNodeNames: string[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const name of pass.nodes) {
    const i = skeletonNodeNames.indexOf(name);
    if (i >= 0 && !seen.has(i)) {
      seen.add(i);
      out.push(i);
    }
  }
  return out;
}

/**
 * Ordered work list: every instance that has a usable centroid — seeded (user)
 * AND locator-predicted — ordered by video → frame → instance. Predictions are
 * included so the "run locator → predict centroids → label them" scale-up works
 * (the placement flow adopts a touched prediction as a user instance in place).
 * The centroid is the configured anchor node when placed, else the bounding-box
 * midpoint (see {@link instanceCropCenter}), so an instance seeded with just a
 * body-center still yields a zoom anchor. Instances with no usable points are
 * skipped; `instanceIdx` indexes into the frame's full `instances` array.
 */
export function buildWorkList(labels: Labels, config: ActiveLearningConfig): PassItem[] {
  const anchorNode = config.localize.centroidNode ?? undefined;
  const videos = labels.videos;

  const frames = [...labels.labeledFrames].sort((a, b) => {
    const va = videos.indexOf(a.video);
    const vb = videos.indexOf(b.video);
    if (va !== vb) return va - vb;
    return a.frameIdx - b.frameIdx;
  });

  const items: PassItem[] = [];
  for (const lf of frames) {
    const videoIdx = videos.indexOf(lf.video);
    if (videoIdx < 0) continue;
    const insts = lf.instances;
    for (let i = 0; i < insts.length; i++) {
      const inst = insts[i];
      const center = instanceCropCenter(inst, inst.skeleton, anchorNode);
      if (!center) continue;
      items.push({ videoIdx, frameIdx: lf.frameIdx, instanceIdx: i, centroidXY: center });
    }
  }
  return items;
}

/** Fixed cursor dimensions for a config + work list against a skeleton. */
export function passDims(
  config: ActiveLearningConfig,
  workList: PassItem[],
  skeletonNodeNames: string[],
): PassDims {
  const passes = config.labelKeypoints.passes;
  return {
    passCount: passes.length,
    itemCount: workList.length,
    nodeCountForPass: passes.map((p) => nodeIndicesForPass(p, skeletonNodeNames).length),
    order: config.labelKeypoints.order,
  };
}

/**
 * The first valid cursor position, or `null` if there's nothing to label (no
 * items, or every pass has zero placeable nodes). Skips leading empty passes.
 */
export function initialCursor(dims: PassDims): PassCursor | null {
  if (dims.itemCount === 0) return null;
  let passIdx = 0;
  while (passIdx < dims.passCount && dims.nodeCountForPass[passIdx] === 0) passIdx++;
  if (passIdx >= dims.passCount) return null;
  return { passIdx, itemIdx: 0, nodeIdx: 0 };
}

/**
 * The cursor after placing/skipping the current node, or `null` when the whole
 * sweep is complete. Empty passes (zero placeable nodes) are always skipped so
 * an unmatched pass never traps the cursor. The inner→outer nesting depends on
 * `dims.order`: pass-major is node → item → pass; crop-major is node → pass →
 * item.
 */
export function advance(cursor: PassCursor, dims: PassDims): PassCursor | null {
  const { itemCount, nodeCountForPass, order } = dims;
  const { passIdx, itemIdx } = cursor;
  const nodeIdx = cursor.nodeIdx + 1;

  if (nodeIdx < nodeCountForPass[passIdx]) return { passIdx, itemIdx, nodeIdx };

  if (order === "crop-major") {
    // Finish this item's remaining passes before moving to the next item.
    const nextPass = firstNonEmptyPass(nodeCountForPass, passIdx + 1);
    if (nextPass >= 0) return { passIdx: nextPass, itemIdx, nodeIdx: 0 };
    const firstPass = firstNonEmptyPass(nodeCountForPass, 0);
    if (itemIdx + 1 < itemCount && firstPass >= 0) {
      return { passIdx: firstPass, itemIdx: itemIdx + 1, nodeIdx: 0 };
    }
    return null; // sweep complete
  }

  // pass-major: sweep every item under this pass before the next pass.
  if (itemIdx + 1 < itemCount) return { passIdx, itemIdx: itemIdx + 1, nodeIdx: 0 };
  const nextPass = firstNonEmptyPass(nodeCountForPass, passIdx + 1);
  if (nextPass < 0) return null; // sweep complete
  return { passIdx: nextPass, itemIdx: 0, nodeIdx: 0 };
}

/**
 * The cursor one step earlier, or `null` if already at the very start (no-op).
 * Exact inverse of {@link advance}, honoring `dims.order` and skipping empty
 * passes the same way.
 */
export function stepBack(cursor: PassCursor, dims: PassDims): PassCursor | null {
  const { passCount, itemCount, nodeCountForPass, order } = dims;
  const { passIdx, itemIdx } = cursor;
  const nodeIdx = cursor.nodeIdx - 1;

  if (nodeIdx >= 0) return { passIdx, itemIdx, nodeIdx };

  if (order === "crop-major") {
    const prevPass = lastNonEmptyPass(nodeCountForPass, passIdx - 1);
    if (prevPass >= 0) {
      return { passIdx: prevPass, itemIdx, nodeIdx: nodeCountForPass[prevPass] - 1 };
    }
    const lastPass = lastNonEmptyPass(nodeCountForPass, passCount - 1);
    if (itemIdx - 1 >= 0 && lastPass >= 0) {
      return { passIdx: lastPass, itemIdx: itemIdx - 1, nodeIdx: nodeCountForPass[lastPass] - 1 };
    }
    return null; // already at the start
  }

  // pass-major inverse.
  if (itemIdx - 1 >= 0) {
    return { passIdx, itemIdx: itemIdx - 1, nodeIdx: nodeCountForPass[passIdx] - 1 };
  }
  const prevPass = lastNonEmptyPass(nodeCountForPass, passIdx - 1);
  if (prevPass < 0) return null; // already at the start
  return { passIdx: prevPass, itemIdx: itemCount - 1, nodeIdx: nodeCountForPass[prevPass] - 1 };
}

/**
 * The last valid cursor position, or `null` if there's nothing to label. Used
 * to step back INTO the sweep from the completed (null-cursor) state. Skips
 * trailing empty passes.
 */
export function finalCursor(dims: PassDims): PassCursor | null {
  if (dims.itemCount === 0) return null;
  let passIdx = dims.passCount - 1;
  while (passIdx >= 0 && dims.nodeCountForPass[passIdx] === 0) passIdx -= 1;
  if (passIdx < 0) return null;
  return { passIdx, itemIdx: dims.itemCount - 1, nodeIdx: dims.nodeCountForPass[passIdx] - 1 };
}

/** Total node-placements across the whole sweep (for a progress denominator). */
export function totalSteps(dims: PassDims): number {
  return dims.nodeCountForPass.reduce((sum, n) => sum + n, 0) * dims.itemCount;
}

/**
 * Zero-based linear position of a cursor across the whole sweep (for a progress
 * numerator). Equals the number of nodes fully swept before this cursor.
 */
export function linearIndex(cursor: PassCursor, dims: PassDims): number {
  const nodesBeforePass = (upto: number): number => {
    let sum = 0;
    for (let p = 0; p < upto; p++) sum += dims.nodeCountForPass[p];
    return sum;
  };

  if (dims.order === "crop-major") {
    // Items fully swept, plus passes done on the current item, plus current node.
    const perItem = nodesBeforePass(dims.passCount);
    return cursor.itemIdx * perItem + nodesBeforePass(cursor.passIdx) + cursor.nodeIdx;
  }

  // pass-major: whole passes done, plus items done in this pass, plus this node.
  return (
    nodesBeforePass(cursor.passIdx) * dims.itemCount +
    cursor.itemIdx * dims.nodeCountForPass[cursor.passIdx] +
    cursor.nodeIdx
  );
}

/**
 * Resolve a work item to its live pose `Instance`, or `null` if the frame or
 * instance no longer exists. Resolves by index every time so it survives undo.
 */
export function resolveItemInstance(labels: Labels, item: PassItem): Instance | null {
  const video = labels.videos[item.videoIdx];
  if (!video) return null;
  const frames = labels.find({ video, frameIdx: item.frameIdx });
  if (frames.length === 0) return null;
  return frames[0].instances[item.instanceIdx] ?? null;
}
