/**
 * normalize_pose + the nearest-neighbor reference scorer (the `nn_distance`
 * feature).
 *
 * Ported from github.com/alexwu-z/sleap-qc-webapp
 * (`src/lib/qc/checks/features/reference.js`, itself a port of
 * `sleap/qc/features/reference.py`), a lab JS port of Python `sleap.qc` intended
 * for integration into sleap-app. The Python KD-tree is a speed optimization
 * that yields identical distances; here we use a brute-force euclidean scan.
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

export class NearestNeighborScorer {
  normalize: boolean;
  private _refs: Float64Array | null;
  private _count: number;
  private _dim: number;

  constructor({ normalize = true }: { normalize?: boolean } = {}) {
    this.normalize = normalize;
    this._refs = null; // packed Float64Array (count * dim) — allocation-free distances
    this._count = 0;
    this._dim = 0;
  }

  fit(poses: Pose[]): this {
    const flats = poses.map((p) => flat(this.normalize ? normalizePose(p) : p));
    this._dim = flats.length ? flats[0].length : 0;
    this._count = flats.length;
    this._refs = new Float64Array(this._count * this._dim);
    for (let i = 0; i < this._count; i++)
      this._refs.set(flats[i], i * this._dim);
    return this;
  }

  /** Nearest-neighbor distance of a pose against the reference set (O(count)). */
  score(pose: Pose): NnResult {
    const q = flat(this.normalize ? normalizePose(pose) : pose);
    const refs = this._refs as Float64Array,
      dim = this._dim;
    let bestSq = Infinity,
      idx = -1;
    for (let r = 0; r < this._count; r++) {
      const base = r * dim;
      let s = 0;
      for (let k = 0; k < dim; k++) {
        const d = q[k] - refs[base + k];
        s += d * d;
      }
      if (s < bestSq) {
        bestSq = s;
        idx = r;
      }
    }
    return {
      nnDistance: Number.isFinite(bestSq) ? Math.sqrt(bestSq) : Infinity,
      nnIndex: idx,
    };
  }

  /** Leave-one-out NN distance for every reference pose. O(count²). */
  looDistances(): number[] {
    const refs = this._refs as Float64Array,
      dim = this._dim,
      count = this._count;
    const out = new Array<number>(count);
    for (let i = 0; i < count; i++) {
      const bi = i * dim;
      let bestSq = Infinity;
      for (let r = 0; r < count; r++) {
        if (r === i) continue;
        const br = r * dim;
        let s = 0;
        for (let k = 0; k < dim; k++) {
          const d = refs[bi + k] - refs[br + k];
          s += d * d;
        }
        if (s < bestSq) bestSq = s;
      }
      out[i] = Number.isFinite(bestSq) ? Math.sqrt(bestSq) : 0;
    }
    return out;
  }
}
