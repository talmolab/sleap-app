/**
 * Config suggestions must be derived from GROUND TRUTH only.
 *
 * Two related defects, both reproduced against a real project shape
 * (`labels_pr.test.0.slp` from a sleap-nn eval run: 148 frames, 293 PREDICTED
 * instances at 2 per frame, zero user instances):
 *
 *  1. `recommendPipeline` scanned `lf.userInstances`, got 0, and fell through
 *     its `maxInstances <= 1` branch to recommend "single_animal" with the
 *     reason "Only one animal per frame" — on a two-animal project. Absence of
 *     ground truth is not evidence of one animal.
 *  2. Frame size / channel count were read off the FIRST video with a shape,
 *     regardless of whether that video was ever labeled — so in an 8-video
 *     project where only video 6 carries labels, the suggestions described a
 *     video the model never sees.
 */

import { describe, it, expect } from "../bun-test";
import {
  Labels,
  LabeledFrame,
  Instance,
  PredictedInstance,
  Skeleton,
  Video,
} from "@talmolab/sleap-io.js";
import {
  computeInstanceSizeStats,
  detectVideoChannels,
  detectVideoDimensions,
  hasUserLabeledInstances,
} from "@/lib/modelStats";
import {
  recommendPipeline,
  type LabelsLike,
} from "@/components/panels/TrainingPanel";

const skeleton = new Skeleton({ nodes: ["a", "b"], edges: [["a", "b"]] });

/** A video of a given size; `channels` defaults to grayscale. */
function video(
  w: number,
  h: number,
  channels = 1,
  frames = 100
): Video {
  return new Video({
    filename: `v_${w}x${h}.mp4`,
    openBackend: false,
    backendMetadata: { shape: [frames, h, w, channels] },
  });
}

/** Two points `size` apart, so the instance's bbox side is `size`. */
function twoPoints(x: number, y: number, size: number): number[][] {
  return [
    [x, y],
    [x + size, y + size],
  ];
}

function userInst(x: number, y: number, size: number): Instance {
  return Instance.fromNumpy({ pointsData: twoPoints(x, y, size), skeleton });
}

function predInst(x: number, y: number, size: number): PredictedInstance {
  return PredictedInstance.fromNumpy({
    pointsData: twoPoints(x, y, size),
    skeleton,
    score: 0.9,
  });
}

describe("hasUserLabeledInstances", () => {
  it("is false for a predictions-only project, despite having labeledFrames", () => {
    const v = video(640, 480);
    const labels = new Labels({
      videos: [v],
      skeletons: [skeleton],
      labeledFrames: Array.from({ length: 5 }, (_, i) =>
        new LabeledFrame({
          video: v,
          frameIdx: i,
          instances: [predInst(10, 10, 40), predInst(100, 100, 40)],
        })
      ),
    });
    // The distinction that caused the bug: frames exist, ground truth does not.
    expect(labels.labeledFrames.length).toBe(5);
    expect(hasUserLabeledInstances(labels)).toBe(false);
  });

  it("is true once any frame carries a user instance", () => {
    const v = video(640, 480);
    const labels = new Labels({
      videos: [v],
      skeletons: [skeleton],
      labeledFrames: [
        new LabeledFrame({ video: v, frameIdx: 0, instances: [predInst(10, 10, 40)] }),
        new LabeledFrame({ video: v, frameIdx: 1, instances: [userInst(10, 10, 40)] }),
      ],
    });
    expect(hasUserLabeledInstances(labels)).toBe(true);
  });

  it("is false for an empty project", () => {
    expect(hasUserLabeledInstances(new Labels())).toBe(false);
    expect(hasUserLabeledInstances(null)).toBe(false);
  });
});

