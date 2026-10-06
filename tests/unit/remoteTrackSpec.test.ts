import { describe, it, expect } from "../bun-test";
import { buildRemoteTrackSpecs, type RemoteTrackSpecContext } from "@/lib/remoteTrackSpec";
import { buildPostTrainingInferenceConfig } from "@/stores/trainingStore";
import type { InferenceConfig } from "@/stores/inferenceStore";

function makeConfig(frameRange: InferenceConfig["frameRange"], videoIndex: number | "all" = "all") {
  return {
    ...buildPostTrainingInferenceConfig({
      modelType: "single_animal",
      modelPaths: ["/worker/model"],
      inferenceTarget: typeof frameRange === "string" ? frameRange : "all_videos",
      videoIndex,
    }),
    frameRange,
  };
}

function makeCtx(overrides: Partial<RemoteTrackSpecContext> = {}): RemoteTrackSpecContext {
  return {
    dataPath: "/worker/labels.slp",
    pathMappings: {},
    videoFrameCounts: [100, 100, 100],
    currentFrameIdx: 5,
    activeVideoFrameCount: 100,
    ...overrides,
  };
}

describe("buildRemoteTrackSpecs — unrestricted (allowedVideoIndices omitted, existing behavior)", () => {
  it("'all_videos' (an implicit all-scope target): one spec, no video_index", () => {
    const specs = buildRemoteTrackSpecs(makeConfig("all_videos"), makeCtx());
    expect(specs).toHaveLength(1);
    expect(specs[0].video_index).toBeUndefined();
  });

  it("'suggestions': one spec, frame_filter 'suggested', no video_index", () => {
    const specs = buildRemoteTrackSpecs(makeConfig("suggestions"), makeCtx());
    expect(specs).toHaveLength(1);
    expect(specs[0].frame_filter).toBe("suggested");
    expect(specs[0].video_index).toBeUndefined();
  });

  it("'video': one spec pinned to the current video index", () => {
    const specs = buildRemoteTrackSpecs(makeConfig("video", 1), makeCtx());
    expect(specs).toEqual([expect.objectContaining({ video_index: 1 })]);
  });

  it("'frame': one spec with the current frame and video index", () => {
    const specs = buildRemoteTrackSpecs(makeConfig("frame", 2), makeCtx({ currentFrameIdx: 42 }));
    expect(specs).toEqual([expect.objectContaining({ video_index: 2, frames: "42" })]);
  });

  it("'random': one spec per non-empty video, each with sampled frames", () => {
    const specs = buildRemoteTrackSpecs(
      makeConfig("random"),
      makeCtx({ videoFrameCounts: [10, 0, 10], random: () => 0.5 }),
    );
    expect(specs.map((s) => s.video_index)).toEqual([0, 2]); // video 1 skipped (empty)
  });

  it("a frame-range object target: one spec with 'start-end' frames pinned to the current video", () => {
    const specs = buildRemoteTrackSpecs(makeConfig({ start: 10, end: 20 }, 0), makeCtx());
    expect(specs).toEqual([expect.objectContaining({ video_index: 0, frames: "10-20" })]);
  });
});

describe("buildRemoteTrackSpecs — allowedVideoIndices (PR3a restricted-coverage post-training inference)", () => {
  it("an all-scope target emits one spec per allowed video, each pinned via video_index", () => {
    const specs = buildRemoteTrackSpecs(
      makeConfig("suggestions"),
      makeCtx({ allowedVideoIndices: [0, 2] }),
    );
    expect(specs.map((s) => s.video_index)).toEqual([0, 2]);
    expect(specs.every((s) => s.frame_filter === "suggested")).toBe(true);
  });

  it("an all-scope target with no allowed videos returns no specs", () => {
    const specs = buildRemoteTrackSpecs(makeConfig("all_videos"), makeCtx({ allowedVideoIndices: [] }));
    expect(specs).toEqual([]);
  });

  it("'random' additionally filters out disallowed videos (on top of the existing empty-video filter)", () => {
    const specs = buildRemoteTrackSpecs(
      makeConfig("random"),
      makeCtx({ videoFrameCounts: [10, 10, 10], allowedVideoIndices: [1], random: () => 0.5 }),
    );
    expect(specs.map((s) => s.video_index)).toEqual([1]);
  });

  it("a single-video target whose video is allowed is unchanged", () => {
    const specs = buildRemoteTrackSpecs(
      makeConfig("video", 1),
      makeCtx({ allowedVideoIndices: [0, 1] }),
    );
    expect(specs).toEqual([expect.objectContaining({ video_index: 1 })]);
  });

  it("a single-video target whose video is NOT allowed is dropped entirely", () => {
    const specs = buildRemoteTrackSpecs(
      makeConfig("video", 1),
      makeCtx({ allowedVideoIndices: [0, 2] }),
    );
    expect(specs).toEqual([]);
  });

  it("a frame-range object target on a disallowed video is dropped", () => {
    const specs = buildRemoteTrackSpecs(
      makeConfig({ start: 10, end: 20 }, 1),
      makeCtx({ allowedVideoIndices: [0] }),
    );
    expect(specs).toEqual([]);
  });
});
