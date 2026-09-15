/**
 * normalize_pose + the nearest-neighbor reference scorer (the `nn_distance`
 * feature).
 *
 * Ported from github.com/alexwu-z/sleap-qc-webapp
 * (`src/lib/qc/checks/features/reference.js`, itself a port of
 * `sleap/qc/features/reference.py`), a lab JS port of Python `sleap.qc`.
 *
 * The reference JS port swapped Python's scipy KD-tree for a brute-force scan
 * (its documented shortcut). At QC scale that scan dominates: the fit step's
 * leave-one-out distances are O(ref²) and every scored instance is an O(ref)
 * query, so a large project spends seconds here. This module restores an EXACT
 * KD-tree (identical distances to the brute force, byte-for-byte — the tree only
 * prunes candidates that cannot be closer) to bring the web engine near the
 * Python's ~1 s. The tree splits on the axis of greatest spread, which adapts to
 * the low intrinsic dimensionality of normalized poses (nominal dim = 2·nNodes),
 * and early-abandons the per-candidate distance once it exceeds the current best.
 */
import { isVisible, visiblePoints, type Pose } from "./util";

const NAN2: [number, number] = [Number.NaN, Number.NaN];

/** Center a pose at its visible centroid and scale by its bbox diagonal (NaN preserved). */
export function normalizePose(pose: Pose): Pose {
  const vis = visiblePoints(pose);
  if (vis.length < 2) return pose.map((p) => [...p]);
  const cx = vis.reduce((s, p) => s + p[0], 0) / vis.length;
  const cy = vis.reduce((s, p) => s + p[1], 0) / vis.length;
  const minX = Math.min(...vis.map((p) => p[0]));
  const minY = Math.min(...vis.map((p) => p[1]));
  const maxX = Math.max(...vis.map((p) => p[0]));
  const maxY = Math.max(...vis.map((p) => p[1]));
  let scale = Math.hypot(maxX - minX, maxY - minY);
  if (scale < 1e-6) scale = 1.0;
  return pose.map((p) =>
    isVisible(p) ? [(p[0] - cx) / scale, (p[1] - cy) / scale] : [...NAN2],
  );
}

// Flatten a normalized pose to a vector with NaN imputed to 0 (mirrors
// np.nan_to_num), matching the KD-tree feature space the Python uses.
const flat = (pose: Pose): number[] =>
  pose.flatMap((p) => [
    Number.isNaN(p[0]) ? 0 : p[0],
    Number.isNaN(p[1]) ? 0 : p[1],
  ]);

/** `score()`/`looDistances()` result element. */
export interface NnResult {
  nnDistance: number;
  nnIndex: number;
}

/**
 * A static, exact k-d tree over `count` points packed row-major in `refs`
 * (`count × dim`). Built once per fit; each query returns the true nearest
 * neighbour (same distance a full scan would find). Nodes are stored in flat
 * typed arrays to avoid per-node objects; queries recurse over `dim`-length
 * points (depth ≈ log(count)), so no heap allocation happens per query.
 */
class KdTree {
  private readonly refs: Float64Array;
  private readonly count: number;
  private readonly dim: number;
  private readonly leafSize: number;
  private readonly order: Int32Array; // point indices, grouped by leaf
  // Per-node flat arrays. A node is a leaf iff splitDim[node] < 0.
  private readonly splitDim: Int32Array;
  private readonly splitVal: Float64Array;
  private readonly left: Int32Array;
  private readonly right: Int32Array;
  private readonly lo: Int32Array; // leaf: order[lo..hi) are its points
  private readonly hi: Int32Array;
  private nNodes = 0;
  private root = -1;

  // Query scratch (set per query, reused across the recursion — no allocation).
  private q: ArrayLike<number> = [];
  private bestSq = Infinity;
  private bestIdx = -1;
  private selfIdx = -1;

  constructor(refs: Float64Array, count: number, dim: number, leafSize = 16) {
    this.refs = refs;
    this.count = count;
    this.dim = dim;
    this.leafSize = leafSize;
    this.order = new Int32Array(count);
    for (let i = 0; i < count; i++) this.order[i] = i;
    // A binary tree whose leaves each hold ≥1 point has ≤ count leaves and
    // ≤ count−1 internal nodes: 2·count+1 is a safe upper bound.
    const cap = Math.max(1, 2 * count + 1);
    this.splitDim = new Int32Array(cap);
    this.splitVal = new Float64Array(cap);
    this.left = new Int32Array(cap).fill(-1);
    this.right = new Int32Array(cap).fill(-1);
    this.lo = new Int32Array(cap);
    this.hi = new Int32Array(cap);
    this.root = this.build(0, count);
  }