describe("recommendPipeline", () => {
  /** The real shape of labels_pr.test.0.slp: 2 predicted instances/frame, no GT. */
  function predictionsOnly(): LabelsLike {
    const v = video(640, 480);
    return new Labels({
      videos: [v],
      skeletons: [skeleton],
      labeledFrames: Array.from({ length: 148 }, (_, i) =>
        new LabeledFrame({
          video: v,
          frameIdx: i,
          instances: [predInst(10, 10, 40), predInst(300, 300, 40)],
        })
      ),
    }) as unknown as LabelsLike;
  }

  it("suggests NOTHING for a predictions-only project", () => {
    // Was: { recommended: "single_animal", reason: "Only one animal per frame" }
    // on a project that plainly has two animals per frame.
    expect(recommendPipeline(predictionsOnly())).toBeNull();
  });

  it("still suggests single_animal for genuinely single-animal ground truth", () => {
    const v = video(640, 480);
    const labels = new Labels({
      videos: [v],
      skeletons: [skeleton],
      labeledFrames: Array.from({ length: 10 }, (_, i) =>
        new LabeledFrame({
          video: v,
          frameIdx: i,
          instances: [userInst(10, 10, 200)],
        })
      ),
    }) as unknown as LabelsLike;
    expect(recommendPipeline(labels)?.recommended).toBe("single_animal");
  });

  it("sees two animals when the ground truth has two", () => {
    const v = video(640, 480);
    const labels = new Labels({
      videos: [v],
      skeletons: [skeleton],
      labeledFrames: Array.from({ length: 10 }, (_, i) =>
        new LabeledFrame({
          video: v,
          frameIdx: i,
          instances: [userInst(10, 10, 40), userInst(300, 300, 40)],
        })
      ),
    }) as unknown as LabelsLike;
    expect(recommendPipeline(labels)?.recommended).not.toBe("single_animal");
  });

  it("returns null for an empty project", () => {
    expect(recommendPipeline(new Labels() as unknown as LabelsLike)).toBeNull();
    expect(recommendPipeline(null)).toBeNull();
  });
});

describe("video-derived suggestion inputs use the labeled video", () => {
  /** 3 videos; only the LAST is user-labeled — the 8-video/one-labeled shape. */
  function onlyLastLabeled() {
    const unlabeledA = video(4096, 2160, 3); // big + RGB, would skew everything
    const unlabeledB = video(1920, 1080, 3);
    const labeled = video(640, 480, 1);
    return new Labels({
      videos: [unlabeledA, unlabeledB, labeled],
      skeletons: [skeleton],
      labeledFrames: [
        new LabeledFrame({
          video: labeled,
          frameIdx: 0,
          instances: [userInst(10, 10, 40)],
        }),
      ],
    });
  }

  it("reads dimensions from the labeled video, not the first one", () => {
    expect(detectVideoDimensions(onlyLastLabeled())).toEqual({
      height: 480,
      width: 640,
    });
  });

  it("reads channels from the labeled video, not the first one", () => {
    expect(detectVideoChannels(onlyLastLabeled())).toBe(1);
  });

  it("scopes maxFrameDim to the labeled video", () => {
    // 640, not 4096 — the animal-size ratios that drive the backbone tier and
    // centroid scale are relative to this.
    expect(computeInstanceSizeStats(onlyLastLabeled())?.maxFrameDim).toBe(640);
  });

  it("falls back to every video when nothing is user-labeled", () => {
    const v = video(1280, 720, 3);
    const labels = new Labels({
      videos: [v],
      skeletons: [skeleton],
      labeledFrames: [
        new LabeledFrame({ video: v, frameIdx: 0, instances: [predInst(1, 1, 5)] }),
      ],
    });
    // A dimension beats a blank in the UI, even with no ground truth.
    expect(detectVideoDimensions(labels)).toEqual({ height: 720, width: 1280 });
    expect(detectVideoChannels(labels)).toBe(3);
  });

  it("derives no size stats at all from predictions", () => {
    const v = video(640, 480);
    const labels = new Labels({
      videos: [v],
      skeletons: [skeleton],
      labeledFrames: [
        new LabeledFrame({ video: v, frameIdx: 0, instances: [predInst(10, 10, 40)] }),
      ],
    });
    // null => callers fall back to the baseline preset (medium RF).
    expect(computeInstanceSizeStats(labels)).toBeNull();
  });
});
