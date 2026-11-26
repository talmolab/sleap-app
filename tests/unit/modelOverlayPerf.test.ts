/**
 * Compare Model Predictions on long videos: the compact pose store, the
 * disagreement index behind ◀ ▶, and the compact animal index behind the
 * traces must give exactly what the simple per-frame versions gave.
 */
import { describe, it, expect, beforeEach } from "../bun-test";
import { PoseStore, PoseStoreBuilder, poseCountOn, trackNamesOf } from "@/lib/modelOverlay/poseStore";
import {
  clearDisagreementIndexCache,
  disagreementFrames,
  disagreementIndexFor,
  fillIndex,
  nextDisagreement,
} from "@/lib/modelOverlay/disagreementIndex";
import { frameDisagreements, modelOverlayLayers, shownModelsShareTracks } from "@/hooks/useModelOverlayFrame";
import { buildAnimalIndex, buildAnimalIndexAsync, buildTraces } from "@/lib/modelOverlay/traces";
import { MODEL_COLORS, type OverlayPose } from "@/lib/modelOverlay/core";
import type { OverlayModel } from "@/stores/modelOverlayStore";
import { makeVideo } from "./modelOverlayTestData";

const video = makeVideo();

function pose(xy: number[], trackName: string | null = null, score: number | null = 0.9): OverlayPose {
  return { xy: Float64Array.from(xy), score, trackName };
}

function model(id: string, frames: Map<number, OverlayPose[]> | PoseStore): OverlayModel {
  return {
    id,
    name: id,
    source: id,
    color: MODEL_COLORS[0],
    visible: true,
    video,
    frames,
    trackNames: trackNamesOf(frames),
  };
}

/** Seeded random poses: `nModels` models, 2 animals, 3 nodes, some frames missing, some far off. */
function randomModels(seed: number, nModels: number, nFrames: number, tracked: boolean): Map<number, OverlayPose[]>[] {
  let s = seed;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  return Array.from({ length: nModels }, () => {
    const frames = new Map<number, OverlayPose[]>();
    for (let f = 0; f < nFrames; f++) {
      if (rand() < 0.2) continue;
      const poses: OverlayPose[] = [];
      for (let a = 0; a < 2; a++) {
        const off = rand() < 0.1 ? 30 * rand() : rand();
        const xy = [100 + a * 300 + off, 100, 110 + a * 300 + off, 110, rand() < 0.1 ? NaN : 120 + a * 300, 120];
        poses.push(pose(xy, tracked ? `t${a}` : null));
      }
      frames.set(f, rand() < 0.5 ? poses : poses.reverse());
    }
    return frames;
  });
}

/** The pre-index ◀ ▶: check every candidate frame in order. */
function bruteNext(models: OverlayModel[], threshold: number, from: number, dir: 1 | -1): number | null {
  const byTrack = shownModelsShareTracks(models, video);
  const all = new Set<number>();
  for (const m of models) for (const f of m.frames.keys()) all.add(f);
  const frames = [...all].filter((f) => (dir === 1 ? f > from : f < from)).sort((a, b) => (a - b) * dir);
  for (const f of frames) if (frameDisagreements(modelOverlayLayers(models, video, f), byTrack, threshold).length > 0) return f;
  return null;
}

describe("PoseStore", () => {
  // Poses can arrive in any frame order; the store sorts frames but keeps the order on each frame.
  it("sorts frames and keeps the order within a frame", () => {
    const b = new PoseStoreBuilder(1, 1);
    b.add(5, [1, 2], 0.5, "a");
    b.add(2, [3, 4], null, null);
    b.add(5, [5, 6], 0.7, "b");
    const store = b.build();
    expect([...store.keys()]).toEqual([2, 5]);
    expect(store.get(5)!.map((p) => [...p.xy])).toEqual([
      [1, 2],
      [5, 6],
    ]);
    expect(store.get(2)![0].score).toBeNull();
    expect(store.get(5)![1].trackName).toBe("b");
    expect(store.has(3)).toBe(false);
    expect(store.get(3)).toBeUndefined();
    expect(poseCountOn(store, 5)).toBe(2);
    expect([...store.trackNames()].sort()).toEqual(["a", "b"]);
  });

  // A repaint asks for the same frame several times: it gets the same pose objects back.
  it("returns the same poses for the frame on screen", () => {
    const store = PoseStore.from(new Map([[0, [pose([1, 2])]]]));
    expect(store.get(0)).toBe(store.get(0)!);
  });
});

