/**
 * Label QC side panel: its states (no project, not run, results) and that the
 * flagged-frame list and the current-frame card follow the shared qcStore.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "../bun-test";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { Labels, LabeledFrame, Instance, Skeleton, Video } from "@talmolab/sleap-io.js";
import type { QcFinding } from "@/lib/analyze/labelQc";
import type { AnomalyInstance } from "@/lib/analyze/qc/anomaly";

vi.mock("@/lib/platform", () => ({ isTauri: false, isMac: false, modKey: "Ctrl" }));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));

const { useAppStore } = await import("@/stores/appStore");
const { useQcStore, qcFrameKey } = await import("@/stores/qcStore");
const { LabelQcPanel } = await import("@/components/panels/LabelQcPanel");
const { setQcReviewedBackend, memoryBackend } = await import("@/lib/qcReviewed");

const skeleton = new Skeleton({ nodes: ["head", "tail"], edges: [["head", "tail"]] });
const video = new Video({ filename: "clip.mp4", openBackend: false, backendMetadata: { shape: [100, 480, 640, 1] } });
const labels = new Labels({
  videos: [video],
  skeletons: [skeleton],
  labeledFrames: [3, 7].map(
    (frameIdx) =>
      new LabeledFrame({
        video,
        frameIdx,
        instances: [Instance.fromNumpy({ pointsData: [[1, 1], [2, 2]], skeleton })],
      }),
  ),
});

const duplicate: QcFinding = { kind: "duplicate", message: "Two instances overlap", video, videoIdx: 0, frameIdx: 7, instanceIdx: 0 };
const odd: AnomalyInstance = {
  videoIdx: 0,
  frameIdx: 3,
  instIdx: 0,
  score: 0.9,
  confidence: "high",
  topIssue: "Unusual joint angle",
  issueNodes: [],
  contributions: {},
  gmmScore: 0.2,
  gmmIssue: null,
  gmmNode: null,
};

function withResults() {
  useQcStore.setState({
    labels,
    state: "done",
    findings: [duplicate],
    anomaly: { instances: [odd], featureNames: [], gmmThreshold: 0.95 },
    editedFrames: new Set(),
  });
}

describe("LabelQcPanel", () => {
  beforeEach(() => {
    setQcReviewedBackend(memoryBackend());
    useAppStore.setState({ labels, video, frameIdx: 0, skeleton });
    useQcStore.getState().reset();
    useQcStore.setState({ dismissed: new Set(), showDismissed: false });
  });
  afterEach(cleanup);

  it("asks to open a project when there is none", () => {
    useAppStore.setState({ labels: null });
    render(<LabelQcPanel />);
    expect(screen.getByText("Open a project to run QC.")).toBeTruthy();
  });

  it("offers Run QC before a run", () => {
    render(<LabelQcPanel />);
    expect(screen.getByRole("button", { name: "Run QC" })).toBeTruthy();
  });

  it("lists flagged frames, definite errors first, and shows the current frame's card", () => {
    withResults();
    useAppStore.setState({ frameIdx: 3 });
    render(<LabelQcPanel />);
    expect(screen.getByText("2 flagged frames")).toBeTruthy();
    expect(screen.getByText("2 / 2")).toBeTruthy(); // frame 3 is second, after the duplicate
    expect(screen.getAllByText("Unusual joint angle").length).toBeGreaterThan(0);
  });

  it("jumps to a frame from the list", () => {
    withResults();
    render(<LabelQcPanel />);
    fireEvent.click(screen.getByText("Duplicate"));
    expect(useAppStore.getState().frameIdx).toBe(7);
  });

  it("says when the current frame has no flags", () => {
    withResults();
    useAppStore.setState({ frameIdx: 50 });
    render(<LabelQcPanel />);
    expect(screen.getByText(/No QC flags on this frame/)).toBeTruthy();
  });

  it("marks a frame edited since the run", () => {
    withResults();
    useQcStore.setState({ editedFrames: new Set([qcFrameKey(0, 3)]) });
    useAppStore.setState({ frameIdx: 3 });
    render(<LabelQcPanel />);
    expect(screen.getByText(/Edited since the run/)).toBeTruthy();
  });

  it("ignores an instance, counts it, and shows it again with Undo", () => {
    withResults();
    useAppStore.setState({ frameIdx: 3 });
    render(<LabelQcPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Ignore (3)" }));
    expect(screen.getByText("1 flagged frame · 1 ignored")).toBeTruthy();
    expect(screen.queryByText("Unusual joint angle")).toBeNull();

    expect(useAppStore.getState().frameIdx).toBe(7); // moved on to the next flag

    fireEvent.click(screen.getByRole("button", { name: "Show ignored" }));
    act(() => useAppStore.setState({ frameIdx: 3 }));
    expect(screen.getAllByText("Ignored").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByText("2 flagged frames")).toBeTruthy();
  });
});
