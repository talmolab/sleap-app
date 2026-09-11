/**
 * The 12 baseline (v2) per-instance QC features.
 *
 * Ported from github.com/alexwu-z/sleap-qc-webapp
 * (`src/lib/qc/checks/features/baseline.js`, itself a port of
 * `sleap/qc/features/baseline.py`), a lab JS port of Python `sleap.qc` intended
 * for integration into sleap-app.
 *
 * `BaselineFeatureExtractor.fit(instances)` learns population stats
 * (edge lengths, joint angles, pairwise distances, bbox area) over a reference
 * set of poses; `extract(pose)` turns one pose into the 12-number feature vector
 * (aligned with {@link BASELINE_FEATURE_NAMES}); `attribute(pose)` returns the
 * culprit node(s)/edge/angle behind each node-localizable feature for canvas
 * highlighting. A pose is `number[][]` of shape (nNodes, 2); an invisible node
 * is `[NaN, NaN]` (see {@link Pose}).
 */
import {
  isVisible,
  dist,
  std,
  safeMean,
  safeStd,
  maxAbs,
  meanAbs,
  bbox,
  type Pose,
  type Pt,
} from "./util";

/** The 12 baseline (v2) feature names, in `extract()` output order. */
export const BASELINE_FEATURE_NAMES = [
  "max_edge_zscore",
  "mean_edge_zscore",
  "max_angle_zscore",
  "mean_angle_zscore",
  "max_pairwise_zscore",
  "mean_pairwise_zscore",
  "bbox_area_zscore",
  "max_centroid_distance",
  "centroid_distance_std",
  "min_symmetry_consistency",
  "visibility_rate",
  "has_isolated_invisible",
] as const;

/** Learned population stats over the reference set. */
interface BaselineStats {
  edgeMeans: Map<string, number>;
  edgeStds: Map<string, number>;
  pairwiseMeans: Map<string, number>;
  pairwiseStds: Map<string, number>;
  angleMeans: Map<string, number>;
  angleStds: Map<string, number>;
  bboxAreaMean: number;
  bboxAreaStd: number;
}

/**
 * A per-feature attribution: the node(s)/edge/angle that drive a feature's
 * value. `kind` tells the canvas how to draw it ("edge" = ring the two
 * endpoints, "angle" = draw the arc at `nodes[0]` between arms `nodes[1..2]`);
 * `dir` is the signed z-score sign (+1 larger than learned, -1 smaller) where
 * direction is meaningful.
 */
export interface AttributionEntry {
  nodes: number[];
  kind?: "edge" | "angle";
  dir?: number;
}

/**
 * Attribution map. Only node-localizable features appear at runtime; the
 * whole-instance keys (visibility_rate, bbox_area_zscore, nn_distance) are
 * declared so callers can query them and get `undefined`.
 */
export type AttributionMap = Partial<
  Record<
    | "max_edge_zscore"
    | "max_angle_zscore"
    | "max_pairwise_zscore"
    | "max_centroid_distance"
    | "min_symmetry_consistency"
    | "has_isolated_invisible"
    | "visibility_rate"
    | "bbox_area_zscore"
    | "nn_distance",
    AttributionEntry
  >
>;

const edgeKey = (a: number, b: number): string =>
  a < b ? `${a},${b}` : `${b},${a}`;
const norm2 = (v: number[]): number => Math.hypot(v[0], v[1]);
const sub = (a: Pt, b: Pt): [number, number] => [a[0] - b[0], a[1] - b[1]];

export class BaselineFeatureExtractor {
  edges: [number, number][];
  nNodes: number;
  symmetryPairs: [number, number][];
  stats: BaselineStats | null;
  private _adjacency: number[][] | null;

  constructor(
    edges: [number, number][],
    nNodes: number,
    symmetryPairs: [number, number][] = [],
  ) {
    this.edges = edges;
    this.nNodes = nNodes;
    this.symmetryPairs = symmetryPairs;
    this.stats = null;
    this._adjacency = null;
  }

