/**
 * Unit tests for conflict clustering (A3).
 *
 * A merge conflict is a CONNECTED COMPONENT of the bipartite "within-5px" graph
 * over {base instances ∪ donor instances} on a shared frame — a base instance
 * can clash with several donors and vice versa. `buildClusters` turns the raw
 * matched pairs into those components; only instances that participate in a
 * match appear (non-matched instances aren't conflicts).
 */

import { describe, it, expect } from "../bun-test";
import {
  buildClusters,
  enumerateConflicts,
  compileDeletions,
  applyConflictResolutions,
} from "@/lib/mergeConflicts";
import { Labels, LabeledFrame, Instance, Video, Skeleton } from "@talmolab/sleap-io.js";

function makeSkeleton(name = "s"): Skeleton {
  const s = new Skeleton({ nodes: ["a", "b"], name });
  s.addEdge(s.nodes[0], s.nodes[1]);
  return s;
}
function makeVideo(filename: string): Video {
  return new Video({
    filename,
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });
}
function userInst(sk: Skeleton, x: number, y: number): Instance {
  return Instance.fromArray(
    [
      [x, y],
      [x + 1, y + 1],
    ],
    sk
  );
}
/** Base with one user instance at (10,10) on frame 0; donor video same basename. */
function baseWith(instances: Instance[]): { base: Labels; baseVideo: Video } {
  const sk = makeSkeleton();
  const baseVideo = makeVideo("/base/clip.mp4");
  const base = new Labels({
    labeledFrames: [
      new LabeledFrame({ video: baseVideo, frameIdx: 0, instances }),
    ],
    skeletons: [instances[0]?.skeleton ?? sk],
    videos: [baseVideo],
  });
  return { base, baseVideo };
}
function donorFrame(frameIdx: number, instances: Instance[]): Labels {
  const donorVideo = makeVideo("/other/clip.mp4"); // same basename -> matches
  return new Labels({
    labeledFrames: [new LabeledFrame({ video: donorVideo, frameIdx, instances })],
    skeletons: [instances[0]?.skeleton ?? makeSkeleton("d")],
    videos: [donorVideo],
  });
}

describe("buildClusters", () => {
  it("returns nothing for no matches", () => {
    expect(buildClusters([])).toEqual([]);
  });

  it("makes one cluster from a 1-to-1 pair", () => {
    expect(buildClusters([[0, 0]])).toEqual([{ baseIdxs: [0], donorIdxs: [0] }]);
  });

  it("keeps independent pairs as separate clusters", () => {
    const clusters = buildClusters([
      [0, 0],
      [1, 1],
    ]);
    expect(clusters).toEqual([
      { baseIdxs: [0], donorIdxs: [0] },
      { baseIdxs: [1], donorIdxs: [1] },
    ]);
  });

  it("groups one base clashing with two donors into a single cluster", () => {
    expect(
      buildClusters([
        [0, 0],
        [0, 1],
      ])
    ).toEqual([{ baseIdxs: [0], donorIdxs: [0, 1] }]);
  });

  it("groups two bases sharing one donor into a single cluster", () => {
    expect(
      buildClusters([
        [0, 0],
        [1, 0],
      ])
    ).toEqual([{ baseIdxs: [0, 1], donorIdxs: [0] }]);
  });

  it("merges a chain transitively into one cluster", () => {
    // b0-d0, b1-d0 (share d0), b1-d1  =>  {b0,b1} × {d0,d1}
    expect(
      buildClusters([
        [0, 0],
        [1, 0],
        [1, 1],
      ])
    ).toEqual([{ baseIdxs: [0, 1], donorIdxs: [0, 1] }]);
  });
});

describe("enumerateConflicts", () => {
  const sk = makeSkeleton("shared");

  it("flags a within-5px user clash on a shared frame", async () => {
    const { base, baseVideo } = baseWith([userInst(sk, 10, 10)]);
    const donor = donorFrame(0, [userInst(sk, 12, 12)]); // ~2.8px away

    const conflicts = await enumerateConflicts(base, donor);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].video).toBe(baseVideo); // mapped to the BASE video
    expect(conflicts[0].frameIdx).toBe(0);
    expect(conflicts[0].baseInstances).toHaveLength(1);
    expect(conflicts[0].donorInstances).toHaveLength(1);
    expect(conflicts[0].distance).toBeGreaterThan(0);
    expect(conflicts[0].distance).toBeLessThan(5);
  });

  it("records each base instance's frame index for coloring", async () => {
    // Base frame 0 has two animals: A at (10,10) [frame idx 0], B at (300,300)
    // [frame idx 1]. The donor clashes with each → two conflicts carrying the
    // distinct frame indices, so the preview colors them differently.
    const baseVideo = makeVideo("/base/clip.mp4");
    const base = new Labels({
      labeledFrames: [
        new LabeledFrame({
          video: baseVideo,
          frameIdx: 0,
          instances: [userInst(sk, 10, 10), userInst(sk, 300, 300)],
        }),
      ],
      skeletons: [sk],
      videos: [baseVideo],
    });
    const donor = donorFrame(0, [userInst(sk, 12, 12), userInst(sk, 302, 302)]);
    const conflicts = await enumerateConflicts(base, donor);
    expect(conflicts).toHaveLength(2);
    const indices = conflicts.flatMap((c) => c.baseColorIndices).sort();
    expect(indices).toEqual([0, 1]);
  });

  it("does not flag a donor instance farther than the threshold", async () => {
    const { base } = baseWith([userInst(sk, 10, 10)]);
    const donor = donorFrame(0, [userInst(sk, 50, 50)]); // ~56px away
    expect(await enumerateConflicts(base, donor)).toHaveLength(0);
  });

  it("does not flag a donor-only frame (no base frame to clash with)", async () => {
    const { base } = baseWith([userInst(sk, 10, 10)]);
    const donor = donorFrame(5, [userInst(sk, 10, 10)]); // frame 5 absent in base
    expect(await enumerateConflicts(base, donor)).toHaveLength(0);
  });

  it("groups two donors clashing with one base into a single cluster", async () => {
    const { base } = baseWith([userInst(sk, 10, 10)]);
    const donor = donorFrame(0, [userInst(sk, 11, 11), userInst(sk, 12, 12)]);
    const conflicts = await enumerateConflicts(base, donor);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].baseInstances).toHaveLength(1);
    expect(conflicts[0].donorInstances).toHaveLength(2);
  });
});

