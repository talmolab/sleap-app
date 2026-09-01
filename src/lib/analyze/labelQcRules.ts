/**
 * Pure rule-based Label QC checks (Analyze menu, Tier 2). Operates only on plain
 * points arrays (rows `[x, y]` from `Instance.numpy()`, NaN = invisible) and
 * counts — no sleap-io objects — so it is trivially unit-testable. The facade
 * (labelQc.ts) walks a `Labels` object and applies these.
 *
 * Ported from the SLEAP fork `sleap/qc/frame_level.py` (IoU / node-overlap /
 * duplicate detection, negative-frame, InstanceCountChecker) plus the plan's
 * instance-level rules (sparse / empty / out-of-range). The split-duplicate
 * geometric signal is deferred to Tier 3.
 */

function isVisible(p: number[]): boolean {
  return Number.isFinite(p[0]) && Number.isFinite(p[1]);
}

function bounds(rows: number[][]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of rows) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

/** IoU of two instances' visible-point bounding boxes; 0 if either has <2 visible points. */
export function instanceIoU(a: number[][], b: number[][]): number {
  const va = a.filter(isVisible);
  const vb = b.filter(isVisible);
  if (va.length < 2 || vb.length < 2) return 0;
  const [ax0, ay0, ax1, ay1] = bounds(va);
  const [bx0, by0, bx1, by1] = bounds(vb);
  const iw = Math.max(0, Math.min(ax1, bx1) - Math.max(ax0, bx0));
  const ih = Math.max(0, Math.min(ay1, by1) - Math.max(ay0, by0));
  const inter = iw * ih;
  const union = (ax1 - ax0) * (ay1 - ay0) + (bx1 - bx0) * (by1 - by0) - inter;
  return union > 0 ? inter / union : 0;
}

export interface NodeOverlap {
  commonNodes: number;
  overlappingNodes: number;
  overlapRatio: number;
  minDistance: number;
}

/** Node-wise overlap of two instances at commonly-visible nodes. */
export function nodeOverlap(a: number[][], b: number[][], distanceThreshold = 10): NodeOverlap {
  const n = Math.min(a.length, b.length);
  let common = 0;
  let overlapping = 0;
  let minDistance = Infinity;
  for (let i = 0; i < n; i++) {
    if (!isVisible(a[i]) || !isVisible(b[i])) continue;
    common++;
    const d = Math.hypot(a[i][0] - b[i][0], a[i][1] - b[i][1]);
    if (d < minDistance) minDistance = d;
    if (d < distanceThreshold) overlapping++;
  }
  return {
    commonNodes: common,
    overlappingNodes: overlapping,
    overlapRatio: common > 0 ? overlapping / common : 0,
    minDistance: common > 0 ? minDistance : Infinity,
  };
}

export interface DuplicatePair {
  indexA: number;
  indexB: number;
  iou: number;
  overlapRatio: number;
  reason: "iou" | "node_overlap";
}

export interface DuplicateOptions {
  iouThreshold?: number;
  nodeDistanceThreshold?: number;
  nodeOverlapRatio?: number;
}

/**
 * Duplicate instance pairs in a frame. A pair is flagged when bbox IoU exceeds
 * `iouThreshold`, or (below that) when ≥2 commonly-visible nodes overlap with
 * `overlapRatio > nodeOverlapRatio`. Mirrors `detect_duplicates` (sans the
 * Tier-3 split-duplicate signal).
 */
export function detectDuplicates(
  instances: number[][][],
  opts: DuplicateOptions = {},
): DuplicatePair[] {
  const iouThreshold = opts.iouThreshold ?? 0.5;
  const distanceThreshold = opts.nodeDistanceThreshold ?? 10;
  const ratioThreshold = opts.nodeOverlapRatio ?? 0.8;
  const out: DuplicatePair[] = [];
  for (let i = 0; i < instances.length; i++) {
    for (let j = i + 1; j < instances.length; j++) {
      const iou = instanceIoU(instances[i], instances[j]);
      const ov = nodeOverlap(instances[i], instances[j], distanceThreshold);
      if (iou > iouThreshold) {
        out.push({ indexA: i, indexB: j, iou, overlapRatio: ov.overlapRatio, reason: "iou" });
      } else if (ov.commonNodes >= 2 && ov.overlapRatio > ratioThreshold) {
        out.push({ indexA: i, indexB: j, iou, overlapRatio: ov.overlapRatio, reason: "node_overlap" });
      }
    }
  }
  return out;
}

/** A negative (background) frame that inconsistently still carries instances. */
export function isNegativeFrameWithInstances(isNegative: boolean, instanceCount: number): boolean {
  return Boolean(isNegative) && instanceCount > 0;
}

/** Median of a list of per-frame instance counts (NaN for empty input). */
export function medianCount(counts: number[]): number {
  const v = counts.filter(Number.isFinite).sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return NaN;
  const mid = Math.floor(n / 2);
  return n % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** A frame has fewer instances than its (per-video) expected median. */
export function isIncompleteFrame(instanceCount: number, expected: number): boolean {
  return instanceCount < expected;
}

/** Number of visible (finite-coordinate) nodes in an instance. */
export function visibleNodeCount(points: number[][]): number {
  let c = 0;
  for (const p of points) if (isVisible(p)) c++;
  return c;
}

/** An instance with fewer than `minVisible` visible nodes. */
export function isSparseInstance(points: number[][], minVisible = 2): boolean {
  return visibleNodeCount(points) < minVisible;
}

/** An instance with no visible points at all (all-NaN / missing). */
export function isEmptyInstance(points: number[][]): boolean {
  return visibleNodeCount(points) === 0;
}

/** Whether any visible point lies outside the frame bounds `[0,width] x [0,height]`. */
export function hasOutOfRangePoints(points: number[][], width: number, height: number): boolean {
  for (const p of points) {
    if (!isVisible(p)) continue;
    if (p[0] < 0 || p[0] > width || p[1] < 0 || p[1] > height) return true;
  }
  return false;
}
