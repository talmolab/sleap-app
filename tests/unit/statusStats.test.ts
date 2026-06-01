/**
 * Tests for the status-bar stat helpers (pure logic ported from PyQt
 * updateStatusMessage / get_labeled_frame_count / get_instances_to_show).
 */
import { describe, it, expect } from "../bun-test";
import { instancesToShowCount, computeStatusStats } from "@/lib/statusStats";
import type { Labels, Video, LabeledFrame } from "@/types";

/** A labeled frame whose getters mimic sleap-io.js semantics. */
function mockLF(opts: {
  video: Video;
  user?: number;
  unusedPred?: number;
  hasUser?: boolean;
  hasPred?: boolean;
  isNegative?: boolean;
}): LabeledFrame {
  return {
    video: opts.video,
    userInstances: new Array(opts.user ?? 0).fill({}),
    unusedPredictions: new Array(opts.unusedPred ?? 0).fill({}),
    hasUserInstances: opts.hasUser ?? (opts.user ?? 0) > 0,
    hasPredictedInstances: opts.hasPred ?? false,
    isNegative: opts.isNegative ?? false,
  } as unknown as LabeledFrame;
}

const vidA = { filename: "a.mp4", shape: [100, 1, 1, 1] } as unknown as Video;
const vidB = { filename: "b.mp4", shape: [50, 1, 1, 1] } as unknown as Video;

function mockLabels(videos: Video[], frames: LabeledFrame[]): Labels {
  return { videos, labeledFrames: frames } as unknown as Labels;
}

describe("instancesToShowCount", () => {
  it("returns 0 for null frame", () => {
    expect(instancesToShowCount(null)).toBe(0);
  });

  it("counts user instances plus unused predictions", () => {
    const lf = mockLF({ video: vidA, user: 2, unusedPred: 1 });
    expect(instancesToShowCount(lf)).toBe(3);
  });

  it("excludes predictions superseded by a user instance (only unused counted)", () => {
    // 1 user instance, 0 unused predictions => 1 (the superseded prediction is not counted)
    const lf = mockLF({ video: vidA, user: 1, unusedPred: 0 });
    expect(instancesToShowCount(lf)).toBe(1);
  });
});

describe("computeStatusStats", () => {
  it("returns zeros / -1 for null labels", () => {
    const s = computeStatusStats(null, null, null);
    expect(s).toEqual({
      videoIndex: -1,
      totalVideos: 0,
      userInVideo: 0,
      userInProject: 0,
      predictedInVideo: 0,
      predictedPct: 0,
    });
  });

  it("finds the video index by reference identity", () => {
    const labels = mockLabels([vidA, vidB], []);
    expect(computeStatusStats(labels, vidB, 50).videoIndex).toBe(1);
    expect(computeStatusStats(labels, vidA, 100).videoIndex).toBe(0);
    expect(computeStatusStats(labels, vidB, 50).totalVideos).toBe(2);
  });

  it("counts user frames in-video and in-project", () => {
    const frames = [
      mockLF({ video: vidA, user: 1, hasUser: true }),
      mockLF({ video: vidA, user: 1, hasUser: true }),
      mockLF({ video: vidB, user: 1, hasUser: true }),
      mockLF({ video: vidA, user: 0, hasUser: false }), // not user-labeled
    ];
    const labels = mockLabels([vidA, vidB], frames);
    const s = computeStatusStats(labels, vidA, 100);
    expect(s.userInVideo).toBe(2);
    expect(s.userInProject).toBe(3);
  });

  it("counts predicted frames in-video and computes percentage", () => {
    const frames = [
      mockLF({ video: vidA, hasPred: true }),
      mockLF({ video: vidA, hasPred: true }),
      mockLF({ video: vidB, hasPred: true }),
    ];
    const labels = mockLabels([vidA, vidB], frames);
    const s = computeStatusStats(labels, vidA, 100);
    expect(s.predictedInVideo).toBe(2);
    expect(s.predictedPct).toBeCloseTo(2.0, 5); // 2/100*100
  });

  it("predictedPct is 0 when totalFrames is null or 0", () => {
    const labels = mockLabels([vidA], [mockLF({ video: vidA, hasPred: true })]);
    expect(computeStatusStats(labels, vidA, null).predictedPct).toBe(0);
    expect(computeStatusStats(labels, vidA, 0).predictedPct).toBe(0);
  });
});
