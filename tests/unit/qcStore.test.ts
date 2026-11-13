/**
 * qcStore: the Label QC results shared by the dialog and the side panel — the
 * review queue's grouping/order, the run itself, staleness after edits, and
 * F / Shift+F navigation.
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";
import { Labels, LabeledFrame, Instance, Skeleton, Video, loadSlp } from "@talmolab/sleap-io.js";
import type { QcFinding } from "@/lib/analyze/labelQc";
import type { AnomalyInstance, AnomalyResult } from "@/lib/analyze/qc/anomaly";

const toastInfo = vi.fn();
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: toastInfo, warning: vi.fn() }),
}));

const { useAppStore } = await import("@/stores/appStore");
const { useQcStore, buildQcQueue, stepQcQueue, qcFrameKey } = await import("@/stores/qcStore");
const { dirtyFrameTracker } = await import("@/lib/autosaveDirty");

const video = new Video({ filename: "clip.mp4", openBackend: false, backendMetadata: { shape: [100, 480, 640, 1] } });

const finding = (frameIdx: number, kind: QcFinding["kind"]): QcFinding => ({
  kind,
  message: kind,
  video,
  videoIdx: 0,
  frameIdx,
  instanceIdx: 0,
});

const scored = (frameIdx: number, score: number, gmmScore: number | null = null): AnomalyInstance => ({
  videoIdx: 0,
  frameIdx,
  instIdx: 0,
  score,
  confidence: "high",
  topIssue: "Unusual joint angle",
  issueNodes: [],
  contributions: {},
  gmmScore,
  gmmIssue: gmmScore != null ? "Improbable pose" : null,
  gmmNode: null,
});

const result = (instances: AnomalyInstance[], gmmThreshold: number | null = 0.95): AnomalyResult => ({
  instances,
  featureNames: [],
  gmmThreshold,
});

describe("buildQcQueue", () => {
  it("groups everything found on a frame into one entry", () => {
    const q = buildQcQueue([finding(3, "duplicate"), finding(3, "out_of_range")], result([scored(3, 0.9)]), 0.7);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ frameIdx: 3, definite: true, worst: 0.9 });
    expect(q[0].rules).toHaveLength(2);
    expect(q[0].anomalies).toHaveLength(1);
  });

  it("puts definite rule errors first, then everything else by worst score", () => {
    const q = buildQcQueue(
      [finding(1, "chain_order"), finding(2, "duplicate")],
      result([scored(1, 0.8), scored(3, 0.99), scored(4, 0.75)]),
      0.7,
    );
    expect(q.map((e) => e.frameIdx)).toEqual([2, 3, 1, 4]);
  });

  it("doesn't let soft rules (chain order, chirality) jump the queue", () => {
    const q = buildQcQueue([finding(1, "chain_order"), finding(2, "chirality")], result([scored(5, 0.9)]), 0.7);
    expect(q[0].frameIdx).toBe(5);
    expect(q.every((e) => !e.definite)).toBe(true);
  });

  it("lists a frame's definite errors before its soft ones", () => {
    const q = buildQcQueue([finding(1, "chain_order"), finding(1, "duplicate")], null, 0.7);
    expect(q[0].rules.map((r) => r.kind)).toEqual(["duplicate", "chain_order"]);
  });

  it("follows the threshold, and the GMM flags on its own", () => {
    const anomaly = result([scored(1, 0.8), scored(2, 0.5), scored(3, 0.1, 0.97)]);
    expect(buildQcQueue([], anomaly, 0.7).map((e) => e.frameIdx)).toEqual([3, 1]);
    expect(buildQcQueue([], anomaly, 0.4).map((e) => e.frameIdx)).toEqual([3, 1, 2]);
  });
});

const skeleton = new Skeleton({ nodes: ["a", "b"], edges: [["a", "b"]] });
const project = () =>
  new Labels({
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

/** Put finished results for `labels` in the store without running anything. */
function seed(labels: Labels, findings: QcFinding[], anomaly: AnomalyResult | null) {
  useAppStore.setState({ labels, video, frameIdx: 0 });
  useQcStore.setState({ labels, state: "done", findings, anomaly, editedFrames: new Set() });
}

describe("qcStore", () => {
  beforeEach(() => {
    useQcStore.getState().reset();
    toastInfo.mockClear();
  });

  it("runs the rule checks and the anomaly scores in one go", async () => {
    const labels = await loadSlp(await Bun.file("tests/fixtures/centered_pair.slp").arrayBuffer(), {
      openVideos: false,
    });
    await useQcStore.getState().run(labels);
    const s = useQcStore.getState();
    expect(s.state).toBe("done");
    expect(s.labels).toBe(labels);
    expect(s.anomaly?.instances.length).toBeGreaterThan(0);
  });

  it("drops results when a different project loads", () => {
    const labels = project();
    seed(labels, [finding(3, "duplicate")], null);
    useAppStore.setState({ labels: project() });
    expect(useQcStore.getState()).toMatchObject({ state: "idle", labels: null, findings: [] });
  });

  it("marks an edited frame stale", () => {
    const labels = project();
    seed(labels, [finding(3, "duplicate")], null);
    dirtyFrameTracker.markFrame(video, 3);
    expect([...useQcStore.getState().editedFrames]).toEqual([qcFrameKey(0, 3)]);
    dirtyFrameTracker.clear();
  });

  it("doesn't treat navigating as an edit", async () => {
    const { commandContext, GoNextUserFrame } = await import("@/commands");
    const labels = project();
    seed(labels, [finding(3, "duplicate")], null);
    await commandContext.execute(GoNextUserFrame);
    expect(useAppStore.getState().frameIdx).toBe(3);
    expect(useQcStore.getState().editedFrames.size).toBe(0);
    dirtyFrameTracker.clear();
  });

  it("ignores edits when there are no results", () => {
    useAppStore.setState({ labels: project(), video, frameIdx: 0 });
    dirtyFrameTracker.markFrame(video, 3);
    expect(useQcStore.getState().editedFrames.size).toBe(0);
    dirtyFrameTracker.clear();
  });
});

describe("stepQcQueue (F / Shift+F)", () => {
  beforeEach(() => {
    useQcStore.getState().reset();
    toastInfo.mockClear();
  });

  it("goes through the queue in order, wrapping, and opens the panel", () => {
    const labels = project();
    seed(labels, [finding(7, "duplicate")], result([scored(3, 0.9)]));
    useAppStore.setState({ sidebarOpenPanels: ["videos"], sidebarMultiPanel: true });
    stepQcQueue(1);
    expect(useAppStore.getState().frameIdx).toBe(7); // definite error first
    expect(useAppStore.getState().sidebarOpenPanels).toContain("qc");
    stepQcQueue(1);
    expect(useAppStore.getState().frameIdx).toBe(3);
    stepQcQueue(1);
    expect(useAppStore.getState().frameIdx).toBe(7); // wrapped
    stepQcQueue(-1);
    expect(useAppStore.getState().frameIdx).toBe(3);
  });

  it("selects the flagged instance", () => {
    const labels = project();
    seed(labels, [], result([scored(3, 0.9)]));
    stepQcQueue(1);
    const lf = labels.find({ video }).find((x) => x.frameIdx === 3);
    expect(useAppStore.getState().instance).toBe(lf?.userInstances[0] ?? null);
  });

  it("says to run QC first when there are no results", () => {
    useAppStore.setState({ labels: project(), video, frameIdx: 0 });
    stepQcQueue(1);
    expect(toastInfo).toHaveBeenCalled();
    expect(useAppStore.getState().frameIdx).toBe(0);
  });
});