describe("disagreement index", () => {
  beforeEach(() => clearDisagreementIndexCache());

  // ◀ ▶ through the index must land on exactly the frames the old frame-by-frame search found.
  for (const tracked of [false, true]) {
    it(`matches the frame-by-frame search (${tracked ? "tracked" : "untracked"})`, () => {
      const raw = randomModels(tracked ? 7 : 3, 3, 120, tracked);
      const models = raw.map((m, i) => model(`m${i}`, i === 0 ? m : PoseStore.from(m)));
      for (const threshold of [2, 8, 20]) {
        for (const from of [-1, 0, 37, 60, 119, 200]) {
          for (const dir of [1, -1] as const) {
            const index = disagreementIndexFor(models, video);
            expect(nextDisagreement(index, threshold, from, dir)).toBe(bruteNext(models, threshold, from, dir));
          }
        }
      }
    });
  }

  // The index is shared and filled once; changing the threshold reuses it.
  it("is reused across thresholds and lists every disagreement frame", () => {
    const models = randomModels(11, 2, 80, false).map((m, i) => model(`m${i}`, PoseStore.from(m)));
    const index = disagreementIndexFor(models, video);
    expect(fillIndex(index, Infinity)).toBe(true);
    expect(disagreementIndexFor(models, video)).toBe(index);
    const expected: number[] = [];
    let f: number | null = -1;
    while ((f = bruteNext(models, 5, f, 1)) !== null) expected.push(f);
    expect(disagreementFrames(index, 5)).toEqual(expected);
  });

  // One model shown: nothing to compare, so ◀ ▶ find nothing.
  it("finds nothing with fewer than two models", () => {
    const [m] = randomModels(1, 1, 20, false);
    expect(nextDisagreement(disagreementIndexFor([model("a", m)], video), 0, -1, 1)).toBeNull();
  });
});

describe("compact traces", () => {
  // Traces from the compact store must equal traces from plain maps (same models, same animal numbers).
  it("gives the same traces for a store and a map", async () => {
    const raw = randomModels(5, 3, 60, false);
    const asMaps = raw.map((m, i) => model(`m${i}`, m));
    const asStores = raw.map((m, i) => model(`m${i}`, PoseStore.from(m)));
    const a = buildAnimalIndex(asMaps);
    const b = await buildAnimalIndexAsync(asStores, { sliceMs: 0 });
    expect(b!.count).toBe(a.count);
    for (let animal = 0; animal < a.count; animal++) {
      for (const node of [0, 2]) {
        expect(buildTraces(asStores, node, { kind: "animal", index: animal }, b!)).toEqual(
          buildTraces(asMaps, node, { kind: "animal", index: animal }, a)
        );
      }
    }
  });

  // A tracked model's line follows the track whether its poses are in a map or the store.
  it("follows a track in the store", () => {
    const raw = randomModels(9, 2, 30, true);
    expect(buildTraces(raw.map((m, i) => model(`m${i}`, PoseStore.from(m))), 1, { kind: "track", name: "t1" })).toEqual(
      buildTraces(raw.map((m, i) => model(`m${i}`, m)), 1, { kind: "track", name: "t1" })
    );
  });

  // Building the animal index can be stopped (traces closed) and then gives nothing.
  it("stops when aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const raw = randomModels(2, 2, 10, false);
    expect(await buildAnimalIndexAsync(raw.map((m, i) => model(`m${i}`, m)), { signal: ctrl.signal })).toBeNull();
  });
});
