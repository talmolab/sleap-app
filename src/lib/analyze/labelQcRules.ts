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
  reason: "iou" | "node_overlap" | "split_duplicate";
}

export interface DuplicateOptions {
  iouThreshold?: number;
  nodeDistanceThreshold?: number;
  nodeOverlapRatio?: number;
  /** Combined split-duplicate cutoff (Tier 3). Default 0.5. */
  splitScoreThreshold?: number;
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
  const splitThreshold = opts.splitScoreThreshold ?? 0.5;
  const out: DuplicatePair[] = [];
  for (let i = 0; i < instances.length; i++) {
    for (let j = i + 1; j < instances.length; j++) {
      const iou = instanceIoU(instances[i], instances[j]);
      const ov = nodeOverlap(instances[i], instances[j], distanceThreshold);
      if (iou > iouThreshold) {
        out.push({ indexA: i, indexB: j, iou, overlapRatio: ov.overlapRatio, reason: "iou" });
      } else if (ov.commonNodes >= 2 && ov.overlapRatio > ratioThreshold) {
        out.push({ indexA: i, indexB: j, iou, overlapRatio: ov.overlapRatio, reason: "node_overlap" });
      } else if (splitDuplicateScore(instances[i], instances[j]) >= splitThreshold) {
        // One animal split across two instances on disjoint-but-contiguous nodes
        // (the complementary case IoU + node-overlap miss).
        out.push({ indexA: i, indexB: j, iou, overlapRatio: ov.overlapRatio, reason: "split_duplicate" });
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

// ── Split-duplicate (Tier 3, features/duplicate_split.py) ────────────────────
// One animal split across two instances labeled on largely disjoint node sets —
// the complementary case bbox-IoU and node-overlap miss. All distances are
// normalized by a length scale (bbox diagonal of the larger instance, since we
// don't fit dataset edge stats app-side), so a single cutoff works.

const _DISJOINT_MIN = 0.55;
const _DISJOINT_FULL = 0.85;
const _GAP_TOL = 2.5;
const _COHERENCE_OK = 1.5;
const _COHERENCE_MAX = 3.0;
const _SPLIT_MIN_VISIBLE = 2;

/** Linear ramp: 0 at `lo` → 1 at `hi` (clamped); works for lo<hi and lo>hi. */
function linearScore(value: number, lo: number, hi: number): number {
  if (hi === lo) return value >= hi ? 1 : 0;
  return Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
}

function bboxDiagonal(points: number[][]): number {
  const vis = points.filter(isVisible);
  if (vis.length < 2) return 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of vis) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return Math.hypot(maxX - minX, maxY - minY);
}

function nearestNodeDistance(a: number[][], b: number[][]): number {
  const va = a.filter(isVisible);
  const vb = b.filter(isVisible);
  let min = Infinity;
  for (const pa of va) {
    for (const pb of vb) {
      const d = Math.hypot(pa[0] - pb[0], pa[1] - pb[1]);
      if (d < min) min = d;
    }
  }
  return min;
}

/** Median nearest-neighbor spacing among an instance's own visible nodes (NaN if <2). */
function internalSpacing(points: number[][]): number {
  const vis = points.filter(isVisible);
  if (vis.length < 2) return NaN;
  const mins: number[] = [];
  for (let i = 0; i < vis.length; i++) {
    let m = Infinity;
    for (let j = 0; j < vis.length; j++) {
      if (i === j) continue;
      const d = Math.hypot(vis[i][0] - vis[j][0], vis[i][1] - vis[j][1]);
      if (d < m) m = d;
    }
    mins.push(m);
  }
  return medianCount(mins);
}

/**
 * Score (0-1) that two instances are one animal split across both: largely
 * disjoint visible-node sets (`0.55→0.85`), touching at the body (nearest-node
 * gap `2.5→0` scale units), and coherent (gap `3.0→1.5` internal spacings).
 * Mirrors `compute_split_duplicate` with the bbox-diagonal scale fallback.
 */
export function splitDuplicateScore(a: number[][], b: number[][]): number {
  const va = a.map(isVisible);
  const vb = b.map(isVisible);
  const na = va.filter(Boolean).length;
  const nb = vb.filter(Boolean).length;
  if (na < _SPLIT_MIN_VISIBLE || nb < _SPLIT_MIN_VISIBLE) return 0;
  const n = Math.max(va.length, vb.length);
  let union = 0;
  for (let i = 0; i < n; i++) if (va[i] || vb[i]) union++;
  if (union < _SPLIT_MIN_VISIBLE) return 0;

  const diag = Math.max(bboxDiagonal(a), bboxDiagonal(b));
  const scale = diag > 1e-8 ? diag : 1;

  const disjointness = union / (na + nb);
  const sDisjoint = linearScore(disjointness, _DISJOINT_MIN, _DISJOINT_FULL);
  if (sDisjoint <= 0) return 0;

  const gap = nearestNodeDistance(a, b);
  const sGap = linearScore(gap / scale, _GAP_TOL, 0);
  if (sGap <= 0) return 0;

  const spacings = [internalSpacing(a), internalSpacing(b)].filter(
    (s) => Number.isFinite(s) && s > 1e-8,
  );
  let sCoherent = 1;
  if (spacings.length) {
    const rel = gap / (spacings.reduce((x, y) => x + y, 0) / spacings.length);
    sCoherent = linearScore(rel, _COHERENCE_MAX, _COHERENCE_OK);
  }

  return sDisjoint * sGap * sCoherent;
}
