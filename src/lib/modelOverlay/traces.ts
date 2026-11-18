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
 * Animals linked across frames: `byFrame.get(f).get(animal)` = that animal's
 * poses (one per model) on frame f. Computed once per set of models — the
 * node shown doesn't change it.
 */
export interface AnimalIndex {
  byFrame: Map<number, Map<number, GroupMember[]>>;
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

export function buildAnimalIndex(models: readonly OverlayModel[]): AnimalIndex {
  const frameSet = new Set<number>();
  for (const m of models) for (const f of m.frames.keys()) frameSet.add(f);
  const frames = [...frameSet].sort((a, b) => a - b);
  const byFrame = new Map<number, Map<number, GroupMember[]>>();
  const last: Float64Array[] = []; // animal → its most recent mean pose
  for (const f of frames) {
    const layers: MatchLayer[] = models.map((m) => ({ poses: m.frames.get(f) ?? [] }));
    const groups = models.length === 1 ? layers[0].poses.map((_, i) => [{ layer: 0, pose: i }]) : groupAcrossModels(layers, false);
    const means = groups.map((g) => meanOf(layers, g));
    const cost = means.map((m) => last.map((l) => meanNodeDistance(m, l)));
    const assign = last.length > 0 ? hungarian(cost) : means.map(() => -1);
    const here = new Map<number, GroupMember[]>();
    groups.forEach((g, gi) => {
      let animal = assign[gi];
      if (animal < 0 || !(cost[gi][animal] <= linkGate(last[animal]))) {
        animal = last.length;
        last.push(means[gi]);
      } else {
        last[animal] = means[gi];
      }
      here.set(animal, g);
    });
    byFrame.set(f, here);
  }
  return { byFrame, count: last.length };
}

/** How many "animal" choices to offer (at most {@link MAX_TRACE_ANIMALS}). */
export function traceAnimalCount(index: AnimalIndex): number {
  return Math.min(index.count, MAX_TRACE_ANIMALS);
}

const fin = (v: number) => (Number.isFinite(v) ? v : null);

/** `index` is required for an "animal" target (pass the cached {@link buildAnimalIndex}). */
export function buildTraces(
  models: readonly OverlayModel[],
  node: number,
  target: TraceTarget,
  index?: AnimalIndex
): TraceData {
  const frameSet = new Set<number>();
  for (const m of models) for (const f of m.frames.keys()) frameSet.add(f);
  const frames = [...frameSet].sort((a, b) => a - b);
  const x: (number | null)[][] = models.map(() => new Array(frames.length).fill(null));
  const y: (number | null)[][] = models.map(() => new Array(frames.length).fill(null));

  const animals = target.kind === "animal" ? (index ?? buildAnimalIndex(models)) : null;
  frames.forEach((f, i) => {
    if (target.kind === "track") {
      models.forEach((m, mi) => {
        const pose = m.frames.get(f)?.find((p) => p.trackName === target.name);
        if (!pose) return;
        x[mi][i] = fin(pose.xy[2 * node]);
        y[mi][i] = fin(pose.xy[2 * node + 1]);
      });
      return;
    }
    const group = animals?.byFrame.get(f)?.get(target.index);
    for (const mem of group ?? []) {
      const pose = models[mem.layer].frames.get(f)![mem.pose];
      x[mem.layer][i] = fin(pose.xy[2 * node]);
      y[mem.layer][i] = fin(pose.xy[2 * node + 1]);
    }
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
