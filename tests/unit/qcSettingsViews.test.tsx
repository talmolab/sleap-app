/**
 * Label QC Detector Settings and issue-type filter in the store and the
 * views: settings saved per project, a run using them, and the dialog, panel
 * and F / Shift+F queue all leaving out the same flags. Also the Video column.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from "../bun-test";
import { render, screen, cleanup, fireEvent, act, within } from "@testing-library/react";
import { Labels, LabeledFrame, Instance, Skeleton, Video } from "@talmolab/sleap-io.js";
import type { QcFinding } from "@/lib/analyze/labelQc";
import type { AnomalyInstance } from "@/lib/analyze/qc/anomaly";

vi.mock("@/lib/platform", () => ({ isTauri: false, isMac: false, modKey: "Ctrl" }));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));

const { useAppStore } = await import("@/stores/appStore");
const { useQcStore, liveQcQueue, stepQcQueue } = await import("@/stores/qcStore");
const { LabelQcPanel } = await import("@/components/panels/LabelQcPanel");
const { LabelQcDialog } = await import("@/components/dialogs/LabelQcDialog");
const { setQcReviewedBackend, memoryBackend } = await import("@/lib/qcReviewed");
const { loadQcSettings, DEFAULT_QC_SETTINGS } = await import("@/lib/analyze/qc/settings");

const skeleton = new Skeleton({ nodes: ["head", "tail"], edges: [["head", "tail"]] });
const clipA = new Video({ filename: "/data/clipA.mp4", openBackend: false, backendMetadata: { shape: [100, 480, 640, 1] } });
const clipB = new Video({ filename: "/data/clipB.mp4", openBackend: false, backendMetadata: { shape: [100, 480, 640, 1] } });
const frameOf = (video: Video, frameIdx: number, pts: number[][][]) =>
  new LabeledFrame({ video, frameIdx, instances: pts.map((p) => Instance.fromNumpy({ pointsData: p, skeleton })) });
const labels = new Labels({
  videos: [clipA, clipB],
  skeletons: [skeleton],
  labeledFrames: [frameOf(clipA, 3, [[[1, 1], [2, 2]]]), frameOf(clipB, 7, [[[1, 1], [2, 2]]])],
});

const duplicate: QcFinding = { kind: "duplicate", message: "Two instances overlap", video: clipB, videoIdx: 1, frameIdx: 7, instanceIdx: 0 };
const odd: AnomalyInstance = {
  videoIdx: 0,
  frameIdx: 3,
  instIdx: 0,
  score: 0.9,
  confidence: "high",
  topIssue: "Unusual joint angle",
  issueNodes: [],
  issueKind: null,
  issueDir: 0,
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
    runSettings: DEFAULT_QC_SETTINGS,
    editedFrames: new Set(),
  });
}

beforeEach(async () => {
  localStorage.clear();
  setQcReviewedBackend(memoryBackend());
  useAppStore.setState({ labels, video: clipA, frameIdx: 0, skeleton });
  useQcStore.getState().reset();
  await useQcStore.getState().loadDismissed("/data/project.slp");
  useQcStore.setState({ showDismissed: false });
});
afterEach(cleanup);

describe("Detector Settings in the store", () => {
  // Changing a setting must stick for this project and nowhere else.
  it("saves settings for the open project", () => {
    useQcStore.getState().setSettings({ gmmPercent: 10, enabled: { chain_order: false } });
    expect(loadQcSettings("/data/project.slp")).toMatchObject({ gmmPercent: 10, enabled: { chain_order: false } });
    expect(loadQcSettings("/data/other.slp")).toEqual(DEFAULT_QC_SETTINGS);
  });

  // The threshold slider is the anomaly threshold setting: one value, saved with the rest.
  it("keeps the threshold slider and the anomaly threshold setting in step", () => {
    useQcStore.getState().setThreshold(0.4);
    expect(useQcStore.getState().settings.anomalyThreshold).toBe(0.4);
    expect(loadQcSettings("/data/project.slp").anomalyThreshold).toBe(0.4);
    useQcStore.getState().setSettings({ anomalyThreshold: 0.6 });
    expect(useQcStore.getState().threshold).toBe(0.6);
  });

  // Opening another project brings its own settings, and the issue filter starts fresh.
  it("loads each project's settings and clears the issue filter", async () => {
    useQcStore.getState().setSettings({ duplicateIou: 0.8 });
    useQcStore.getState().setHiddenIssues(new Set(["Duplicate"]));
    await useQcStore.getState().loadDismissed("/data/other.slp");
    expect(useQcStore.getState().settings.duplicateIou).toBe(0.5);
    expect(useQcStore.getState().hiddenIssues.size).toBe(0);
    await useQcStore.getState().loadDismissed("/data/project.slp");
    expect(useQcStore.getState().settings.duplicateIou).toBe(0.8);
  });

  // Restore defaults puts everything back, threshold included.
  it("restores the defaults", () => {
    useQcStore.getState().setSettings({ anomalyThreshold: 0.3, enabled: { gmm: false } });
    useQcStore.getState().resetSettings();
    expect(useQcStore.getState().settings).toEqual(DEFAULT_QC_SETTINGS);
    expect(useQcStore.getState().threshold).toBe(0.7);
  });

  // A run uses the settings' thresholds and remembers them (for "Rerun to apply").
  it("runs with the settings' thresholds", async () => {
    // Two boxes overlapping by IoU ~0.68, nodes > 10 px apart.
    const dupLabels = new Labels({
      videos: [clipA],
      skeletons: [skeleton],
      labeledFrames: [frameOf(clipA, 0, [[[0, 0], [100, 100]], [[10, 10], [110, 110]]])],
    });
    useQcStore.getState().setSettings({ duplicateIou: 0.75 });
    await useQcStore.getState().run(dupLabels);
    expect(useQcStore.getState().findings.some((f) => f.kind === "duplicate")).toBe(false);
    expect(useQcStore.getState().runSettings?.duplicateIou).toBe(0.75);
    useQcStore.getState().setSettings({ duplicateIou: 0.5 });
    await useQcStore.getState().run(dupLabels);
    expect(useQcStore.getState().findings.some((f) => f.kind === "duplicate")).toBe(true);
  });
});

describe("the review queue follows settings and the issue filter", () => {
  // F / Shift+F and Review step through the same filtered queue the panel lists.
  it("skips flags of switched-off detectors and hidden issue types", () => {
    withResults();
    expect(liveQcQueue().map((e) => e.frameIdx)).toEqual([7, 3]);
    useQcStore.getState().setSettings({ enabled: { duplicate: false } });
    expect(liveQcQueue().map((e) => e.frameIdx)).toEqual([3]);
    useQcStore.getState().setSettings({ enabled: { duplicate: true } });
    useQcStore.getState().setHiddenIssues(new Set(["Unusual joint angle"]));
    expect(liveQcQueue().map((e) => e.frameIdx)).toEqual([7]);
    useAppStore.setState({ video: clipA, frameIdx: 0 });
    stepQcQueue(1);
    expect(useAppStore.getState().frameIdx).toBe(7);
    stepQcQueue(1);
    expect(useAppStore.getState().frameIdx).toBe(7); // the hidden frame 3 is skipped
  });
});

describe("LabelQcPanel filters and settings", () => {
  // In a project with several videos, the list says which video each flag is in.
  it("shows a Video column with each video's file name", () => {
    withResults();
    render(<LabelQcPanel />);
    expect(screen.getByText("Video")).toBeTruthy();
    expect(screen.getByText("clipB.mp4")).toBeTruthy();
    expect(screen.getAllByText("clipA.mp4").length).toBeGreaterThan(0);
  });

  // The issue-type filter's caption counts the types still shown.
  it("captions the issue filter with the types shown", () => {
    withResults();
    render(<LabelQcPanel />);
    expect(screen.getByRole("button", { name: /Issue types: all/ })).toBeTruthy();
    act(() => useQcStore.getState().setHiddenIssues(new Set(["Duplicate"])));
    expect(screen.getByRole("button", { name: /Issue types: 1 of 2/ })).toBeTruthy();
    expect(screen.getByText("1 flagged frame")).toBeTruthy();
  });

  // A Detector Settings checkbox removes that check's flags from the list right away.
  it("unticking a detector drops its flags without a rerun", () => {
    withResults();
    render(<LabelQcPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Detector Settings/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Duplicate / split" }));
    expect(useQcStore.getState().settings.enabled.duplicate).toBe(false);
    expect(screen.getByText("1 flagged frame")).toBeTruthy();
    expect(screen.getByText(/1 off/)).toBeTruthy();
  });

  // Changing a threshold that only a run applies says to rerun.
  it("says to rerun after changing a run threshold", () => {
    withResults();
    render(<LabelQcPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Detector Settings/ }));
    act(() => useQcStore.getState().setSettings({ gmmPercent: 10 }));
    expect(screen.getAllByText(/Rerun to apply/).length).toBeGreaterThan(0);
  });
});

describe("LabelQcDialog filters and settings", () => {
  // The dialog shares the panel's settings and filter: switched off here is off everywhere.
  it("leaves out the same flags as the panel, with a Video column", () => {
    withResults();
    render(<LabelQcDialog open onOpenChange={() => {}} />);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("Video")).toBeTruthy();
    expect(within(dialog).getByText("clipB.mp4")).toBeTruthy();
    expect(within(dialog).getByText("1 issue")).toBeTruthy();
    act(() => useQcStore.getState().setSettings({ enabled: { duplicate: false } }));
    expect(within(dialog).getByText(/No issues found/)).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /Issue types: all/ })).toBeTruthy();
  });
});
