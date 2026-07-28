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

import type { Labels, LabeledFrame, Instance } from "@talmolab/sleap-io.js";
import { PredictedInstance } from "@talmolab/sleap-io.js";
import type { ActiveLearningConfig, LabelPass, PassOrder } from "./config";
import { instanceCropCenter } from "./generateCrops";
import { poseSkeletonOf } from "./centroidPairing";

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
  /**
   * True when this item came from the locator rather than a human seed — a
   * predicted pose instance (anchor-node mode) or a predicted `frame.centroids`
   * entry (separate-annotation mode). Only these can be REJECTED as a false
   * positive; a human's own seed is deleted deliberately, not rejected.
   */
  predicted: boolean;
  /**
   * Index into `frame.centroids` for the first-class centroid backing this item,
   * or null in anchor-node mode (where the anchor lives on the pose instance
   * itself). Rejecting a separate-mode item removes this centroid.
   */
  centroidIdx: number | null;
}

/** Options for {@link buildWorkList}. */
export interface BuildWorkListOptions {
  /**
   * Include items that came from the locator (default true). Turning this off
   * restricts the sweep to human-seeded centroids, for when the locator is still
   * poor enough that its detections would waste labeling effort.
   */
  includePredicted?: boolean;
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
export function buildWorkList(
  labels: Labels,
  config: ActiveLearningConfig,
  options: BuildWorkListOptions = {},
): PassItem[] {
  const includePredicted = options.includePredicted ?? true;
  // Separate centroid annotations pair each `frame.centroids` entry with a pose
  // instance; the other modes treat every instance as its own item.
  if (config.localize.separateCentroid) {
    return buildWorkListSeparate(labels, includePredicted);
  }

  const anchorNode = config.localize.centroidNode ?? undefined;
  const poseSkel = poseSkeletonOf(labels);
  const videos = labels.videos;
  const items: PassItem[] = [];
  for (const lf of sortedFrames(labels)) {
    const videoIdx = videos.indexOf(lf.video);
    if (videoIdx < 0) continue;
    const insts = lf.instances;
    for (let i = 0; i < insts.length; i++) {
      const inst = insts[i];
      // Skip instances that aren't on the pose skeleton. `sleap-nn predict
      // --centroid_output instance` writes its detections as single-node
      // instances on a DEDICATED 1-node "centroid" skeleton; a pass can't place
      // pose nodes on those, so admitting them would queue unlabelable work.
      if (poseSkel && inst.skeleton !== poseSkel) continue;
      const predicted = inst instanceof PredictedInstance;
      if (predicted && !includePredicted) continue;
      const center = instanceCropCenter(inst, inst.skeleton, anchorNode);
      if (!center) continue;
      items.push({
        videoIdx,
        frameIdx: lf.frameIdx,
        instanceIdx: i,
        centroidXY: center,
        predicted,
        centroidIdx: null,
      });
    }
  }
  return items;
}

/** Frames ordered video → frameIdx (the sweep's item order). */
function sortedFrames(labels: Labels): LabeledFrame[] {
  const videos = labels.videos;
  return [...labels.labeledFrames].sort((a, b) => {
    const va = videos.indexOf(a.video);
    const vb = videos.indexOf(b.video);
    if (va !== vb) return va - vb;
    return a.frameIdx - b.frameIdx;
  });
}

/**
 * Centroid-annotation work list: each first-class centroid annotation
 * (`frame.centroids`) pairs with a pose instance, which is the one the passes
 * label. The centroid supplies the zoom anchor only. Assumes pose instances
 * already exist to pair with (see ensurePairedPoseInstances); unpaired
 * centroids are skipped.
 *
 * Pairing is GEOMETRIC, not positional: a pose instance with placed points
 * matches its nearest centroid (greedy, ascending distance), so a pose that was
 * partially labeled in an earlier sweep stays glued to ITS animal even after
 * instances are added, deleted, or reordered. Empty pose instances carry no
 * geometry and are interchangeable — they pair with the remaining centroids in
 * frame order.
 */
function buildWorkListSeparate(labels: Labels, includePredicted: boolean): PassItem[] {
  const poseSkel = poseSkeletonOf(labels);
  if (!poseSkel) return [];

  const videos = labels.videos;
  const items: PassItem[] = [];
  for (const lf of sortedFrames(labels)) {
    const videoIdx = videos.indexOf(lf.video);
    if (videoIdx < 0) continue;

    // First-class centroid annotations on this frame (user seeds + locator
    // predictions), with a finite location. Each supplies a zoom anchor; the
    // pose instance it pairs with is what the passes label.
    const centroids: { center: [number, number]; predicted: boolean; idx: number }[] = [];
    lf.centroids.forEach((c, idx) => {
      const [x, y] = c.xy;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (c.isPredicted && !includePredicted) return;
      centroids.push({ center: [x, y], predicted: c.isPredicted, idx });
    });
    const poses: { inst: Instance; center: [number, number] | null }[] = [];
    for (const inst of lf.instances) {
      if (inst.skeleton !== poseSkel) continue;
      poses.push({ inst, center: instanceCropCenter(inst, poseSkel, undefined) });
    }
    if (centroids.length === 0 || poses.length === 0) continue;

    // Greedy nearest matching between placed poses and centroids, ascending by
    // distance (ties broken by centroid then pose order, for determinism).
    const candidates: { ci: number; pi: number; d: number }[] = [];
    for (let ci = 0; ci < centroids.length; ci++) {
      for (let pi = 0; pi < poses.length; pi++) {
        const pc = poses[pi].center;
        if (!pc) continue;
        const dx = pc[0] - centroids[ci].center[0];
        const dy = pc[1] - centroids[ci].center[1];
        candidates.push({ ci, pi, d: dx * dx + dy * dy });
      }
    }
    candidates.sort((a, b) => a.d - b.d || a.ci - b.ci || a.pi - b.pi);
    const poseForCentroid = new Array<number>(centroids.length).fill(-1);
    const centroidTaken = new Set<number>();
    const poseTaken = new Set<number>();
    for (const { ci, pi } of candidates) {
      if (centroidTaken.has(ci) || poseTaken.has(pi)) continue;
      poseForCentroid[ci] = pi;
      centroidTaken.add(ci);
      poseTaken.add(pi);
    }
    // Remaining centroids take the remaining (empty) poses in frame order.
    let nextFree = 0;
    for (let ci = 0; ci < centroids.length; ci++) {
      if (poseForCentroid[ci] >= 0) continue;
      while (nextFree < poses.length && poseTaken.has(nextFree)) nextFree++;
      if (nextFree >= poses.length) break;
      poseForCentroid[ci] = nextFree;
      poseTaken.add(nextFree);
    }

    for (let ci = 0; ci < centroids.length; ci++) {
      const pi = poseForCentroid[ci];
      if (pi < 0) continue; // more centroids than poses — skipped, as before
      items.push({
        videoIdx,
        frameIdx: lf.frameIdx,
        instanceIdx: lf.instances.indexOf(poses[pi].inst),
        centroidXY: centroids[ci].center,
        predicted: centroids[ci].predicted,
        // Index into the FULL `frame.centroids` array (not the filtered list),
        // so rejecting removes the right annotation.
        centroidIdx: centroids[ci].idx,
      });
    }
  }
  return items;
}

/**
 * Count seeded centroids for the dashboard: the annotations that would feed
 * locator training as a centroid. With separate centroid annotations only
 * user (non-predicted) `frame.centroids` count — the paired empty pose
 * instances and ordinary pose labels never do. Otherwise any user instance with
 * a usable crop center for the configured anchor counts. Predicted centroids /
 * instances never count as seeded. Also reports frames with ≥1 counted centroid.
 */
export function countSeededCentroids(
  labels: Labels,
  config: ActiveLearningConfig | null,
  options: BuildWorkListOptions = {},
): { frames: number; centroids: number } {
  // Predictions are counted only when the sweep would actually visit them, so
  // this stays in step with `buildWorkList` — the count gates the "Label
  // keypoints" button, and a count that ignored the locator would block the
  // sweep on a project whose centroids are ALL predicted.
  const includePredicted = options.includePredicted ?? false;
  const separate = config?.localize.separateCentroid ?? false;
  const anchorNode = config?.localize.centroidNode ?? undefined;
  const poseSkel = poseSkeletonOf(labels);

  let frames = 0;
  let centroids = 0;
  for (const lf of labels.labeledFrames) {
    let n = 0;
    if (separate) {
      // First-class centroid annotations: user seeds always count; the locator's
      // predictions only when the sweep is set to include them.
      for (const c of lf.centroids) {
        if (!c.isPredicted || includePredicted) n++;
      }
    } else {
      const insts = includePredicted ? lf.instances : lf.userInstances;
      for (const inst of insts) {
        // Foreign-skeleton instances (the locator's 1-node "centroid" skeleton)
        // are never labelable — mirror buildWorkList and skip them.
        if (poseSkel && inst.skeleton !== poseSkel) continue;
        if (instanceCropCenter(inst, inst.skeleton, anchorNode)) n++;
      }
    }
    if (n > 0) frames++;
    centroids += n;
  }
  return { frames, centroids };
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

/**
 * Mark every node of a pose instance as DECIDED without inventing any labels —
 * the data-level meaning of "skip this whole animal, it isn't labelable".
 *
 * Skipping an INSTANCE is a different act from skipping a NODE: pressing `s`
 * moves the cursor on and leaves the point undecided, so a resume comes straight
 * back to it. This sets the same `complete` flag every real labeling decision
 * sets (left-click places, right-click marks occluded), which is what
 * {@link nextUnlabeledCursor} reads — so the skip survives both a resume and a
 * save/reload, since `complete` is a persisted SLP point column. No separate
 * "skipped" bookkeeping, and `⌘Z` undoes it like any other edit.
 *
 * Two cases per point, so a skip never destroys existing work:
 *  - UNPLACED (no finite location) -> declined: `visible = false`, still no
 *    location. This is exactly SLEAP's encoding for "this keypoint is not
 *    labelable here", which is the honest thing to record for a bad pose.
 *  - ALREADY PLACED (a seeded anchor, an earlier pass, a prediction) -> left
 *    exactly as it is; only `complete` changes. Critical in anchor-node mode,
 *    where clearing the seeded anchor's `visible` would both destroy the
 *    locator's training label and drop the item from {@link buildWorkList}
 *    (see {@link instanceCropCenter}, which ignores non-visible points).
 *
 * Deliberately does NOT touch the centroid: the detection is still a true
 * positive the locator should keep learning from. Deleting a wrong detection is
 * `rejectCurrentPassItem`, a different action.
 *
 * @returns how many points this call newly marked decided (0 if it was already
 *   fully decided).
 */
export function markInstanceDecided(inst: Instance | PredictedInstance): number {
  let marked = 0;
  for (let i = 0; i < inst.points.length; i++) {
    const p = inst.points[i];
    if (p.complete) continue;
    const placed = Number.isFinite(p.xy[0]) && Number.isFinite(p.xy[1]);
    if (!placed) p.visible = false;
    p.complete = true;
    marked += 1;
  }
  return marked;
}

/**
 * The next cursor whose target point is NOT yet decided — searching forward from
 * `from` (exclusive), or from the very start when `from` is `null`. A point is
 * "decided" iff its `complete` flag is set: both left-click (place a visible
 * point) and right-click (mark not-visible) set `complete = true`, while freshly
 * seeded points default to `complete = false`. So this finds the first node
 * still needing a labeling decision, skipping everything already done.
 *
 * Powers (a) "resume where I left off" — pass `from = null` after re-entering the
 * mode to land on the first undecided node, skipping the pre-seeded anchor and
 * anything already labeled — and (b) skipping already-decided nodes generally.
 * Returns `null` when every remaining node is decided (the sweep is done).
 *
 * Data-aware (reads the live points), unlike the pure-index {@link advance}.
 */
export function nextUnlabeledCursor(
  labels: Labels,
  workList: PassItem[],
  dims: PassDims,
  passNodeIndices: number[][],
  from: PassCursor | null,
): PassCursor | null {
  let c = from ? advance(from, dims) : initialCursor(dims);
  while (c) {
    const item = workList[c.itemIdx];
    const inst = item ? resolveItemInstance(labels, item) : null;
    const nIdx = passNodeIndices[c.passIdx]?.[c.nodeIdx] ?? -1;
    const point =
      inst && nIdx >= 0 && nIdx < inst.points.length ? inst.points[nIdx] : null;
    if (point && !point.complete) return c;
    c = advance(c, dims);
  }
  return null;
}
