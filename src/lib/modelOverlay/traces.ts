/**
 * Compare model predictions: per-node traces. For one node of one animal, the
 * x and y position over time, one line per model, so jumps and drift where
 * the models part ways stand out (as in Lightning Pose's trace plots).
 *
 * Which animal: when every shown model has the same track names, a track;
 * otherwise "animal k" = the k-th group of {@link groupAcrossModels} on each
 * frame (the k-th pose of the model with the most poses, with the other
 * models' matching poses). Without tracks that order can change between
 * frames in multi-animal files, so the line can hop between animals there.
 *
 * Output is uPlot-ready: one x array of frame indices, and per model a y array
 * with null (never NaN) where the model has no position. uPlot froze the app
 * once on a non-finite scale (#379), so {@link traceRange} always returns a
 * finite, non-empty range.
 */
import type { OverlayModel } from "@/stores/modelOverlayStore";
import { groupAcrossModels, type MatchLayer } from "./matching";

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

/** How many "animal k" choices to offer: the most poses any model has on a frame (at most 20). */
export function traceAnimalCount(models: readonly OverlayModel[]): number {
  let n = 0;
  for (const m of models) for (const poses of m.frames.values()) n = Math.max(n, poses.length);
  return Math.min(n, 20);
}

const fin = (v: number) => (Number.isFinite(v) ? v : null);

export function buildTraces(models: readonly OverlayModel[], node: number, target: TraceTarget): TraceData {
  const frameSet = new Set<number>();
  for (const m of models) for (const f of m.frames.keys()) frameSet.add(f);
  const frames = [...frameSet].sort((a, b) => a - b);
  const x: (number | null)[][] = models.map(() => new Array(frames.length).fill(null));
  const y: (number | null)[][] = models.map(() => new Array(frames.length).fill(null));

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
    const layers: MatchLayer[] = models.map((m) => ({ poses: m.frames.get(f) ?? [] }));
    // One model: no matching needed, animal k is its k-th pose.
    const group =
      models.length === 1
        ? layers[0].poses[target.index]
          ? [{ layer: 0, pose: target.index }]
          : undefined
        : groupAcrossModels(layers, false)[target.index];
    for (const mem of group ?? []) {
      const pose = layers[mem.layer].poses[mem.pose];
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
