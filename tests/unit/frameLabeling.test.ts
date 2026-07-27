/**
 * The app's canonical "did a human label this frame" predicate.
 *
 * The point of these helpers is that a USER-placed centroid (or bbox / mask /
 * ROI / negative-frame flag) makes a frame labeled — not only a skeleton
 * instance. They delegate to io.js's LabeledFrame.isUserLabeled (mirrors Python
 * LabeledFrame.is_user_labeled), so the app agrees with io.js instead of its old
 * instance-only check. Constructing real io.js LabeledFrames here keeps this a
 * thin integration test over that contract.
 */
import { describe, it, expect } from "../bun-test";
import {
  LabeledFrame,
  UserCentroid,
  PredictedCentroid,
  type Video,
} from "@talmolab/sleap-io.js";
import { isUserLabeledFrame, frameHasUserLabels } from "@/lib/frameLabeling";

// isUserLabeled never touches the video, so a bare stub is fine.
const video = {} as unknown as Video;
const frame = (opts: object = {}) =>
  new LabeledFrame({ video, frameIdx: 0, ...opts });

describe("isUserLabeledFrame", () => {
  it("is false for an empty frame (no instances or annotations)", () => {
    expect(isUserLabeledFrame(frame())).toBe(false);
  });

  it("is true for a frame with a USER centroid but no instance", () => {
    // The active-learning case: a human placed a centroid, no skeleton pose.
    const c = new UserCentroid({ x: 1, y: 2 });
    expect(isUserLabeledFrame(frame({ centroids: [c] }))).toBe(true);
  });

  it("is false for a frame with only a PREDICTED centroid", () => {
    const c = new PredictedCentroid({ x: 1, y: 2, score: 0.9 });
    expect(isUserLabeledFrame(frame({ centroids: [c] }))).toBe(false);
  });

  it("is true for a negative (background) frame", () => {
    expect(isUserLabeledFrame(frame({ isNegative: true }))).toBe(true);
  });
});

describe("frameHasUserLabels", () => {
  const labeled = frame({ centroids: [new UserCentroid({ x: 1, y: 2 })] });
  const found = { find: () => [labeled] } as never;

  it("is true when find() returns a user-labeled frame", () => {
    expect(frameHasUserLabels(found, video, 0)).toBe(true);
  });

  it("is false when no frame is found", () => {
    expect(frameHasUserLabels({ find: () => [] } as never, video, 0)).toBe(
      false,
    );
  });

  it("is false for null labels", () => {
    expect(frameHasUserLabels(null, video, 0)).toBe(false);
  });
});
