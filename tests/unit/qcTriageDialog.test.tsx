// Why: the Grid is for triaging many flags at once; selecting, Mark OK, opening one in Review and the progress counts must work from the real dialog.
import { describe, it, expect, beforeEach, afterEach, vi } from "../bun-test";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { Labels, LabeledFrame, Instance, Skeleton, Video } from "@talmolab/sleap-io.js";
import type { QcFinding } from "@/lib/analyze/labelQc";
import type { AnomalyInstance, AnomalyResult } from "@/lib/analyze/qc/anomaly";

vi.mock("@/lib/platform", () => ({ isTauri: false, isMac: false, modKey: "Ctrl" }));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));

const { useAppStore } = await import("@/stores/appStore");
const { useQcStore } = await import("@/stores/qcStore");
const { setQcReviewedBackend, memoryBackend } = await import("@/lib/qcReviewed");
const { QcTriageDialog } = await import("@/components/qc/QcTriageDialog");

const skeleton = new Skeleton({ nodes: ["head", "thorax", "tail"], edges: [["head", "thorax"], ["thorax", "tail"]] });
const video = new Video({ filename: "clip.mp4", openBackend: false, backendMetadata: { shape: [100, 480, 640, 1] } });
const project = () =>
  new Labels({
    videos: [video],
    skeletons: [skeleton],
    labeledFrames: [3, 5, 7].map(
      (frameIdx) =>
        new LabeledFrame({
          video,
          frameIdx,
          instances: [0, 50].map((d) =>
            Instance.fromNumpy({ pointsData: [[10 + d, 10], [20 + d, 20], [30 + d, 10]], skeleton }),
          ),
        }),
    ),
  });
const scored = (frameIdx: number, instIdx: number, score: number): AnomalyInstance => ({
  videoIdx: 0,
  frameIdx,
  instIdx,
  score,
  confidence: "high",
  topIssue: "Unusual joint angle",
  issueNodes: [1, 0, 2],
  issueKind: "angle",
  issueDir: -1,
  contributions: {},
  gmmScore: null,
  gmmIssue: null,
  gmmNode: null,
});
const RESULT: AnomalyResult = { instances: [scored(3, 0, 0.9), scored(5, 0, 0.8)], featureNames: [], gmmThreshold: 0.95 };
const FINDINGS: QcFinding[] = [{ kind: "duplicate", message: "dup", video, videoIdx: 0, frameIdx: 7, instanceIdx: 1 }];

let labels: Labels;
beforeEach(() => {
  setQcReviewedBackend(memoryBackend());
  labels = project();
  useAppStore.setState({
    labels,
    video,
    frameIdx: 0,
    instance: null,
    labeledFrame: null,
    skeleton,
    projectPath: "/data/flies.slp",
    filename: "flies.slp",
  });
  useQcStore.setState({
    labels,
    state: "done",
    findings: FINDINGS,
    anomaly: RESULT,
    threshold: 0.7,
    editedFrames: new Set(),
    dismissed: new Set(),
    dismissedProject: "/data/flies.slp",
    showDismissed: false,
    reviewOpen: false,
    triageOpen: true,
    prevRunFlags: null,
    rescored: new Map(),
  });
});
afterEach(cleanup);

describe("Label QC Grid", () => {
  it("shows a tile per flagged instance and the progress", () => {
    render(<QcTriageDialog />);
    expect(screen.getAllByTestId("qc-tile").length).toBe(3);
    expect(screen.getByTestId("qc-progress").textContent).toContain("3 of 3 flagged instances left");
  });

  // Why: bulk Mark OK is the reason for the Grid: two clicks and one button instead of two Review steps.
  it("Mark OK on a selection hides those tiles and counts them as ignored", () => {
    render(<QcTriageDialog />);
    const tiles = screen.getAllByTestId("qc-tile");
    fireEvent.click(tiles[0]);
    fireEvent.click(tiles[2], { shiftKey: true }); // a range: all three
    expect(screen.getByText("3 selected")).toBeTruthy();
    fireEvent.click(tiles[1]); // and back out of the range
    fireEvent.click(screen.getByRole("button", { name: "Mark OK" }));
    expect(useQcStore.getState().dismissed.size).toBe(2);
    expect(screen.getAllByTestId("qc-tile").length).toBe(1);
    expect(screen.getByTestId("qc-progress").textContent).toContain("1 of 3 flagged instances left");
    expect(screen.getByTestId("qc-progress").textContent).toContain("2 ignored");
  });

  it("double-click opens that instance in Review and closes the Grid", () => {
    render(<QcTriageDialog />);
    const tile = screen.getAllByRole("button", { name: /Frame 7, instance 2/ })[0];
    act(() => {
      fireEvent.doubleClick(tile);
    });
    expect(useQcStore.getState().reviewOpen).toBe(true);
    expect(useQcStore.getState().triageOpen).toBe(false);
    const s = useAppStore.getState();
    expect(s.frameIdx).toBe(7);
    expect(s.instance).toBe(labels.find({ video, frameIdx: 7 })[0].userInstances[1]);
  });
});

describe("last run vs this run", () => {
  // Why: the before/after count is how you see a review paid off; it must come from the run before.
  it("a rerun keeps the previous run's flag count", async () => {
    await useQcStore.getState().run(labels);
    expect(useQcStore.getState().prevRunFlags).toBe(3);
  });

  it("is dropped for a different project", async () => {
    await useQcStore.getState().run(project());
    expect(useQcStore.getState().prevRunFlags).toBeNull();
  });
});