function instancesAt(labels: Labels, video: Video, frameIdx = 0): Instance[] {
  return labels.find({ video, frameIdx })[0]?.instances ?? [];
}
// x-coord of an instance's first node (fixtures place nodes at (x,y),(x+1,y+1)).
const x0 = (inst: Instance): number => inst.numpy()[0][0];

describe("compileDeletions", () => {
  it("maps choices to loser instances (base→drop donors, donor→drop base, both→none)", async () => {
    const sk = makeSkeleton("shared");
    const { base } = baseWith([userInst(sk, 10, 10)]);
    const donor = donorFrame(0, [userInst(sk, 12, 12)]);
    const [c] = await enumerateConflicts(base, donor);

    const keepBase = compileDeletions([{ conflict: c, choice: "base" }]);
    expect(keepBase.base.size).toBe(0);
    expect(keepBase.donor.size).toBe(1);

    const keepDonor = compileDeletions([{ conflict: c, choice: "donor" }]);
    expect(keepDonor.base.size).toBe(1);
    expect(keepDonor.donor.size).toBe(0);

    const both = compileDeletions([{ conflict: c, choice: "both" }]);
    expect(both.base.size).toBe(0);
    expect(both.donor.size).toBe(0);
  });
});

describe("applyConflictResolutions", () => {
  const sk = makeSkeleton("shared");

  it("keep-both keeps base + donor on the shared frame (≡ A2 keep_both)", async () => {
    const { base, baseVideo } = baseWith([userInst(sk, 10, 10)]);
    const donor = donorFrame(0, [userInst(sk, 12, 12)]);
    const conflicts = await enumerateConflicts(base, donor);
    await applyConflictResolutions(
      base,
      donor,
      conflicts.map((c) => ({ conflict: c, choice: "both" as const }))
    );
    expect(instancesAt(base, baseVideo)).toHaveLength(2);
  });

  it("keep-base drops the donor instance", async () => {
    const { base, baseVideo } = baseWith([userInst(sk, 10, 10)]);
    const donor = donorFrame(0, [userInst(sk, 12, 12)]);
    const conflicts = await enumerateConflicts(base, donor);
    await applyConflictResolutions(
      base,
      donor,
      conflicts.map((c) => ({ conflict: c, choice: "base" as const }))
    );
    const insts = instancesAt(base, baseVideo);
    expect(insts).toHaveLength(1);
    expect(x0(insts[0])).toBe(10); // the base pose survived
  });

  it("keep-donor drops the base instance and adds the donor", async () => {
    const { base, baseVideo } = baseWith([userInst(sk, 10, 10)]);
    const donor = donorFrame(0, [userInst(sk, 12, 12)]);
    const conflicts = await enumerateConflicts(base, donor);
    await applyConflictResolutions(
      base,
      donor,
      conflicts.map((c) => ({ conflict: c, choice: "donor" as const }))
    );
    const insts = instancesAt(base, baseVideo);
    expect(insts).toHaveLength(1);
    expect(x0(insts[0])).toBe(12); // the donor pose replaced the base
  });

  it("keep-base on a multi-donor cluster drops all donors", async () => {
    const { base, baseVideo } = baseWith([userInst(sk, 10, 10)]);
    const donor = donorFrame(0, [userInst(sk, 11, 11), userInst(sk, 12, 12)]);
    const conflicts = await enumerateConflicts(base, donor);
    await applyConflictResolutions(
      base,
      donor,
      conflicts.map((c) => ({ conflict: c, choice: "base" as const }))
    );
    expect(instancesAt(base, baseVideo)).toHaveLength(1);
  });

  it("passes non-conflicting donor instances through even on a conflict frame", async () => {
    const { base, baseVideo } = baseWith([userInst(sk, 10, 10)]);
    // d@(12,12) conflicts with base; e@(500,500) does not.
    const donor = donorFrame(0, [userInst(sk, 12, 12), userInst(sk, 500, 500)]);
    const conflicts = await enumerateConflicts(base, donor);
    expect(conflicts).toHaveLength(1);
    await applyConflictResolutions(
      base,
      donor,
      conflicts.map((c) => ({ conflict: c, choice: "base" as const }))
    );
    const insts = instancesAt(base, baseVideo);
    expect(insts).toHaveLength(2); // base pose + the non-conflicting donor
    expect(insts.some((i) => x0(i) === 500)).toBe(true);
  });
});
