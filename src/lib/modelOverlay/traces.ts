/**
 * Compare model predictions: per-node traces. For one node of one animal, the
 * x and y position over time, one line per model, so jumps and drift where
 * the models part ways stand out (as in Lightning Pose's trace plots).
 *
 * Which animal: when every shown model has the same track names, a track;
 * otherwise an "animal" from {@link buildAnimalIndex}: on each frame the
 * models' poses are grouped across models ({@link groupAcrossModels}), and
 * each group is linked to the closest animal seen on an earlier frame
 * (Hungarian on mean node distance), so an animal keeps its number from
 * frame to frame instead of following the models' arbitrary pose order. A
 * group too far from every known animal starts a new one.
 *
 * Output is uPlot-ready: one x array of frame indices, and per model a y array
 * with null (never NaN) where the model has no position. uPlot froze the app
 * once on a non-finite scale (#379), so {@link traceRange} always returns a
 * finite, non-empty range.
 */
import type { OverlayModel } from "@/stores/modelOverlayStore";
import { groupAcrossModels, hungarian, meanNodeDistance, poseSize, type GroupMember, type MatchLayer } from "./matching";
import type { OverlayPose } from "./core";
import { PoseStore, type PoseFrames } from "./poseStore";

export type TraceTarget = { kind: "track"; name: string } | { kind: "animal"; index: number };

export interface TraceData {
  /** Frame indices, ascending: every frame where any of the models has a pose. */
  frames: number[];
  /** `x[m][i]`: model m's x at `frames[i]` (null when missing). Same for `y`. */
  x: (number | null)[][];
  y: (number | null)[][];
}

/** Track names to choose from (sorted), or empty when tracks can't be used. */
export function traceTrackNames(models: readonly OverlayModel[], byTrack: boolean): string[] {
  if (!byTrack || models.length === 0) return [];
  return [...models[0].trackNames].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Most animals offered in the picker. */
export const MAX_TRACE_ANIMALS = 20;

/**
 * Animals linked across frames, computed once per set of models (the node
 * shown doesn't change it). Kept compact — one small integer per pose rather
 * than objects per frame — because a long video has millions of poses (see
 * poseStore.ts).
 */
export interface AnimalIndex {
  /** Every frame where any model has a pose, ascending. */
  frames: Int32Array;
  /**
   * `animalOf[m][j]` = the animal of model m's j-th pose, counting poses in
   * frame order (frames ascending, then the order on the frame).
   */
  animalOf: Int32Array[];
  /** Animals found (numbered 0…count-1 in order of first appearance). */
  count: number;
}

function meanOf(layers: readonly MatchLayer[], members: readonly GroupMember[]): Float64Array {
  const n = layers[members[0].layer].poses[members[0].pose].xy.length;
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sum = 0;
    let c = 0;
    for (const m of members) {
      const v = layers[m.layer].poses[m.pose].xy[k];
      if (Number.isFinite(v)) {
        sum += v;
        c++;
      }
    }
    out[k] = c > 0 ? sum / c : NaN;
  }
  return out;
}

/** Farthest a group may be from an animal's last position to continue it: its size, at least 50 px. */
function linkGate(lastMean: Float64Array): number {
  return Math.max(50, poseSize(lastMean));
}

/** Every frame where any of the models has a pose, ascending. */
export function unionFrames(models: readonly OverlayModel[]): Int32Array {
  let total = 0;
  for (const m of models) total += m.frames.size;
  const all = new Int32Array(total);
  let i = 0;
  for (const m of models) for (const f of m.frames.keys()) all[i++] = f;
  all.sort();
  let w = 0;
  for (let r = 0; r < all.length; r++) if (r === 0 || all[r] !== all[r - 1]) all[w++] = all[r];
  return all.slice(0, w);
}

/** A model's frames ascending (a PoseStore's already are). */
function sortedFrames(frames: PoseFrames): Int32Array {
  if (frames instanceof PoseStore) return frames.frameIdx;
  return Int32Array.from(frames.keys()).sort();
}

/** Links animals frame by frame; {@link step} does a batch of frames. */
class AnimalLinker {
  readonly frames: Int32Array;
  readonly animalOf: Int32Array[];
  private poseCursor: number[];
  private last: Float64Array[] = []; // animal → its most recent mean pose
  row = 0;

  constructor(private models: readonly OverlayModel[]) {
    this.frames = unionFrames(models);
    this.animalOf = models.map((m) => {
      let n = 0;
      if (m.frames instanceof PoseStore) n = m.frames.poseCount;
      else for (const f of m.frames.keys()) n += m.frames.get(f)?.length ?? 0;
      return new Int32Array(n).fill(-1);
    });
    this.poseCursor = models.map(() => 0);
  }

  get done(): boolean {
    return this.row >= this.frames.length;
  }

