/**
 * The Training panel recognizes drawn bounding boxes as training data for a
 * box detector (#488). Before, a boxes-only project kept showing "No labeled
 * frames in this project", and the count never refreshed after drawing boxes
 * with the panel open (it was cached per project, and labels are edited in
 * place).
 */
import { describe, it, expect, afterEach, vi } from "../bun-test";
import { act, render, screen, cleanup } from "@testing-library/react";
import {
  Labels,
  LabeledFrame,
  Skeleton,
  Video,
  UserBoundingBox,
  Instance,
} from "@talmolab/sleap-io.js";
import { useAppStore } from "@/stores/appStore";
import { useConnectStore } from "@/stores/connectStore";
import { useTrainingStore } from "@/stores/trainingStore";
import { commandContext } from "@/commands";
import { AddBbox } from "@/commands/bboxCommands";

vi.mock("@/lib/platform", () => ({ isTauri: false, isMac: false, modKey: "Ctrl" }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const { TrainingPanel } = await import("@/components/panels/TrainingPanel");

const NO_LABELS = /No labeled frames in this project/;
const BOXES_ONLY = /has bounding boxes but no pose labels/;

function project(withBoxes: boolean) {
  const skeleton = new Skeleton({ nodes: ["head", "tail"], name: "s" });
  skeleton.addEdge(skeleton.nodes[0], skeleton.nodes[1]);
  const video = new Video({
    filename: "/v/flies.mp4",
    backendMetadata: { shape: [100, 384, 384, 1] },
    openBackend: false,
  });
  const frames = withBoxes
    ? [0, 10].map(
        (frameIdx) =>
          new LabeledFrame({
            video,
            frameIdx,
            bboxes: [new UserBoundingBox({ x1: 10, y1: 10, x2: 60, y2: 50 })],
          }),
      )
    : [];
  const labels = new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: frames });
  return { labels, video };
}

function renderWith(labels: Labels, modelType: "bbox" | "top_down") {
  const app = useAppStore.getState();
  app.setLabels(labels, "p.slp");
  app.setVideo(labels.videos[0]);
  app.setFrameIdx(0);
  useConnectStore.setState({ connectionStatus: "connected" });
  useTrainingStore.getState().setConfig("modelType", modelType);
  return render(<TrainingPanel />);
}

afterEach(() => {
  cleanup();
  useAppStore.setState(useAppStore.getInitialState());
  useTrainingStore.setState({ status: "idle" });
});

describe("Training panel with drawn boxes", () => {
  it("a box detector treats a boxes-only project as labeled", () => {
    renderWith(project(true).labels, "bbox");
    expect(screen.queryByText(NO_LABELS)).toBeNull();
    expect(screen.queryByText(BOXES_ONLY)).toBeNull();
  });

  it("a boxes-only project switches to Box Detector and says why", async () => {
    renderWith(project(true).labels, "top_down");
    await act(async () => {});
    expect(useTrainingStore.getState().config.modelType).toBe("bbox");
    expect(screen.getByText(/Only bounding boxes are labeled/)).toBeTruthy();
    expect(screen.queryByText(NO_LABELS)).toBeNull();
    expect(screen.queryByText(BOXES_ONLY)).toBeNull();
  });

  it("with pose labels as well, the model type is left alone", async () => {
    const { labels } = project(true);
    labels.labeledFrames[0].instances.push(Instance.fromArray([[20, 20], [40, 30]], labels.skeletons[0]));
    renderWith(labels, "top_down");
    await act(async () => {});
    expect(useTrainingStore.getState().config.modelType).toBe("top_down");
    expect(screen.queryByText(/Only bounding boxes are labeled/)).toBeNull();
  });

  it("an empty project still says there are no labeled frames", () => {
    renderWith(project(false).labels, "bbox");
    expect(screen.getByText(NO_LABELS)).toBeTruthy();
  });

  it("drawing a box with the panel open updates it (no stale count)", async () => {
    const { labels } = project(false);
    renderWith(labels, "bbox");
    expect(screen.getByText(NO_LABELS)).toBeTruthy();
    await act(async () => {
      await commandContext.execute(AddBbox, { x1: 5, y1: 5, x2: 40, y2: 40 });
    });
    expect(labels.labeledFrames[0].bboxes).toHaveLength(1);
    expect(screen.queryByText(NO_LABELS)).toBeNull();
  });
});
