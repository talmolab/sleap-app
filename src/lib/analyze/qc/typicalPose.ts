/**
 * The "typical pose" for Label QC Review: the typical shape of the project's user
 * poses (generalized Procrustes: each pose rotated, scaled and shifted onto a
 * running per-node median), which Review fits onto the selected instance so a misplaced
 * or swapped node shows up against where it usually sits.
 *
 * Poses are `[node][x, y]` arrays with NaN for nodes that aren't placed or
 * visible. Rotation-only (no reflection), so a left/right swap still looks wrong.
 * Each node's typical spot is the median of the aligned poses, not the mean,
 * so the few mislabeled poses QC is looking for don't pull it toward them.
 */

export type Pose = number[][];

/** dst ≈ s·R·src + t, with `a = s·cosθ`, `b = s·sinθ`. */
export interface Similarity {
  a: number;
  b: number;
  tx: number;
  ty: number;
}

const finite = (p: number[] | undefined): p is number[] =>
  !!p && Number.isFinite(p[0]) && Number.isFinite(p[1]);

/**
 * Least-squares similarity transform taking `src` onto `dst`, over the nodes
 * both have. Null with fewer than 2 shared nodes or a degenerate `src`.
 */
export function fitSimilarity(src: Pose, dst: Pose): Similarity | null {
  const idx: number[] = [];
  for (let i = 0; i < Math.min(src.length, dst.length); i++) {
    if (finite(src[i]) && finite(dst[i])) idx.push(i);
  }
  if (idx.length < 2) return null;
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (const i of idx) {
    sx += src[i][0];
    sy += src[i][1];
    dx += dst[i][0];
    dy += dst[i][1];
  }
  const n = idx.length;
  sx /= n; sy /= n; dx /= n; dy /= n;
  let num = 0, numB = 0, den = 0;
  for (const i of idx) {
    const px = src[i][0] - sx;
    const py = src[i][1] - sy;
    const qx = dst[i][0] - dx;
    const qy = dst[i][1] - dy;
    num += px * qx + py * qy;
    numB += px * qy - py * qx;
    den += px * px + py * py;
  }
  if (!(den > 1e-12)) return null;
  const a = num / den;
  const b = numB / den;
  return { a, b, tx: dx - (a * sx - b * sy), ty: dy - (b * sx + a * sy) };
}

export function applySimilarity(t: Similarity, pose: Pose): Pose {
  return pose.map((p) =>
    finite(p) ? [t.a * p[0] - t.b * p[1] + t.tx, t.b * p[0] + t.a * p[1] + t.ty] : [NaN, NaN],
  );
}

/** Centre on the placed nodes and scale to unit RMS radius. Null if degenerate. */
function normalize(pose: Pose): Pose | null {
  const pts = pose.filter(finite);
  if (pts.length < 2) return null;
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const rms = Math.sqrt(pts.reduce((s, p) => s + (p[0] - cx) ** 2 + (p[1] - cy) ** 2, 0) / pts.length);
  if (!(rms > 1e-12)) return null;
  return pose.map((p) => (finite(p) ? [(p[0] - cx) / rms, (p[1] - cy) / rms] : [NaN, NaN]));
}

const placedCount = (p: Pose) => p.filter(finite).length;

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Typical shape of `poses` (normalized: centred, unit RMS radius). Poses with
 * fewer than 3 placed nodes are skipped; a node no pose has stays NaN. Null
 * when no usable pose. Large projects are subsampled evenly to `maxPoses`.
 */
export function typicalPose(
  poses: readonly Pose[],
  { maxPoses = 500, iterations = 4 }: { maxPoses?: number; iterations?: number } = {},
): Pose | null {
  let usable = poses.filter((p) => placedCount(p) >= 3);
  if (usable.length === 0) return null;
  if (usable.length > maxPoses) {
    const step = usable.length / maxPoses;
    usable = Array.from({ length: maxPoses }, (_, i) => usable[Math.floor(i * step)]);
  }
  const nNodes = Math.max(...usable.map((p) => p.length));
  // Start from the most complete pose, so the first alignment has the most anchors.
  let ref = normalize(usable.reduce((best, p) => (placedCount(p) > placedCount(best) ? p : best)));
  if (!ref) return null;

  for (let it = 0; it < iterations; it++) {
    const xs: number[][] = Array.from({ length: nNodes }, () => []);
    const ys: number[][] = Array.from({ length: nNodes }, () => []);
    for (const pose of usable) {
      const t = fitSimilarity(pose, ref);
      if (!t) continue;
      applySimilarity(t, pose).forEach((p, i) => {
        if (!finite(p)) return;
        xs[i].push(p[0]);
        ys[i].push(p[1]);
      });
    }
    const typical = xs.map((x, i) => (x.length > 0 ? [median(x), median(ys[i])] : [NaN, NaN]));
    const next = normalize(typical);
    if (!next) break;
    ref = next;
  }
  return ref;
}

/**
 * The typical pose fitted onto `target` (same node order), over the nodes
 * `target` has placed. Null with fewer than 2 shared placed nodes.
 *
 * With 4+ shared nodes the worst-fitting node is dropped and the fit redone
 * once, so the one misplaced node a flag is usually about doesn't drag the
 * whole typical pose toward itself.
 */
export function alignTypicalPose(template: Pose, target: Pose): Pose | null {
  const t = fitSimilarity(template, target);
  if (!t) return null;
  const fitted = applySimilarity(t, template);
  const shared = fitted
    .map((p, i) => (finite(p) && finite(target[i]) ? i : -1))
    .filter((i) => i >= 0);
  if (shared.length < 4) return fitted;
  let worst = shared[0];
  let worstD = -1;
  for (const i of shared) {
    const d = Math.hypot(fitted[i][0] - target[i][0], fitted[i][1] - target[i][1]);
    if (d > worstD) {
      worstD = d;
      worst = i;
    }
  }
  const trimmed = target.map((p, i) => (i === worst ? [NaN, NaN] : p));
  const t2 = fitSimilarity(template, trimmed);
  return t2 ? applySimilarity(t2, template) : fitted;
}
