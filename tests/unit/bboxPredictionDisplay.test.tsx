/**
 * Showing a box detector's predictions (#488): box colors, and scores in the
 * Suggestions table and Frames panel for frames that have predicted boxes but
 * no predicted poses.
 */
import { describe, it, expect, afterEach } from "../bun-test";
import { render, screen, cleanup } from "@testing-library/react";
import {
  Labels,
  LabeledFrame,
  Skeleton,
  Track,
  Video,
  UserBoundingBox,
  PredictedBoundingBox,
  PredictedInstance,
  SuggestionFrame,
} from "@talmolab/sleap-io.js";
import { bboxColor, captionTextColor, UNTRACKED_BBOX_COLOR } from "@/canvas/BboxRenderer";
import { UNCOLORED_PREDICTED_NODE_COLOR } from "@/canvas/SkeletonRenderer";
import { getPaletteColor, getTrackColor } from "@/lib/colorPalettes";
import { computeFrameScore } from "@/components/panels/SuggestionsPanel";
import { useAppStore } from "@/stores/appStore";

afterEach(() => {
  cleanup();
  useAppStore.setState(useAppStore.getInitialState());
});

const base = {
  index: 1,
  isPredicted: false,
  colorPredicted: false,
  colorTarget: "node",
  linkedInstanceColor: null,
  track: null,
  tracks: [] as unknown[],
  palette: "standard",
};

describe("bboxColor", () => {
  it("every untracked box is the same bright blue, not grey", () => {
    expect(bboxColor(base)).toEqual(UNTRACKED_BBOX_COLOR);
    expect(bboxColor({ ...base, index: 0 })).toEqual(bboxColor({ ...base, index: 3 }));
    const [r, g, b] = UNTRACKED_BBOX_COLOR;
    expect(r === g && g === b).toBe(false);
  });

  it("predicted boxes are yellow when 'Color predicted' is off, like predicted nodes", () => {
    expect(bboxColor({ ...base, isPredicted: true })).toEqual(UNCOLORED_PREDICTED_NODE_COLOR);
    // With it on, they're colored like any box.
    expect(bboxColor({ ...base, isPredicted: true, colorPredicted: true })).toEqual(UNTRACKED_BBOX_COLOR);
  });

  it("a tracked box takes its track's color", () => {
    const a = new Track("A");
    const b = new Track("B");
    expect(bboxColor({ ...base, track: b, tracks: [a, b] })).toEqual(getTrackColor("standard", 1, "B"));
  });

  it("captions stay readable: dark text on yellow, white on dark colors", () => {
    expect(captionTextColor(UNCOLORED_PREDICTED_NODE_COLOR)).toBe("black");
    expect(captionTextColor([0, 0, 180])).toBe("white");
  });

  it("with color-by-instance, a linked box takes its instance's color, else a palette color", () => {
    expect(
      bboxColor({ ...base, colorTarget: "instance", linkedInstanceColor: [1, 2, 3] }),
    ).toEqual([1, 2, 3]);
    expect(bboxColor({ ...base, colorTarget: "instance" })).toEqual(getPaletteColor("standard", 1));
  });
});

function boxOnlyProject() {
  const skeleton = new Skeleton({ nodes: ["a"], name: "s" });
  const video = new Video({
    filename: "/v/flies.mp4",
    backendMetadata: { shape: [100, 384, 384, 1] },
    openBackend: false,
  });
  const boxes = new LabeledFrame({
    video,
    frameIdx: 25,
    bboxes: [
      new PredictedBoundingBox({ x1: 0, y1: 0, x2: 10, y2: 10, score: 0.71 }),
      new PredictedBoundingBox({ x1: 20, y1: 0, x2: 30, y2: 10, score: 0.68 }),
    ],
  });
  const drawn = new LabeledFrame({
    video,
    frameIdx: 30,
    bboxes: [new UserBoundingBox({ x1: 0, y1: 0, x2: 10, y2: 10 })],
  });
  const labels = new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [boxes, drawn] });
  return { labels, video, skeleton };
}

describe("Suggestions table score", () => {
  it("uses predicted box scores on a frame with boxes but no predicted poses", () => {
    const { labels, video } = boxOnlyProject();
    const s = computeFrameScore(new SuggestionFrame({ video, frameIdx: 25 }), labels as never)!;
    expect(s.min).toBeCloseTo(0.68);
    expect(s.mean).toBeCloseTo(0.695);
    // A frame with only a drawn (user) box has no prediction score.
    expect(computeFrameScore(new SuggestionFrame({ video, frameIdx: 30 }), labels as never)).toBeNull();
  });

  it("prefers predicted poses when the frame has them", () => {
    const { labels, video, skeleton } = boxOnlyProject();
    labels.labeledFrames[0].instances.push(PredictedInstance.fromArray([[1, 1]], skeleton, 0.9));
    const s = computeFrameScore(new SuggestionFrame({ video, frameIdx: 25 }), labels as never)!;
    expect(s.scores).toEqual([0.9]);
  });
});

describe("Frames panel", () => {
  it("lists a frame with only predicted boxes, with their mean score", async () => {
    const { labels, video } = boxOnlyProject();
    const app = useAppStore.getState();
    app.setLabels(labels, "p.slp");
    app.setVideo(video);
    const { FramesPanel } = await import("@/components/panels/FramesPanel");
    render(<FramesPanel />);
    // Mean of 0.71 and 0.68 → 0.70 (rounded to 2 places).
    expect(await screen.findByText("0.70")).toBeTruthy();
  });
});

describe("Boxes list", () => {
  it("has column headers, each with a tip", async () => {
    const { labels } = boxOnlyProject();
    const { BboxList } = await import("@/components/panels/BboxList");
    useAppStore.getState().setLabels(labels, "p.slp");
    render(<BboxList labeledFrame={labels.labeledFrames[0]} />);
    for (const h of ["#", "Type", "Score", "Review", "Category", "Track", "Linked instance"]) {
      const cell = screen.getByRole("columnheader", { name: h });
      expect(cell.getAttribute("title")).toBeTruthy();
    }
    // One row per box, under the headers.
    expect(screen.getAllByRole("row")).toHaveLength(3);
    expect(screen.getByText("0.71")).toBeTruthy();
  });
});