  /** adjacency[i] = list of neighbor node indices */
  private _buildAdjacency(): void {
    const adj: number[][] = Array.from({ length: this.nNodes }, () => []);
    for (const [s, d] of this.edges) {
      adj[s].push(d);
      adj[d].push(s);
    }
    this._adjacency = adj;
  }

  /** joint-angle triplets keyed (center, min(n1,n2), max(n1,n2)) */
  private _angleTriplets(): number[][] {
    const out: number[][] = [];
    (this._adjacency as number[][]).forEach((neighbors, center) => {
      if (neighbors.length < 2) return;
      for (let i = 0; i < neighbors.length; i++)
        for (let j = i + 1; j < neighbors.length; j++)
          out.push([
            center,
            Math.min(neighbors[i], neighbors[j]),
            Math.max(neighbors[i], neighbors[j]),
          ]);
    });
    return out;
  }

  fit(instances: Pose[]): this {
    this._buildAdjacency();
    const adj = this._adjacency as number[][];
    const edgeLen = new Map<string, number[]>(
      this.edges.map((e) => [edgeKey(e[0], e[1]), []]),
    );
    const pairwise = new Map<string, number[]>();
    for (let i = 0; i < this.nNodes; i++)
      for (let j = i + 1; j < this.nNodes; j++) pairwise.set(`${i},${j}`, []);
    const angles = new Map<string, number[]>(
      this._angleTriplets().map((t) => [t.join(","), []]),
    );

    const bboxAreas: number[] = [];
    for (const pose of instances) {
      for (const [s, d] of this.edges) {
        if (isVisible(pose[s]) && isVisible(pose[d]))
          edgeLen.get(edgeKey(s, d))!.push(dist(pose[s], pose[d]));
      }
      for (let i = 0; i < this.nNodes; i++)
        for (let j = i + 1; j < this.nNodes; j++)
          if (isVisible(pose[i]) && isVisible(pose[j]))
            pairwise.get(`${i},${j}`)!.push(dist(pose[i], pose[j]));
      adj.forEach((neighbors, center) => {
        if (neighbors.length < 2 || !isVisible(pose[center])) return;
        for (let i = 0; i < neighbors.length; i++)
          for (let j = i + 1; j < neighbors.length; j++) {
            const n1 = neighbors[i],
              n2 = neighbors[j];
            if (!isVisible(pose[n1]) || !isVisible(pose[n2])) continue;
            const a = this._angle(pose[center], pose[n1], pose[n2]);
            if (a != null)
              angles
                .get([center, Math.min(n1, n2), Math.max(n1, n2)].join(","))!
                .push(a);
          }
      });
      const box = bbox(pose);
      if (box) bboxAreas.push((box[2] - box[0]) * (box[3] - box[1]));
    }

    const meanMap = (m: Map<string, number[]>): Map<string, number> =>
      new Map([...m].map(([k, v]) => [k, safeMean(v)]));
    const stdMap = (m: Map<string, number[]>): Map<string, number> =>
      new Map([...m].map(([k, v]) => [k, safeStd(v)]));
    this.stats = {
      edgeMeans: meanMap(edgeLen),
      edgeStds: stdMap(edgeLen),
      pairwiseMeans: meanMap(pairwise),
      pairwiseStds: stdMap(pairwise),
      angleMeans: meanMap(angles),
      angleStds: stdMap(angles),
      bboxAreaMean: safeMean(bboxAreas),
      bboxAreaStd: safeStd(bboxAreas),
    };
    return this;
  }