  /** Build the subtree over order[lo..hi); returns its node id. */
  private build(lo: number, hi: number): number {
    const node = this.nNodes++;
    const n = hi - lo;
    if (n <= this.leafSize || this.dim === 0) {
      this.splitDim[node] = -1;
      this.lo[node] = lo;
      this.hi[node] = hi;
      return node;
    }
    // Split on the axis of greatest spread over this bucket (adapts to the
    // data's low intrinsic dimensionality — where the variance actually is).
    const dim = this.dim;
    const refs = this.refs;
    const order = this.order;
    let bestDim = 0;
    let bestSpread = -1;
    for (let d = 0; d < dim; d++) {
      let mn = Infinity;
      let mx = -Infinity;
      for (let p = lo; p < hi; p++) {
        const v = refs[order[p] * dim + d];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      const spread = mx - mn;
      if (spread > bestSpread) {
        bestSpread = spread;
        bestDim = d;
      }
    }
    if (!(bestSpread > 0)) {
      // Degenerate bucket (all coordinates identical): keep it as a leaf.
      this.splitDim[node] = -1;
      this.lo[node] = lo;
      this.hi[node] = hi;
      return node;
    }
    const mid = (lo + hi) >> 1;
    this.nthElement(lo, hi, mid, bestDim);
    const val = refs[order[mid] * dim + bestDim];
    this.splitDim[node] = bestDim;
    this.splitVal[node] = val;
    this.left[node] = this.build(lo, mid);
    this.right[node] = this.build(mid, hi);
    return node;
  }

  /**
   * Partition order[lo..hi) so that the element at `k` is the one that would sit
   * there if the range were sorted by coordinate `d`, with everything before ≤ it
   * and everything after ≥ it (Hoare-style quickselect / std::nth_element).
   */
  private nthElement(lo: number, hi: number, k: number, d: number): void {
    const order = this.order;
    const refs = this.refs;
    const dim = this.dim;
    const key = (i: number) => refs[order[i] * dim + d];
    let l = lo;
    let r = hi - 1;
    while (l < r) {
      // Median-of-three pivot to avoid worst-case on sorted/clustered input.
      const m = (l + r) >> 1;
      const a = key(l);
      const b = key(m);
      const c = key(r);
      let pivotIdx = m;
      if ((a <= b && b <= c) || (c <= b && b <= a)) pivotIdx = m;
      else if ((b <= a && a <= c) || (c <= a && a <= b)) pivotIdx = l;
      else pivotIdx = r;
      const pivot = key(pivotIdx);
      // Lomuto partition around `pivot`.
      let i = l;
      let j = r;
      while (i <= j) {
        while (key(i) < pivot) i++;
        while (key(j) > pivot) j--;
        if (i <= j) {
          const t = order[i];
          order[i] = order[j];
          order[j] = t;
          i++;
          j--;
        }
      }
      if (k <= j) r = j;
      else if (k >= i) l = i;
      else break;
    }
  }

  /** Nearest neighbour of `q`, excluding point index `exclude` (-1 = none). */
  nearest(q: ArrayLike<number>, exclude: number): NnResult {
    this.q = q;
    this.bestSq = Infinity;
    this.bestIdx = -1;
    this.selfIdx = exclude;
    if (this.count > 0) this.search(this.root);
    return {
      nnDistance: Number.isFinite(this.bestSq) ? Math.sqrt(this.bestSq) : Infinity,
      nnIndex: this.bestIdx,
    };
  }

  private search(node: number): void {
    const d = this.splitDim[node];
    if (d < 0) {
      this.scanLeaf(node);
      return;
    }
    const diff = this.q[d] - this.splitVal[node];
    const near = diff <= 0 ? this.left[node] : this.right[node];
    const far = diff <= 0 ? this.right[node] : this.left[node];
    this.search(near);
    // The far child cannot beat the best unless the splitting plane is closer
    // than the current best distance. (Equal-distance points never lower the
    // min distance, so `<` — not `<=` — stays exact.)
    if (diff * diff < this.bestSq) this.search(far);
  }

  private scanLeaf(node: number): void {
    const refs = this.refs;
    const order = this.order;
    const q = this.q;
    const dim = this.dim;
    const self = this.selfIdx;
    const end = this.hi[node];
    for (let p = this.lo[node]; p < end; p++) {
      const idx = order[p];
      if (idx === self) continue;
      const base = idx * dim;
      const cap = this.bestSq;
      let s = 0;
      for (let k = 0; k < dim; k++) {
        const dv = q[k] - refs[base + k];
        s += dv * dv;
        if (s >= cap) break; // early abandon: cannot become the new best
      }
      if (s < this.bestSq) {
        this.bestSq = s;
        this.bestIdx = idx;
      }
    }
  }
}

export class NearestNeighborScorer {
  normalize: boolean;
  private _refs: Float64Array | null;
  private _count: number;
  private _dim: number;
  private _tree: KdTree | null;

  constructor({ normalize = true }: { normalize?: boolean } = {}) {
    this.normalize = normalize;
    this._refs = null; // packed Float64Array (count * dim) — allocation-free distances
    this._count = 0;
    this._dim = 0;
    this._tree = null;
  }

  fit(poses: Pose[]): this {
    const flats = poses.map((p) => flat(this.normalize ? normalizePose(p) : p));
    this._dim = flats.length ? flats[0].length : 0;
    this._count = flats.length;
    this._refs = new Float64Array(this._count * this._dim);
    for (let i = 0; i < this._count; i++)
      this._refs.set(flats[i], i * this._dim);
    this._tree = new KdTree(this._refs, this._count, this._dim);
    return this;
  }

  /** Nearest-neighbor distance of a pose against the reference set. */
  score(pose: Pose): NnResult {
    const q = flat(this.normalize ? normalizePose(pose) : pose);
    return (this._tree as KdTree).nearest(q, -1);
  }

  /** Leave-one-out NN distance for every reference pose. */
  looDistances(): number[] {
    const refs = this._refs as Float64Array,
      dim = this._dim,
      count = this._count,
      tree = this._tree as KdTree;
    const out = new Array<number>(count);
    for (let i = 0; i < count; i++) {
      // Query with the point's own stored (already-normalized) vector, excluding
      // itself. A subarray view avoids copying the row.
      const q = refs.subarray(i * dim, i * dim + dim);
      const r = tree.nearest(q, i);
      out[i] = Number.isFinite(r.nnDistance) ? r.nnDistance : 0;
    }
    return out;
  }
}
