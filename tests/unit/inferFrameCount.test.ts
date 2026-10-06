/**
 * Unit tests for the seekbar's fallback frame-count inference. Only used when a
 * video's own frame count is unknown; must not spread every frame index as a
 * function argument (that made node-drag stall on many-thousand-frame projects).
 */

import { describe, it, expect } from "../bun-test";
import { Skeleton, Video, Labels, LabeledFrame, Instance } from "@talmolab/sleap-io.js";
import { inferFrameCount } from "@/lib/inferFrameCount";

function makeVideo(filename: string): Video {
  return new Video({
    filename,
    backendMetadata: { shape: [10, 100, 100, 3] },
    openBackend: false,
  });
}

function labeledFrame(video: Video, idx: number, skeleton: Skeleton): LabeledFrame {
  const lf = new LabeledFrame({ video, frameIdx: idx });
  lf.instances.push(Instance.empty({ skeleton }));
  return lf;
}

describe("inferFrameCount", () => {
  it("returns 0 for null labels or video", () => {
    expect(inferFrameCount(null, null)).toBe(0);
    expect(inferFrameCount(null, makeVideo("v.mp4"))).toBe(0);
  });

  it("returns the highest labeled frameIdx + 1 for the video", () => {
    const skeleton = new Skeleton({ nodes: ["a"], name: "s" });
    const video = makeVideo("v.mp4");
    const labels = new Labels({
      videos: [video],
      skeletons: [skeleton],
      labeledFrames: [
        labeledFrame(video, 0, skeleton),
        labeledFrame(video, 5, skeleton),
        labeledFrame(video, 3, skeleton),
      ],
    });
    expect(inferFrameCount(labels, video)).toBe(6);
  });

  it("floors at 0 like the old Math.max(0, …): no labeled frames → 1", () => {
    const skeleton = new Skeleton({ nodes: ["a"], name: "s" });
    const video = makeVideo("v.mp4");
    const labels = new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [] });
    expect(inferFrameCount(labels, video)).toBe(1);
  });
});