  /** Angle at `center` between vectors to p1, p2 (radians); null if degenerate. */
  private _angle(center: Pt, p1: Pt, p2: Pt): number | null {
    const v1 = sub(p1, center),
      v2 = sub(p2, center);
    const n1 = norm2(v1),
      n2 = norm2(v2);
    if (n1 < 1e-6 || n2 < 1e-6) return null;
    const cos = Math.max(
      -1,
      Math.min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)),
    );
    return Math.acos(cos);
  }

  extract(pose: Pose): number[] {
    if (!this.stats) throw new Error("Must call fit() before extract()");
    const edgeZ = this._edgeZscores(pose);
    const angleZ = this._angleZscores(pose);
    const pwZ = this._pairwiseZscores(pose);
    const cent = this._centroidDistances(pose);
    const [visRate, isolated] = this._visibilityFeatures(pose);
    return [
      maxAbs(edgeZ),
      meanAbs(edgeZ),
      maxAbs(angleZ),
      meanAbs(angleZ),
      maxAbs(pwZ),
      meanAbs(pwZ),
      this._bboxZscore(pose),
      cent.length ? Math.max(...cent) : 0,
      cent.length ? std(cent) : 0,
      this._symmetryConsistency(pose),
      visRate,
      isolated ? 1 : 0,
    ];
  }

  private _edgeZscores(pose: Pose): number[] {
    const stats = this.stats as BaselineStats;
    const z: number[] = [];
    for (const [s, d] of this.edges) {
      if (!isVisible(pose[s]) || !isVisible(pose[d])) continue;
      const k = edgeKey(s, d);
      if (stats.edgeMeans.has(k))
        z.push((dist(pose[s], pose[d]) - stats.edgeMeans.get(k)!) / stats.edgeStds.get(k)!);
    }
    return z;
  }

  private _angleZscores(pose: Pose): number[] {
    const stats = this.stats as BaselineStats;
    const adj = this._adjacency as number[][];
    const z: number[] = [];
    adj.forEach((neighbors, center) => {
      if (neighbors.length < 2 || !isVisible(pose[center])) return;
      for (let i = 0; i < neighbors.length; i++)
        for (let j = i + 1; j < neighbors.length; j++) {
          const n1 = neighbors[i],
            n2 = neighbors[j];
          if (!isVisible(pose[n1]) || !isVisible(pose[n2])) continue;
          const a = this._angle(pose[center], pose[n1], pose[n2]);
          if (a == null) continue;
          const k = [center, Math.min(n1, n2), Math.max(n1, n2)].join(",");
          if (stats.angleMeans.has(k))
            z.push((a - stats.angleMeans.get(k)!) / stats.angleStds.get(k)!);
        }
    });
    return z;
  }

  private _pairwiseZscores(pose: Pose): number[] {
    const stats = this.stats as BaselineStats;
    const z: number[] = [];
    for (let i = 0; i < this.nNodes; i++)
      for (let j = i + 1; j < this.nNodes; j++) {
        if (!isVisible(pose[i]) || !isVisible(pose[j])) continue;
        const k = `${i},${j}`;
        z.push(
          (dist(pose[i], pose[j]) - stats.pairwiseMeans.get(k)!) /
            stats.pairwiseStds.get(k)!,
        );
      }
    return z;
  }

  private _bboxZscore(pose: Pose): number {
    const stats = this.stats as BaselineStats;
    const box = bbox(pose);
    if (!box) return 0;
    const area = (box[2] - box[0]) * (box[3] - box[1]);
    return (area - stats.bboxAreaMean) / stats.bboxAreaStd;
  }

  private _centroidDistances(pose: Pose): number[] {
    const vis = pose.filter(isVisible);
    if (vis.length < 2) return [];
    const cx = vis.reduce((s, p) => s + p[0], 0) / vis.length;
    const cy = vis.reduce((s, p) => s + p[1], 0) / vis.length;
    return vis.map((p) => Math.hypot(p[0] - cx, p[1] - cy));
  }

  private _symmetryConsistency(pose: Pose): number {
    if (this.symmetryPairs.length < 2) return 1.0;
    const scores: number[] = [];
    for (let i = 0; i < this.symmetryPairs.length; i++) {
      const [l1, r1] = this.symmetryPairs[i];
      if (!isVisible(pose[l1]) || !isVisible(pose[r1])) continue;
      let consistent = 0,
        total = 0;
      for (let j = 0; j < this.symmetryPairs.length; j++) {
        if (i === j) continue;
        const [l2, r2] = this.symmetryPairs[j];
        if (!isVisible(pose[l2]) || !isVisible(pose[r2])) continue;
        const ratio =
          dist(pose[l1], pose[l2]) / Math.max(dist(pose[l1], pose[r2]), 1e-6);
        if (ratio < 0.9) consistent += 1;
        else if (ratio <= 1.1) consistent += 0.5;
        total += 1;
      }
      if (total > 0) scores.push(consistent / total);
    }
    return scores.length ? Math.min(...scores) : 1.0;
  }

  private _visibilityFeatures(pose: Pose): [number, boolean] {
    const adj = this._adjacency as number[][];
    const visMask = pose.map(isVisible);
    const visRate = visMask.filter(Boolean).length / this.nNodes;
    let isolated = false;
    for (let i = 0; i < this.nNodes; i++) {
      if (visMask[i]) continue;
      const nb = adj[i];
      if (nb.length && nb.every((n) => visMask[n])) {
        isolated = true;
        break;
      }
    }
    return [visRate, isolated];
  }

  /**
   * Per-feature culprit node(s) + direction for UI attribution. For the
   * node-localizable baseline features, returns the node/edge/angle that drives
   * the feature's value — the argmax (or argmin) that `extract()`'s reductions
   * discard. Whole-instance features (mean_*, bbox, visibility_rate) are
   * intentionally absent — they are not about one node.
   */
  attribute(pose: Pose): AttributionMap {
    if (!this.stats) throw new Error("Must call fit() before attribute()");
    const stats = this.stats;
    const adj = this._adjacency as number[][];
    const out: AttributionMap = {};

    // max_edge_zscore -> the most length-deviant visible edge (both endpoints) + direction.
    let beZ = -Infinity;
    let beEdge: number[] | null = null;
    let beDir = 0;
    for (const [s, d] of this.edges) {
      if (!isVisible(pose[s]) || !isVisible(pose[d])) continue;
      const k = edgeKey(s, d);
      if (!stats.edgeMeans.has(k)) continue;
      const zRaw =
        (dist(pose[s], pose[d]) - stats.edgeMeans.get(k)!) / stats.edgeStds.get(k)!;
      if (Math.abs(zRaw) > beZ) {
        beZ = Math.abs(zRaw);
        beEdge = [s, d];
        beDir = Math.sign(zRaw);
      }
    }
    if (beEdge) out.max_edge_zscore = { kind: "edge", nodes: beEdge, dir: beDir };

    // max_angle_zscore -> the joint (center node) with the most-deviant angle + direction.
    let baZ = -Infinity;
    let baCenter = -1;
    let baDir = 0;
    let baArms: [number, number] | null = null;
    adj.forEach((neighbors, center) => {
      if (neighbors.length < 2 || !isVisible(pose[center])) return;
      for (let i = 0; i < neighbors.length; i++)
        for (let j = i + 1; j < neighbors.length; j++) {
          const n1 = neighbors[i],
            n2 = neighbors[j];
          if (!isVisible(pose[n1]) || !isVisible(pose[n2])) continue;
          const a = this._angle(pose[center], pose[n1], pose[n2]);
          if (a == null) continue;
          const k = [center, Math.min(n1, n2), Math.max(n1, n2)].join(",");
          if (!stats.angleMeans.has(k)) continue;
          const zRaw = (a - stats.angleMeans.get(k)!) / stats.angleStds.get(k)!;
          if (Math.abs(zRaw) > baZ) {
            baZ = Math.abs(zRaw);
            baCenter = center;
            baDir = Math.sign(zRaw);
            baArms = [n1, n2];
          }
        }
    });
    // Joint FIRST, then the two arms that form the deviant angle, so the canvas
    // can draw the arc at the vertex rather than guessing which bone was off.
    if (baCenter >= 0) {
      out.max_angle_zscore = baArms
        ? {
            nodes: [baCenter, (baArms as [number, number])[0], (baArms as [number, number])[1]],
            kind: "angle",
            dir: baDir,
          }
        : { nodes: [baCenter], dir: baDir };
    }

    // max_pairwise_zscore -> the most distance-deviant node pair + direction.
    let bpZ = -Infinity;
    let bpPair: number[] | null = null;
    let bpDir = 0;
    for (let i = 0; i < this.nNodes; i++)
      for (let j = i + 1; j < this.nNodes; j++) {
        if (!isVisible(pose[i]) || !isVisible(pose[j])) continue;
        const zRaw =
          (dist(pose[i], pose[j]) - stats.pairwiseMeans.get(`${i},${j}`)!) /
          stats.pairwiseStds.get(`${i},${j}`)!;
        if (Math.abs(zRaw) > bpZ) {
          bpZ = Math.abs(zRaw);
          bpPair = [i, j];
          bpDir = Math.sign(zRaw);
        }
      }
    if (bpPair) out.max_pairwise_zscore = { kind: "edge", nodes: bpPair, dir: bpDir };

    // max_centroid_distance -> the visible node furthest from the visible centroid
    // (no direction: a distance is one-sided).
    const vis: number[] = [];
    for (let i = 0; i < this.nNodes; i++) if (isVisible(pose[i])) vis.push(i);
    if (vis.length >= 2) {
      const cx = vis.reduce((s, i) => s + pose[i][0], 0) / vis.length;
      const cy = vis.reduce((s, i) => s + pose[i][1], 0) / vis.length;
      let best = -1,
        bestD = -Infinity;
      for (const i of vis) {
        const dd = Math.hypot(pose[i][0] - cx, pose[i][1] - cy);
        if (dd > bestD) {
          bestD = dd;
          best = i;
        }
      }
      if (best >= 0) out.max_centroid_distance = { nodes: [best] };
    }

    // min_symmetry_consistency -> the least-consistent symmetric pair (argmin of extract()).
    if (this.symmetryPairs.length >= 2) {
      let worstPair: number[] | null = null;
      let worstScore = Infinity;
      for (let i = 0; i < this.symmetryPairs.length; i++) {
        const [l1, r1] = this.symmetryPairs[i];
        if (!isVisible(pose[l1]) || !isVisible(pose[r1])) continue;
        let consistent = 0,
          total = 0;
        for (let j = 0; j < this.symmetryPairs.length; j++) {
          if (i === j) continue;
          const [l2, r2] = this.symmetryPairs[j];
          if (!isVisible(pose[l2]) || !isVisible(pose[r2])) continue;
          const ratio =
            dist(pose[l1], pose[l2]) / Math.max(dist(pose[l1], pose[r2]), 1e-6);
          if (ratio < 0.9) consistent += 1;
          else if (ratio <= 1.1) consistent += 0.5;
          total += 1;
        }
        if (total > 0) {
          const sc = consistent / total;
          if (sc < worstScore) {
            worstScore = sc;
            worstPair = [l1, r1];
          }
        }
      }
      if (worstPair) out.min_symmetry_consistency = { kind: "edge", nodes: worstPair };
    }

    // has_isolated_invisible -> the invisible node whose skeleton neighbors are all
    // visible (matches the break in _visibilityFeatures).
    const visMask = pose.map(isVisible);
    for (let i = 0; i < this.nNodes; i++) {
      if (visMask[i]) continue;
      const nb = adj[i];
      if (nb.length && nb.every((n) => visMask[n])) {
        out.has_isolated_invisible = { nodes: [i] };
        break;
      }
    }

    return out;
  }
}
