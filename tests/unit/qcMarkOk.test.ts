/**
 * Label QC "Mark as OK": marked instances leave the review queue, F order and
 * the canvas overlay (and come back, faded, with "show dismissed"); a mark
 * covers every flag on its instance but no frame-level ones; editing the pose
 * drops it; key 3 marks and moves on; marks are kept per project.
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";
import { Labels, LabeledFrame, Instance, Skeleton, Video } from "@talmolab/sleap-io.js";
import type { QcFinding } from "@/lib/analyze/labelQc";
import type { AnomalyInstance, AnomalyResult } from "@/lib/analyze/qc/anomaly";

const toastInfo = vi.fn();
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: toastInfo, warning: vi.fn() }),
}));

const { useAppStore } = await import("@/stores/appStore");
const { useQcStore, buildQcQueue, hideOkFlags, liveQcQueue, qcIsOk, stepQcQueue } = await import(
  "@/stores/qcStore"
);
const { qcCanvasFlags, useQcFrameFlags } = await import("@/hooks/useQcFrameFlags");
const { setQcReviewedBackend, memoryBackend, loadQcMarks } = await import("@/lib/qcReviewed");
const { commandContext, MarkQcFlagOk } = await import("@/commands");
const { renderHook, act } = await import("@testing-library/react");

const skeleton = new Skeleton({ nodes: ["a", "b"], edges: [["a", "b"]] });
const video = new Video({ filename: "clip.mp4", openBackend: false, backendMetadata: { shape: [100, 480, 640, 1] } });

/** Frames 3, 5, 7, each with two user instances. */
const project = () =>
  new Labels({
    videos: [video],
    skeletons: [skeleton],
    labeledFrames: [3, 5, 7].map(
      (frameIdx) =>
        new LabeledFrame({
          video,
          frameIdx,
          instances: [0, 10].map((d) =>
            Instance.fromNumpy({ pointsData: [[1 + d, 1], [2 + d, 2]], skeleton }),
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
  issueNodes: [],
  issueKind: null,
  issueDir: 0,
  contributions: {},
  gmmScore: null,
  gmmIssue: null,
  gmmNode: null,
});
const result = (instances: AnomalyInstance[]): AnomalyResult => ({ instances, featureNames: [], gmmThreshold: 0.95 });
const rule = (frameIdx: number, kind: QcFinding["kind"], instanceIdx?: number): QcFinding => ({
  kind,
  message: kind,
  video,
  videoIdx: 0,
  frameIdx,
  instanceIdx,
});

let labels: Labels;
const lfAt = (frameIdx: number) => labels.find({ video, frameIdx })[0];

/** Load `labels` as project `key` and put finished results in the store. */
async function seed(findings: QcFinding[], anomaly: AnomalyResult | null, key = "/data/flies.slp") {
  labels = project();
  useAppStore.setState({ labels, projectPath: key, filename: "flies.slp", video, frameIdx: 0, instance: null });
  await Promise.resolve(); // loadDismissed
  useQcStore.setState({ labels, state: "done", findings, anomaly, editedFrames: new Set(), threshold: 0.7 });
}

const frames = () => liveQcQueue().map((e) => e.frameIdx);

describe("Mark as OK", () => {
  beforeEach(() => {
    setQcReviewedBackend(memoryBackend());
    useAppStore.setState({ labels: null, projectPath: null, filename: null });
    useQcStore.setState({ showDismissed: false });
    useQcStore.getState().reset();
    toastInfo.mockClear();
  });

  it("drops a marked instance from the queue and F order, and shows it again on request", async () => {
    await seed([], result([scored(3, 0, 0.9), scored(5, 0, 0.8)]));
    expect(frames()).toEqual([3, 5]);
    useQcStore.getState().markOk(0, 3, 0);
    expect(frames()).toEqual([5]);
    stepQcQueue(1);
    expect(useAppStore.getState().frameIdx).toBe(5);

    useQcStore.getState().setShowDismissed(true);
    const q = liveQcQueue();
    expect(q.map((e) => e.frameIdx)).toEqual([5, 3]); // all-OK frame sorts last
    expect(q[1].ok).toEqual([0]);
  });

  it("covers every flag on the instance, rule findings included, but not frame-level ones", async () => {
    await seed(
      [rule(3, "duplicate", 0), rule(3, "chain_order", 0), rule(5, "incomplete_frame"), rule(5, "duplicate", 1)],
      result([scored(3, 0, 0.9)]),
    );
    useQcStore.getState().markOk(0, 3, 0);
    useQcStore.getState().markOk(0, 5, 1);
    const q = liveQcQueue();
    expect(q.map((e) => e.frameIdx)).toEqual([5]); // frame 3 had only inst 0's flags
    expect(q[0].rules.map((r) => r.kind)).toEqual(["incomplete_frame"]);
  });

  it("leaves other instances on the frame flagged", async () => {
    await seed([], result([scored(3, 0, 0.9), scored(3, 1, 0.8)]));
    useQcStore.getState().markOk(0, 3, 0);
    const [e] = liveQcQueue();
    expect(e.anomalies.map(({ a }) => a.instIdx)).toEqual([1]);
    expect(e.worst).toBe(0.8);
  });

  it("is dropped when the pose is edited, and comes back with Undo", async () => {
    await seed([], result([scored(3, 0, 0.9)]));
    useQcStore.getState().markOk(0, 3, 0);
    expect(frames()).toEqual([]);
    const inst = lfAt(3).userInstances[0];
    inst.points[0].xy = [50, 50];
    expect(frames()).toEqual([3]); // flagged again
    inst.points[0].xy = [1, 1];
    expect(frames()).toEqual([]);
    useQcStore.getState().unmarkOk(0, 3, 0);
    expect(frames()).toEqual([3]);
  });

  it("buildQcQueue without marks is unchanged, and hideOkFlags matches leaving them out", async () => {
    await seed([rule(7, "duplicate", 1)], result([scored(3, 0, 0.9)]));
    const findings = useQcStore.getState().findings;
    const anomaly = useQcStore.getState().anomaly;
    expect(qcIsOk(labels, new Set())).toBeUndefined();
    useQcStore.getState().markOk(0, 7, 1);
    const isOk = qcIsOk(labels, useQcStore.getState().dismissed);
    const shown = buildQcQueue(findings, anomaly, 0.7, isOk);
    expect(shown.map((e) => e.frameIdx)).toEqual([3, 7]); // the OK duplicate no longer jumps the queue
    expect(shown[1].definite).toBe(false);
    expect(hideOkFlags(shown).map((e) => e.frameIdx)).toEqual([3]);
  });

  it("canvas: no box for a marked instance; a faded one while shown", async () => {
    await seed([], result([scored(3, 0, 0.9), scored(3, 1, 0.8)]));
    useAppStore.setState({
      frameIdx: 3,
      labeledFrame: lfAt(3),
      sidebarCollapsed: false,
      sidebarOpenPanels: ["qc"],
    });
    useQcStore.getState().markOk(0, 3, 0);
    const { result: hook } = renderHook(() => useQcFrameFlags());
    expect(hook.current.flags.map((f) => [f.instanceIdx, f.stale])).toEqual([[1, false]]);
    act(() => useQcStore.getState().setShowDismissed(true));
    expect(hook.current.flags.map((f) => [f.instanceIdx, f.stale])).toEqual([
      [1, false],
      [0, true],
    ]);
  });

  it("qcCanvasFlags fades OK instances", async () => {
    await seed([], null);
    const entry = { videoIdx: 0, frameIdx: 3, rules: [rule(3, "duplicate", 1)], definite: false, anomalies: [], worst: 0, ok: [1] };
    expect(qcCanvasFlags(entry, lfAt(3), false)).toEqual([{ instanceIdx: 1, nodes: [], edges: [], angles: [], stale: true }]);
  });
});

describe("key 3 (MarkQcFlagOk)", () => {
  beforeEach(() => {
    setQcReviewedBackend(memoryBackend());
    useAppStore.setState({ labels: null, projectPath: null, filename: null });
    useQcStore.setState({ showDismissed: false });
    useQcStore.getState().reset();
    toastInfo.mockClear();
  });

  it("marks the selected flagged instance and goes to the next flag", async () => {
    await seed([], result([scored(3, 0, 0.9), scored(5, 0, 0.8), scored(7, 0, 0.75)]));
    stepQcQueue(1);
    expect(useAppStore.getState().frameIdx).toBe(3);
    await commandContext.execute(MarkQcFlagOk);
    expect(useAppStore.getState().frameIdx).toBe(5);
    expect(useAppStore.getState().instance).toBe(lfAt(5).userInstances[0]);
    expect(frames()).toEqual([5, 7]);
  });

  it("stays on the frame while it has other flagged instances", async () => {
    await seed([], result([scored(3, 0, 0.9), scored(3, 1, 0.8), scored(5, 0, 0.7)]));
    stepQcQueue(1);
    await commandContext.execute(MarkQcFlagOk);
    expect(useAppStore.getState().frameIdx).toBe(3);
    expect(useAppStore.getState().instance).toBe(lfAt(3).userInstances[1]);
  });

  it("says so when the selection isn't flagged", async () => {
    await seed([], result([scored(3, 0, 0.9)]));
    stepQcQueue(1);
    useAppStore.setState({ instance: lfAt(3).userInstances[1] });
    await commandContext.execute(MarkQcFlagOk);
    expect(toastInfo).toHaveBeenCalledWith("Select a flagged instance on this frame to ignore it.", expect.anything());
    expect(useQcStore.getState().dismissed.size).toBe(0);
  });

  it("says when every flag is reviewed", async () => {
    await seed([], result([scored(3, 0, 0.9)]));
    stepQcQueue(1);
    await commandContext.execute(MarkQcFlagOk);
    expect(toastInfo).toHaveBeenCalledWith("All Label QC flags reviewed.", expect.anything());
  });
});

describe("persistence", () => {
  beforeEach(() => {
    useAppStore.setState({ labels: null, projectPath: null, filename: null });
    useQcStore.getState().reset();
  });

  it("saves marks per project and restores them when the project is opened again", async () => {
    setQcReviewedBackend(memoryBackend());
    await seed([], result([scored(3, 0, 0.9)]), "/data/flies.slp");
    useQcStore.getState().markOk(0, 3, 0);
    await Promise.resolve();
    expect(await loadQcMarks("/data/flies.slp")).toHaveLength(1);

    await seed([], result([scored(3, 0, 0.9)]), "/data/other.slp");
    expect(useQcStore.getState().dismissed.size).toBe(0);

    await seed([], result([scored(3, 0, 0.9)]), "/data/flies.slp"); // reopened: same poses
    await Promise.resolve();
    expect(useQcStore.getState().dismissed.size).toBe(1);
    expect(frames()).toEqual([]); // survives the new run's results too
  });

  it("copies marks to the new path on Save As", async () => {
    setQcReviewedBackend(memoryBackend());
    await seed([], result([scored(3, 0, 0.9)]), "/data/flies.slp");
    useQcStore.getState().markOk(0, 3, 0);
    useAppStore.setState({ projectPath: "/data/flies_v2.slp" });
    await Promise.resolve();
    expect(useQcStore.getState().dismissedProject).toBe("/data/flies_v2.slp");
    expect(await loadQcMarks("/data/flies_v2.slp")).toHaveLength(1);
  });
});
