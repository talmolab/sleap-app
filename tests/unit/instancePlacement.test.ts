import { describe, it, expect } from "vitest";
import {
  Instance,
  PredictedInstance,
  Skeleton,
  Video,
  LabeledFrame,
  Track,
} from "@talmolab/sleap-io.js";
import { placeInstance } from "@/lib/instancePlacement";

function makeSkeleton(): Skeleton {
  return new Skeleton({ nodes: ["A", "B"], name: "test" });
}

function makeVideo(): Video {
  return new Video({ filename: "test.mp4", openBackend: false });
}

function makeInstance(
  skeleton: Skeleton,
  coords: number[][],
  track?: Track | null
): Instance {
  const inst = Instance.fromArray(coords, skeleton);
  if (track !== undefined) inst.track = track;
  return inst;
}

function makePredicted(
  skeleton: Skeleton,
  coords: number[][],
  track?: Track | null
): PredictedInstance {
  const inst = PredictedInstance.fromArray(coords, skeleton, 0.9);
  if (track !== undefined) inst.track = track;
  return inst;
}

function makeLabeledFrame(
  video: Video,
  frameIdx: number,
  instances: Instance[]
): LabeledFrame {
  const lf = new LabeledFrame({ video, frameIdx });
  lf.instances = instances;
  return lf;
}

describe("placePriorFrame", () => {
  const skeleton = makeSkeleton();
  const video = makeVideo();
  const trackA = new Track("A");
  const trackB = new Track("B");
  const trackC = new Track("C");

  it("copies points and track from the prior frame user instance", () => {
    const priorInst = makeInstance(skeleton, [[100, 200], [300, 400]], trackA);
    const priorFrame = makeLabeledFrame(video, 0, [priorInst]);

    const result = placeInstance("prior_frame", skeleton, video, [], priorFrame);

    expect(result.points[0].xy).toEqual([100, 200]);
    expect(result.points[1].xy).toEqual([300, 400]);
    expect(result.track).toBe(trackA);
  });

  it("skips prior instances whose track is already on the current frame", () => {
    const priorA = makeInstance(skeleton, [[10, 10], [20, 20]], trackA);
    const priorB = makeInstance(skeleton, [[50, 50], [60, 60]], trackB);
    const priorFrame = makeLabeledFrame(video, 0, [priorA, priorB]);

    const existingA = makeInstance(skeleton, [[10, 10], [20, 20]], trackA);

    const result = placeInstance(
      "prior_frame", skeleton, video, [existingA], priorFrame
    );

    expect(result.points[0].xy).toEqual([50, 50]);
    expect(result.points[1].xy).toEqual([60, 60]);
    expect(result.track).toBe(trackB);
  });

  it("falls back to first candidate when all tracks are covered", () => {
    const priorA = makeInstance(skeleton, [[10, 10], [20, 20]], trackA);
    const priorB = makeInstance(skeleton, [[50, 50], [60, 60]], trackB);
    const priorFrame = makeLabeledFrame(video, 0, [priorA, priorB]);

    const existingA = makeInstance(skeleton, [[10, 10], [20, 20]], trackA);
    const existingB = makeInstance(skeleton, [[50, 50], [60, 60]], trackB);

    const result = placeInstance(
      "prior_frame", skeleton, video, [existingA, existingB], priorFrame
    );

    expect(result.points[0].xy).toEqual([10, 10]);
  });

  it("skips multiple covered tracks to find the first unmatched", () => {
    const priorA = makeInstance(skeleton, [[10, 10], [20, 20]], trackA);
    const priorB = makeInstance(skeleton, [[30, 30], [40, 40]], trackB);
    const priorC = makeInstance(skeleton, [[50, 50], [60, 60]], trackC);
    const priorFrame = makeLabeledFrame(video, 0, [priorA, priorB, priorC]);

    const existingA = makeInstance(skeleton, [[10, 10], [20, 20]], trackA);
    const existingB = makeInstance(skeleton, [[30, 30], [40, 40]], trackB);

    const result = placeInstance(
      "prior_frame", skeleton, video, [existingA, existingB], priorFrame
    );

    expect(result.points[0].xy).toEqual([50, 50]);
    expect(result.points[1].xy).toEqual([60, 60]);
  });

  it("prefers user instances over predictions on the prior frame", () => {
    const pred = makePredicted(skeleton, [[10, 10], [20, 20]], trackA);
    const user = makeInstance(skeleton, [[99, 99], [88, 88]], trackA);
    const priorFrame = makeLabeledFrame(video, 0, [pred, user]);

    const result = placeInstance("prior_frame", skeleton, video, [], priorFrame);

    expect(result.points[0].xy).toEqual([99, 99]);
    expect(result.points[1].xy).toEqual([88, 88]);
  });

  it("falls back to predictions when no user instances exist on prior frame", () => {
    const pred = makePredicted(skeleton, [[10, 10], [20, 20]], trackA);
    const priorFrame = makeLabeledFrame(video, 0, [pred]);

    const result = placeInstance("prior_frame", skeleton, video, [], priorFrame);

    expect(result.points[0].xy).toEqual([10, 10]);
  });

  it("handles trackless instances (copies first available, no track assigned)", () => {
    const priorInst = makeInstance(skeleton, [[42, 42], [84, 84]]);
    const priorFrame = makeLabeledFrame(video, 0, [priorInst]);

    const existing = makeInstance(skeleton, [[1, 1], [2, 2]], trackA);

    const result = placeInstance(
      "prior_frame", skeleton, video, [existing], priorFrame
    );

    expect(result.points[0].xy).toEqual([42, 42]);
    expect(result.track).toBeFalsy();
  });

  it("falls back to 'best' when prior frame is null", () => {
    const result = placeInstance("prior_frame", skeleton, video, [], null);

    expect(result).toBeInstanceOf(Instance);
    expect(result.points.length).toBe(2);
  });

  it("falls back to 'best' when prior frame has no placed points", () => {
    const emptyInst = Instance.empty({ skeleton });
    const priorFrame = makeLabeledFrame(video, 0, [emptyInst]);

    const result = placeInstance("prior_frame", skeleton, video, [], priorFrame);

    expect(result).toBeInstanceOf(Instance);
  });
});
