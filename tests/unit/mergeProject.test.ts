/**
 * Tests for the Merge-into-Project pure helpers (src/lib/mergeProject.ts).
 *
 * THIN-INTEGRATION: io's `Labels.match` / `Labels.merge` are exhaustively tested
 * upstream, so we don't re-test their internals. We assert:
 *   1. STRATEGY MAP — UI choice → the exact sleap-io.js FrameStrategy string.
 *   2. PREVIEW — `summarizeMatch` derives correct matched/new counts + the
 *      skeleton-mismatch BLOCK from a REAL `MatchResult`.
 *   3. SUMMARY — `mergeResultSummary` formats a MergeResult into the toast line.
 */

import { describe, it, expect } from "../bun-test";
import {
  mergeStrategyToFrameStrategy,
  summarizeMatch,
  isMergeBlockedBySkeleton,
  mergeResultSummary,
  type MergeStrategyChoice,
} from "@/lib/mergeProject";
import type { MergeResult } from "@talmolab/sleap-io.js";
import { Labels, Skeleton, Video, Track } from "@talmolab/sleap-io.js";

function makeSkeleton(nodes = ["node_0", "node_1"], name = "test"): Skeleton {
  const s = new Skeleton({ nodes, name });
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

describe("mergeStrategyToFrameStrategy", () => {
  const cases: Array<[MergeStrategyChoice, string]> = [
    ["smart", "auto"],
    ["keep_both", "keep_both"],
    ["new_wins", "keep_new"],
    ["base_wins", "keep_original"],
  ];
  for (const [choice, expected] of cases) {
    it(`maps ${choice} -> ${expected}`, () => {
      expect(mergeStrategyToFrameStrategy(choice)).toBe(expected);
    });
  }
});

describe("summarizeMatch", () => {
  it("counts matched vs new videos/skeletons/tracks against a real MatchResult", async () => {
    const skel = makeSkeleton();
    const base = new Labels({
      labeledFrames: [],
      skeletons: [skel],
      videos: [makeVideo("/base/a.mp4")],
      tracks: [new Track("fly")],
    });
    // Donor: same skeleton (structurally), shares a.mp4 (same basename, other
    // path) + a brand-new video; shares track "fly" by name + a new "fly2".
    const donor = new Labels({
      labeledFrames: [],
      skeletons: [makeSkeleton()],
      videos: [makeVideo("/compute/a.mp4"), makeVideo("/compute/new.mp4")],
      tracks: [new Track("fly"), new Track("fly2")],
    });

    const match = await base.match(donor, { video: "basename", track: "name" });
    const preview = summarizeMatch(match);

    expect(preview.videosMatched).toBe(1);
    expect(preview.videosNew).toBe(1);
    expect(preview.newVideoNames).toEqual(["new.mp4"]);
    expect(preview.skeletonsMatched).toBe(1);
    expect(preview.skeletonsNew).toBe(0);
    expect(preview.tracksMatched).toBe(1);
    expect(preview.tracksNew).toBe(1);
    expect(preview.skeletonBlocked).toBe(false);
  });

  it("flags a skeleton mismatch as blocked", async () => {
    const base = new Labels({
      labeledFrames: [],
      skeletons: [makeSkeleton(["a", "b"])],
      videos: [makeVideo("/base/a.mp4")],
    });
    const donor = new Labels({
      labeledFrames: [],
      skeletons: [makeSkeleton(["x", "y", "z"], "other")],
      videos: [makeVideo("/base/a.mp4")],
    });

    const match = await base.match(donor, { video: "basename" });
    expect(isMergeBlockedBySkeleton(match)).toBe(true);
    expect(summarizeMatch(match).skeletonBlocked).toBe(true);
  });
});

describe("mergeResultSummary", () => {
  const mk = (o: Partial<MergeResult>) =>
    ({
      instancesAdded: 0,
      framesMerged: 0,
      conflicts: [],
      errors: [],
      ...o,
    }) as unknown as MergeResult;

  it("pluralizes the clean case", () => {
    expect(mergeResultSummary(mk({ instancesAdded: 1, framesMerged: 1 }))).toBe(
      "Merged 1 instance across 1 frame."
    );
    expect(mergeResultSummary(mk({ instancesAdded: 3, framesMerged: 2 }))).toBe(
      "Merged 3 instances across 2 frames."
    );
  });

  it("appends conflicts and errors when present", () => {
    expect(
      mergeResultSummary(
        mk({
          instancesAdded: 5,
          framesMerged: 4,
          conflicts: [{}, {}] as unknown as MergeResult["conflicts"],
        })
      )
    ).toBe("Merged 5 instances across 4 frames, 2 conflicts resolved.");
    expect(
      mergeResultSummary(
        mk({
          instancesAdded: 0,
          framesMerged: 0,
          errors: [new Error("x")] as unknown as MergeResult["errors"],
        })
      )
    ).toBe("Merged 0 instances across 0 frames, 1 error.");
  });
});
