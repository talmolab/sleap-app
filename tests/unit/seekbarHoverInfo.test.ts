/**
 * Pure formatter for the seekbar hover-preview tooltip.
 *
 * Mirrors PyQt SLEAP's get_val_tooltip (sleap/gui/widgets/slider.py:1264-1300):
 * a "Frame N" header (1-based), one semantic line describing the frame's mark
 * (negative / user / prediction±track / suggested…), then predicted- and
 * user-instance counts (predicted first, only when > 0). We build real io.js
 * LabeledFrames so this stays a thin contract test over that formatter.
 */
import { describe, it, expect } from "../bun-test";
import {
  LabeledFrame,
  Instance,
  PredictedInstance,
  Skeleton,
  Track,
  type Video,
} from "@talmolab/sleap-io.js";
import { frameHoverInfo } from "@/lib/seekbarHoverInfo";

const video = {} as unknown as Video;

function makeSkeleton(): Skeleton {
  const s = new Skeleton({ nodes: ["a", "b"], name: "test" });
  s.addEdge(s.nodes[0], s.nodes[1]);
  return s;
}
const sk = makeSkeleton();

const userInst = () =>
  Instance.fromArray(
    [
      [1, 1],
      [2, 2],
    ],
    sk,
  );

const predInst = (track?: Track) => {
  const p = PredictedInstance.fromArray(
    [
      [1, 1],
      [2, 2],
    ],
    sk,
    0.9,
  );
  if (track) p.track = track;
  return p;
};

const frame = (opts: object = {}) =>
  new LabeledFrame({ video, frameIdx: 0, ...opts });

describe("frameHoverInfo", () => {
  it("shows a 1-based frame header (PyQt: Frame idx + 1)", () => {
    expect(frameHoverInfo(null, 0).lines).toEqual(["Frame 1"]);
    expect(frameHoverInfo(null, 41).lines).toEqual(["Frame 42"]);
  });

  it("shows only the header for an empty frame", () => {
    expect(frameHoverInfo(frame(), 5).lines).toEqual(["Frame 6"]);
  });

  it("labels a user-only frame and counts its instances", () => {
    expect(frameHoverInfo(frame({ instances: [userInst()] }), 0).lines).toEqual(
      ["Frame 1", "user labeled", "1 user instance"],
    );
  });

  it("pluralizes multiple user instances", () => {
    const lf = frame({ instances: [userInst(), userInst()] });
    expect(frameHoverInfo(lf, 0).lines).toEqual([
      "Frame 1",
      "user labeled",
      "2 user instances",
    ]);
  });

  it("labels a predicted-only frame WITHOUT a track", () => {
    const lf = frame({ instances: [predInst()] });
    expect(frameHoverInfo(lf, 0).lines).toEqual([
      "Frame 1",
      "prediction without track identity",
      "1 predicted instance",
    ]);
  });

  it("labels a predicted-only frame WITH a track identity", () => {
    const lf = frame({ instances: [predInst(new Track("animal_0"))] });
    expect(frameHoverInfo(lf, 0).lines).toEqual([
      "Frame 1",
      "prediction with track identity",
      "1 predicted instance",
    ]);
  });

  it("pluralizes multiple predicted instances", () => {
    const lf = frame({ instances: [predInst(), predInst()] });
    expect(frameHoverInfo(lf, 0).lines).toEqual([
      "Frame 1",
      "prediction without track identity",
      "2 predicted instances",
    ]);
  });

  it("prefers the user label on a mixed frame, listing predicted first", () => {
    const lf = frame({
      instances: [userInst(), predInst(new Track("animal_0"))],
    });
    expect(frameHoverInfo(lf, 0).lines).toEqual([
      "Frame 1",
      "user labeled",
      "1 predicted instance",
      "1 user instance",
    ]);
  });

  it("labels a negative (background) frame", () => {
    expect(frameHoverInfo(frame({ isNegative: true }), 0).lines).toEqual([
      "Frame 1",
      "negative (background) frame",
    ]);
  });

  it("negative takes priority over instance marks", () => {
    const lf = frame({ isNegative: true, instances: [predInst()] });
    expect(frameHoverInfo(lf, 0).lines).toEqual([
      "Frame 1",
      "negative (background) frame",
      "1 predicted instance",
    ]);
  });

  describe("suggested frames", () => {
    it("suggested with no labels (no LabeledFrame)", () => {
      expect(frameHoverInfo(null, 0, { isSuggested: true }).lines).toEqual([
        "Frame 1",
        "suggested frame (no labels)",
      ]);
    });

    it("suggested with user labels", () => {
      const lf = frame({ instances: [userInst()] });
      expect(frameHoverInfo(lf, 0, { isSuggested: true }).lines).toEqual([
        "Frame 1",
        "suggested frame with user labels",
        "1 user instance",
      ]);
    });

    it("suggested with only a prediction", () => {
      const lf = frame({ instances: [predInst(new Track("animal_0"))] });
      expect(frameHoverInfo(lf, 0, { isSuggested: true }).lines).toEqual([
        "Frame 1",
        "suggested frame with prediction",
        "1 predicted instance",
      ]);
    });
  });
});