  step(maxFrames: number): void {
    const models = this.models;
    const last = this.last;
    const end = Math.min(this.frames.length, this.row + maxFrames);
    for (; this.row < end; this.row++) {
      const f = this.frames[this.row];
      const layers: MatchLayer[] = models.map((m) => ({ poses: posesNoCache(m.frames, f) }));
      const groups =
        models.length === 1 ? layers[0].poses.map((_, i) => [{ layer: 0, pose: i }]) : groupAcrossModels(layers, false);
      const means = groups.map((g) => meanOf(layers, g));
      const cost = means.map((m) => last.map((l) => meanNodeDistance(m, l)));
      const assign = last.length > 0 ? hungarian(cost) : means.map(() => -1);
      groups.forEach((g, gi) => {
        let animal = assign[gi];
        if (animal < 0 || !(cost[gi][animal] <= linkGate(last[animal]))) {
          animal = last.length;
          last.push(means[gi]);
        } else {
          last[animal] = means[gi];
        }
        for (const mem of g) this.animalOf[mem.layer][this.poseCursor[mem.layer] + mem.pose] = animal;
      });
      layers.forEach((l, li) => (this.poseCursor[li] += l.poses.length));
    }
  }

  result(): AnimalIndex {
    return { frames: this.frames, animalOf: this.animalOf, count: this.last.length };
  }
}

/** A frame's poses without filling a store's small cache (bulk passes over every frame). */
function posesNoCache(frames: PoseFrames, f: number): OverlayPose[] {
  return frames instanceof PoseStore ? frames.make(f) : (frames.get(f) ?? []);
}

export function buildAnimalIndex(models: readonly OverlayModel[]): AnimalIndex {
  const linker = new AnimalLinker(models);
  linker.step(Infinity);
  return linker.result();
}

/**
 * {@link buildAnimalIndex} in time slices, yielding to the UI between them
 * (a 100k-frame video takes seconds). Resolves null when aborted.
 */
export async function buildAnimalIndexAsync(
  models: readonly OverlayModel[],
  opts: { signal?: AbortSignal; sliceMs?: number; onProgress?: (done: number, total: number) => void } = {}
): Promise<AnimalIndex | null> {
  const linker = new AnimalLinker(models);
  const slice = opts.sliceMs ?? 12;
  while (!linker.done) {
    if (opts.signal?.aborted) return null;
    const t0 = performance.now();
    do linker.step(64);
    while (!linker.done && performance.now() - t0 < slice);
    opts.onProgress?.(linker.row, linker.frames.length);
    if (!linker.done) await new Promise((r) => setTimeout(r, 0));
  }
  return opts.signal?.aborted ? null : linker.result();
}

/** How many "animal" choices to offer (at most {@link MAX_TRACE_ANIMALS}). */
export function traceAnimalCount(index: AnimalIndex): number {
  return Math.min(index.count, MAX_TRACE_ANIMALS);
}

const fin = (v: number) => (Number.isFinite(v) ? v : null);

/**
 * Calls `fn(row, j, xy, off)` for each of a model's poses in frame order:
 * `row` = the frame's row in `frames` (the union), `j` = the pose's number in
 * frame order, its values at `xy[off …]`. No pose objects for a PoseStore.
 */
function forEachPose(
  m: OverlayModel,
  frames: Int32Array,
  fn: (row: number, j: number, xy: Float64Array, off: number, trackName: string | null) => void
): void {
  const store = m.frames instanceof PoseStore ? m.frames : null;
  const own = sortedFrames(m.frames);
  let row = 0;
  let j = 0;
  for (let r = 0; r < own.length; r++) {
    const f = own[r];
    while (row < frames.length && frames[row] < f) row++;
    if (store) {
      const stride = store.nNodes * 2;
      for (let p = store.poseStart[r]; p < store.poseStart[r + 1]; p++, j++) {
        const t = store.trackIds[p];
        fn(row, j, store.xy, p * stride, t >= 0 ? store.trackNameList[t] : null);
      }
    } else {
      for (const pose of m.frames.get(f) ?? []) fn(row, j++, pose.xy, 0, pose.trackName);
    }
  }
}

/** `index` is required for an "animal" target (pass the cached {@link buildAnimalIndex}). */
export function buildTraces(
  models: readonly OverlayModel[],
  node: number,
  target: TraceTarget,
  index?: AnimalIndex
): TraceData {
  const animals = target.kind === "animal" ? (index ?? buildAnimalIndex(models)) : null;
  const union = animals?.frames ?? unionFrames(models);
  const frames = Array.from(union);
  const x: (number | null)[][] = models.map(() => new Array(frames.length).fill(null));
  const y: (number | null)[][] = models.map(() => new Array(frames.length).fill(null));
  const wantAnimal = target.kind === "animal" ? target.index : -1;
  const wantTrack = target.kind === "track" ? target.name : null;
  models.forEach((m, mi) => {
    const animalOf = animals?.animalOf[mi];
    let lastRow = -1;
    forEachPose(m, union, (row, j, xy, off, trackName) => {
      if (animalOf ? animalOf[j] !== wantAnimal : trackName !== wantTrack) return;
      // A track given to several poses on one frame: the first one, as before.
      if (row === lastRow) return;
      lastRow = row;
      x[mi][row] = fin(xy[off + 2 * node]);
      y[mi][row] = fin(xy[off + 2 * node + 1]);
    });
  });
  return { frames, x, y };
}

/** A finite [min, max] around the values, padded 5%; [0, 1] when there are none. */
export function traceRange(series: readonly (readonly (number | null)[])[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const s of series) {
    for (const v of s) {
      if (v === null || !Number.isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (hi - lo < 1e-9) return [lo - 1, hi + 1];
  const pad = (hi - lo) * 0.05;
  return [lo - pad, hi + pad];
}
