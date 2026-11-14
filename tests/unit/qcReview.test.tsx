/**
 * Label QC Review window: the three orderings, the issue kind (edge / angle /
 * node) carried from the attribution to the canvas, how the canvas draws each,
 * and the review mode itself (Review button, ← / → / Esc / 3 / 0 routing,
 * Delete instance, the overlay with the panel closed, selecting and placing
 * the problem node, re-scoring after a fix).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "../bun-test";
import { render, screen, cleanup, fireEvent, act, renderHook } from "@testing-library/react";
import { Labels, LabeledFrame, Instance, Skeleton, Video, loadSlp } from "@talmolab/sleap-io.js";
import type { QcFinding } from "@/lib/analyze/labelQc";
import type { AnomalyInstance, AnomalyResult, AnomalyVerdict } from "@/lib/analyze/qc/anomaly";
import type { RenderedInstance, RenderOptions } from "@/canvas/SkeletonRenderer";
import type { QcQueueEntry } from "@/stores/qcStore";

vi.mock("@/lib/platform", () => ({ isTauri: false, isMac: false, modKey: "Ctrl" }));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));

const { useAppStore } = await import("@/stores/appStore");
const {
  useQcStore,
  liveQcQueue,
  sortQcQueue,
  qcDetectorCount,
  handleQcReviewKey,
  openQcReview,
  qcProblemNode,
  qcInstKey,
} = await import("@/stores/qcStore");
const { anomalyVerdict } = await import("@/lib/analyze/qc/anomaly");
const { isPlacementClick } = await import("@/lib/canvasGestures");
const { placeQcReviewNode, VideoPlayer } = await import("@/components/video/VideoPlayer");
const { qcCanvasFlags, useQcFrameFlags } = await import("@/hooks/useQcFrameFlags");
const { renderQcFlags } = await import("@/canvas/SkeletonRenderer");
const { scoreLabelsAnomaly } = await import("@/lib/analyze/qc/anomaly");
const { topIssue } = await import("@/lib/analyze/qc/explain");
const { qcIssueText } = await import("@/lib/qcReview");
const { setQcReviewedBackend, memoryBackend } = await import("@/lib/qcReviewed");
const { commandContext } = await import("@/commands");
const { useKeyboardShortcuts } = await import("@/hooks/useKeyboardShortcuts");
const { LabelQcPanel } = await import("@/components/panels/LabelQcPanel");
const { QcReviewFrame } = await import("@/components/video/QcReviewFrame");

const skeleton = new Skeleton({ nodes: ["head", "thorax", "tail"], edges: [["head", "thorax"], ["thorax", "tail"]] });
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
          instances: [0, 50].map((d) =>
            Instance.fromNumpy({ pointsData: [[10 + d, 10], [20 + d, 20], [30 + d, 10]], skeleton }),
          ),
        }),
    ),
  });

const scored = (frameIdx: number, instIdx: number, score: number, gmmScore: number | null = null): AnomalyInstance => ({
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
  gmmScore,
  gmmIssue: gmmScore != null && gmmScore >= 0.95 ? "Improbable pose" : null,
  gmmNode: gmmScore != null && gmmScore >= 0.95 ? 2 : null,
});
const rule = (frameIdx: number, kind: QcFinding["kind"], instanceIdx?: number): QcFinding => ({
  kind,
  message: `${kind} here`,
  video,
  videoIdx: 0,
  frameIdx,
  instanceIdx,
});
// Frame 3: anomaly 0.9. Frame 5: anomaly 0.8 and GMM 0.99 (two checks agree,
// worst score 0.99). Frame 7: a duplicate (a definite error).
const RESULT: AnomalyResult = {
  instances: [scored(3, 0, 0.9, 0.5), scored(5, 0, 0.8, 0.99)],
  featureNames: [],
  gmmThreshold: 0.95,
};
const FINDINGS = [rule(7, "duplicate", 1)];

let labels: Labels;
const lfAt = (frameIdx: number) => labels.find({ video, frameIdx })[0];

function seed() {
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
    sidebarCollapsed: false,
    sidebarOpenPanels: ["videos"],
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
    reviewOrder: "severity",
    rescored: new Map(),
    nodeFocus: null,
  });
}

const frames = () => liveQcQueue().map((e) => e.frameIdx);

beforeEach(() => {
  setQcReviewedBackend(memoryBackend());
  seed();
});
afterEach(cleanup);

describe("review orderings", () => {
  it("Severity: definite errors first, then the worst score", () => {
    expect(frames()).toEqual([7, 5, 3]);
  });

  it("Detectors: most checks agreeing on the worst instance first, ties by worst score", () => {
    useQcStore.getState().setReviewOrder("detectors");
    expect(frames()).toEqual([5, 3, 7]);
    const counts = Object.fromEntries(
      sortQcQueue(liveQcQueue(), "frame").map((e) => [e.frameIdx, qcDetectorCount(e)]),
    );
    expect(counts).toEqual({ 3: 1, 5: 2, 7: 1 });
  });

  it("Detectors counts each kind of rule finding on the instance or the whole frame", () => {
    const e: QcQueueEntry = {
      videoIdx: 0,
      frameIdx: 3,
      rules: [rule(3, "duplicate", 0), rule(3, "duplicate", 0), rule(3, "incomplete_frame"), rule(3, "duplicate", 1)],
      definite: true,
      anomalies: [{ a: scored(3, 0, 0.9, 0.99), v: { flagged: true, by: "both", score: 0.99, confidence: "high", issue: "x" } }],
      worst: 0.99,
      ok: [],
    };
    expect(qcDetectorCount(e)).toBe(4); // anomaly + GMM + duplicate + incomplete frame
  });

  it("Frame: by video, then frame", () => {
    useQcStore.getState().setReviewOrder("frame");
    expect(frames()).toEqual([3, 5, 7]);
  });

  it("drives F / → and keeps the current frame when the order changes", () => {
    useQcStore.getState().setReviewOrder("frame");
    useQcStore.setState({ reviewOpen: true });
    handleQcReviewKey("frame next");
    expect(useAppStore.getState().frameIdx).toBe(3);
    handleQcReviewKey("frame next");
    expect(useAppStore.getState().frameIdx).toBe(5);
    useQcStore.getState().setReviewOrder("severity");
    expect(useAppStore.getState().frameIdx).toBe(5);
    handleQcReviewKey("frame next"); // severity: 7, 5, 3
    expect(useAppStore.getState().frameIdx).toBe(3);
  });
});

describe("issue kind on a real file", () => {
  it("keeps edge issues as two-node edges and angle issues as joint + two arms", async () => {
    const fixture = await loadSlp(await Bun.file("tests/fixtures/centered_pair.slp").arrayBuffer(), {
      openVideos: false,
    });
    const r = scoreLabelsAnomaly(fixture);
    const edges = fixture.skeletons[0].edgeIndices;
    const adjacent = (a: number, b: number) =>
      edges.some(([s, d]) => (s === a && d === b) || (s === b && d === a));
    let nEdge = 0;
    let nAngle = 0;
    for (const i of r.instances) {
      const feature = topIssue(i.contributions).feature;
      if (feature === "max_edge_zscore" || feature === "max_pairwise_zscore") {
        nEdge++;
        expect(i.issueKind).toBe("edge");
        expect(i.issueNodes).toHaveLength(2);
        if (feature === "max_edge_zscore") expect(adjacent(i.issueNodes[0], i.issueNodes[1])).toBe(true);
        expect(Math.abs(i.issueDir)).toBe(1);
      }
      if (feature === "max_angle_zscore") {
        nAngle++;
        expect(i.issueKind).toBe("angle");
        expect(i.issueNodes).toHaveLength(3);
        // The joint first: both arms connect to it.
        const [joint, armA, armB] = i.issueNodes;
        expect(adjacent(joint, armA)).toBe(true);
        expect(adjacent(joint, armB)).toBe(true);
      }
      if (i.issueNodes.length === 0) expect(i.issueKind).toBeNull();
      if (feature === "visibility_rate") expect(i.issueDir).toBe(0);
    }
    expect(nEdge).toBeGreaterThan(0);
    expect(nAngle).toBeGreaterThan(0);
  });

  it("reads as the issue, its direction and the node(s)", () => {
    const names = skeleton.nodeNames;
    const v = (by: AnomalyVerdict["by"], issue: string): AnomalyVerdict => ({ flagged: true, by, score: 1, confidence: "high", issue });
    const a = scored(3, 0, 0.9, 0.99);
    expect(qcIssueText(a, v("anomaly", "Unusual joint angle"), names)).toBe("Unusual joint angle (decreased) · thorax");
    expect(
      qcIssueText({ ...a, issueKind: "edge", issueNodes: [0, 1], issueDir: 1 }, v("both", "Unusual edge length"), names),
    ).toBe("Unusual edge length (increased) · head – thorax");
    expect(qcIssueText(a, v("gmm", "Improbable pose"), names)).toBe("Improbable pose · tail");
  });
});

describe("drawing edge and angle issues", () => {
  const anomaly = (a: AnomalyInstance) => ({
    a,
    v: { flagged: true, by: "anomaly", score: 0.9, confidence: "high", issue: "x" } as AnomalyVerdict,
  });
  const entry = (anomalies: QcQueueEntry["anomalies"]): QcQueueEntry => ({
    videoIdx: 0, frameIdx: 3, rules: [], definite: false, anomalies, worst: 0.9, ok: [],
  });

  it("qcCanvasFlags: an edge issue becomes an edge, an angle a [joint, arm, arm], a GMM node a ring", () => {
    const lf = lfAt(3);
    const edge = { ...scored(3, 0, 0.9), issueKind: "edge" as const, issueNodes: [0, 1] };
    expect(qcCanvasFlags(entry([anomaly(edge)]), lf, false)[0]).toMatchObject({ nodes: [], edges: [[0, 1]], angles: [] });
    expect(qcCanvasFlags(entry([anomaly(scored(3, 0, 0.9))]), lf, false)[0]).toMatchObject({ nodes: [], edges: [], angles: [[1, 0, 2]] });
    const both = { a: scored(3, 0, 0.9, 0.99), v: { ...anomaly(edge).v, by: "both" as const } };
    expect(qcCanvasFlags(entry([both]), lf, false)[0]).toMatchObject({ nodes: [2], angles: [[1, 0, 2]] });
  });

  const rendered = (): RenderedInstance => ({
    // thorax (the joint) at (20, 20), head at (10, 20), tail at (20, 30): a right angle.
    nodes: [[10, 20], [20, 20], [20, 30]].map(([x, y], i) => ({ x, y, visible: true, complete: true, name: `n${i}` })),
    edges: [],
    color: [255, 0, 0],
    isPredicted: false,
    isSelected: false,
    trackName: null,
    visible: true,
    showNonVisible: true,
  });
  const opts = { markerSize: 4, zoom: 1 } as RenderOptions;
  const fakeCtx = () => {
    const calls: { k: string; a: number[] }[] = [];
    const ctx = new Proxy(
      {},
      {
        get: (_t, k) =>
          ["moveTo", "lineTo", "arc", "stroke", "strokeRect"].includes(String(k))
            ? (...a: number[]) => calls.push({ k: String(k), a })
            : () => {},
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
    return { ctx, calls };
  };

  it("draws an edge as one line, stroked twice (dark casing, red dashes)", () => {
    const { ctx, calls } = fakeCtx();
    renderQcFlags(ctx, [rendered()], [{ instanceIdx: 0, nodes: [], edges: [[0, 1]] }], opts);
    expect(calls.filter((c) => c.k === "moveTo").map((c) => c.a)).toEqual([[10, 20]]);
    expect(calls.filter((c) => c.k === "lineTo").map((c) => c.a)).toEqual([[20, 20]]);
    expect(calls.filter((c) => c.k === "stroke")).toHaveLength(2);
    expect(calls.filter((c) => c.k === "arc")).toHaveLength(0);
  });

  it("draws an angle as both arms through the joint plus an arc at the joint, the short way round", () => {
    const { ctx, calls } = fakeCtx();
    renderQcFlags(ctx, [rendered()], [{ instanceIdx: 0, nodes: [], angles: [[1, 0, 2]] }], opts);
    expect(calls.filter((c) => c.k === "moveTo").map((c) => c.a)).toEqual([[10, 20]]);
    expect(calls.filter((c) => c.k === "lineTo").map((c) => c.a)).toEqual([[20, 20], [20, 30]]);
    const arcs = calls.filter((c) => c.k === "arc");
    expect(arcs).toHaveLength(1);
    const [x, y, , start, end] = arcs[0].a;
    expect([x, y]).toEqual([20, 20]);
    expect(Math.abs(end - start)).toBeCloseTo(Math.PI / 2);
  });
});

describe("review mode", () => {
  it("the Review button opens it at the first flag", () => {
    render(<LabelQcPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(useQcStore.getState().reviewOpen).toBe(true);
    expect(useAppStore.getState().frameIdx).toBe(7);
    expect(useAppStore.getState().instance).toBe(lfAt(7).userInstances[1]);
  });

  it("the Review button is disabled with nothing flagged", () => {
    useQcStore.setState({ findings: [], anomaly: { ...RESULT, instances: [] } });
    render(<LabelQcPanel />);
    expect((screen.getByRole("button", { name: "Review" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("opens at the flagged frame on screen", () => {
    useAppStore.setState({ frameIdx: 5 });
    openQcReview();
    expect(useAppStore.getState().frameIdx).toBe(5);
  });

  describe("keys", () => {
    const press = (key: string, code = key) =>
      act(() => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key, code, bubbles: true }));
      });
    beforeEach(() => {
      renderHook(() => useKeyboardShortcuts());
    });

    it("← / → step frames while review is closed", () => {
      useAppStore.setState({ frameIdx: 10 });
      press("ArrowRight");
      expect(useAppStore.getState().frameIdx).toBe(11);
      press("ArrowLeft");
      expect(useAppStore.getState().frameIdx).toBe(10);
    });

    it("← / → step flags while review is open, Esc closes it", () => {
      openQcReview(); // frame 7
      press("ArrowRight");
      expect(useAppStore.getState().frameIdx).toBe(5);
      press("ArrowRight");
      expect(useAppStore.getState().frameIdx).toBe(3);
      press("ArrowLeft");
      expect(useAppStore.getState().frameIdx).toBe(5);
      expect(useAppStore.getState().sidebarOpenPanels).not.toContain("qc");
      press("Escape");
      expect(useQcStore.getState().reviewOpen).toBe(false);
      press("ArrowRight");
      expect(useAppStore.getState().frameIdx).toBe(6);
    });

    it("3 ignores the flag and goes to the next", () => {
      openQcReview(); // frame 7, instance 1
      useAppStore.setState({ labeledFrame: lfAt(7) });
      press("3", "Digit3");
      expect(frames()).toEqual([5, 3]);
      expect(useAppStore.getState().frameIdx).toBe(5);
      expect(useQcStore.getState().reviewOpen).toBe(true);
    });
  });

  it("shows the header, issue and footer around the canvas, and switches the order", () => {
    useAppStore.setState({ frameIdx: 3, labeledFrame: lfAt(3), instance: lfAt(3).userInstances[0] });
    useQcStore.setState({ reviewOpen: true });
    render(
      <QcReviewFrame>
        <div data-testid="canvas" />
      </QcReviewFrame>,
    );
    expect(screen.getByTestId("canvas")).toBeTruthy();
    expect(screen.getByText("3 / 3")).toBeTruthy();
    expect(screen.getByText("Unusual joint angle (decreased) · thorax")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Frame" }));
    expect(useQcStore.getState().reviewOrder).toBe("frame");
    expect(screen.getByText("1 / 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close Review" }));
    expect(useQcStore.getState().reviewOpen).toBe(false);
    expect(screen.getByTestId("canvas")).toBeTruthy(); // the canvas stays
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("Delete instance deletes the selected instance through the command, so it can be undone", async () => {
    const lf = lfAt(7);
    const inst = lf.userInstances[1];
    useAppStore.setState({ frameIdx: 7, labeledFrame: lf, instance: inst });
    useQcStore.setState({ reviewOpen: true });
    render(
      <QcReviewFrame>
        <div />
      </QcReviewFrame>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Delete instance" }));
    expect(lfAt(7).instances).not.toContain(inst);
    expect(useAppStore.getState().instance).toBeNull();
    await commandContext.undo();
    expect(useAppStore.getState().labels!.labeledFrames.some((f) => f.frameIdx === 7 && f.instances.length === 2)).toBe(true);
  });

  it("shows the canvas overlay with the Label QC panel closed", () => {
    useAppStore.setState({ frameIdx: 3, labeledFrame: lfAt(3), instance: lfAt(3).userInstances[0] });
    const { result } = renderHook(() => useQcFrameFlags());
    expect(result.current.flags).toEqual([]);
    act(() => useQcStore.getState().setReviewOpen(true));
    expect(result.current.flags.map((f) => f.instanceIdx)).toEqual([0]);
    expect(result.current.focusIdx).toBe(0);
  });

  it("closes when a different project loads", () => {
    useQcStore.setState({ reviewOpen: true });
    useAppStore.setState({ labels: project() });
    expect(useQcStore.getState().reviewOpen).toBe(false);
  });
});

describe("the problem node", () => {
  const v = (by: AnomalyVerdict["by"]): AnomalyVerdict => ({ flagged: true, by, score: 1, confidence: "high", issue: "x" });
  const e = (a: AnomalyInstance, by: AnomalyVerdict["by"]): QcQueueEntry => ({
    videoIdx: 0, frameIdx: 3, rules: [], definite: false, anomalies: [{ a, v: v(by) }], worst: 1, ok: [],
  });

  it("is the joint of an angle, the first node of an edge, the node, or the GMM's node", () => {
    const a = scored(3, 0, 0.9, 0.99); // angle [1, 0, 2], GMM node 2
    expect(qcProblemNode(e(a, "anomaly"), 0)).toBe(1);
    expect(qcProblemNode(e({ ...a, issueKind: "edge", issueNodes: [2, 1] }, "both"), 0)).toBe(2);
    expect(qcProblemNode(e({ ...a, issueKind: "node", issueNodes: [0] }, "anomaly"), 0)).toBe(0);
    expect(qcProblemNode(e(a, "gmm"), 0)).toBe(2);
    expect(qcProblemNode(e({ ...a, issueKind: null, issueNodes: [], gmmNode: null }, "anomaly"), 0)).toBeNull();
    expect(qcProblemNode(e(a, "anomaly"), 1)).toBeNull(); // not flagged
  });

  it("is selected on each step in Review (and not outside it)", () => {
    useAppStore.setState({ frameIdx: 5 });
    openQcReview();
    expect(useQcStore.getState().nodeFocus).toEqual({ instance: lfAt(5).userInstances[0], node: 1 });
    handleQcReviewKey("frame next"); // frame 3
    expect(useQcStore.getState().nodeFocus).toEqual({ instance: lfAt(3).userInstances[0], node: 1 });
    handleQcReviewKey("frame prev"); // frame 5
    handleQcReviewKey("frame prev"); // frame 7: a duplicate, no node
    expect(useQcStore.getState().nodeFocus).toBeNull();
    useQcStore.getState().setReviewOpen(false);
    useAppStore.setState({ frameIdx: 0 });
    handleQcReviewKey("frame next");
    expect(useAppStore.getState().frameIdx).toBe(0);
    expect(useQcStore.getState().nodeFocus).toBeNull();
  });
});

describe("placing an unplaced problem node", () => {
  const unplace = () => {
    lfAt(3).userInstances[0].points[1].xy = [NaN, NaN];
  };

  it("click vs drag vs long press", () => {
    expect(isPlacementClick(0, 80)).toBe(true);
    expect(isPlacementClick(3, 250)).toBe(true);
    expect(isPlacementClick(12, 80)).toBe(false); // a drag (it pans)
    expect(isPlacementClick(0, 600)).toBe(false); // a long press
  });

  it("shows the hint and targets that node in placement mode; a click places it and leaves the mode", () => {
    unplace();
    useAppStore.setState({ frameIdx: 3, labeledFrame: lfAt(3) });
    openQcReview();
    expect(useAppStore.getState().labelingMode).toBe("place");
    expect(useAppStore.getState().placementNodeIdx).toBe(1);
    const { container } = render(
      <QcReviewFrame>
        <div />
      </QcReviewFrame>,
    );
    expect(container.textContent).toContain("thorax isn't placed (click to place it)");

    act(() => placeQcReviewNode(42, 24));
    expect(lfAt(3).userInstances[0].points[1].xy).toEqual([42, 24]);
    expect(useAppStore.getState().labelingMode).toBe("select");
    expect(container.textContent).not.toContain("isn't placed");
    void commandContext.undo(); // the placement has its undo snapshot
    expect(Number.isNaN(useAppStore.getState().labels!.find({ video, frameIdx: 3 })[0].userInstances[0].points[1].xy[0])).toBe(true);
  });

  it("leaves placement mode when the next flag's node is placed", () => {
    unplace();
    useAppStore.setState({ frameIdx: 3 });
    openQcReview();
    expect(useAppStore.getState().labelingMode).toBe("place");
    handleQcReviewKey("frame prev"); // frame 5: its node is placed
    expect(useAppStore.getState().labelingMode).toBe("select");
  });

  describe("on the canvas", () => {
    /** The canvas that takes the mouse (the skeleton overlay). */
    const overlay = (container: HTMLElement) => container.querySelectorAll("canvas")[2] as HTMLCanvasElement;
    const setupPlacement = (review: boolean) => {
      const inst = lfAt(3).userInstances[0];
      inst.points[0].xy = [NaN, NaN];
      inst.points[2].xy = [NaN, NaN];
      if (review) {
        // Review aims at the flag's node (thorax, 1 here).
        inst.points[1].xy = [NaN, NaN];
        useAppStore.setState({ frameIdx: 3, labeledFrame: lfAt(3) });
        openQcReview();
        expect(useAppStore.getState().placementNodeIdx).toBe(1);
      } else {
        useAppStore.setState({
          frameIdx: 3,
          labeledFrame: lfAt(3),
          instance: inst,
          labelingMode: "place",
          placementNodeIdx: 0,
        });
      }
      const { container } = render(<VideoPlayer />);
      return { canvas: overlay(container), editSeq: useAppStore.getState().editSeq };
    };

    it("outside Review, placement places on press and moves on to the next unplaced node, as before", () => {
      const { canvas, editSeq } = setupPlacement(false);
      fireEvent.mouseDown(canvas, { button: 0, clientX: 30, clientY: 40 });
      expect(useAppStore.getState().editSeq).toBe(editSeq + 1); // placed on press
      expect(useAppStore.getState().placementNodeIdx).toBe(2);
      expect(useAppStore.getState().labelingMode).toBe("place");
    });

    it("in Review, a press places nothing until it is released as a click", () => {
      const { canvas, editSeq } = setupPlacement(true);
      fireEvent.mouseDown(canvas, { button: 0, clientX: 30, clientY: 40 });
      expect(useAppStore.getState().editSeq).toBe(editSeq);
      fireEvent.mouseUp(canvas, { button: 0, clientX: 30, clientY: 40 });
      expect(useAppStore.getState().editSeq).toBe(editSeq + 1);
      expect(Number.isNaN(lfAt(3).userInstances[0].points[1].xy[0])).toBe(false);
      expect(useAppStore.getState().labelingMode).toBe("select"); // only the flag's node
    });

    it("in Review, a drag places nothing", () => {
      const { canvas, editSeq } = setupPlacement(true);
      fireEvent.mouseDown(canvas, { button: 0, clientX: 30, clientY: 40 });
      fireEvent.mouseMove(canvas, { button: 0, clientX: 60, clientY: 70 });
      fireEvent.mouseUp(canvas, { button: 0, clientX: 60, clientY: 70 });
      expect(useAppStore.getState().editSeq).toBe(editSeq);
      expect(useAppStore.getState().labelingMode).toBe("place");
    });
  });
});

describe("two flagged instances on one frame", () => {
  // Frame 3: inst 0 (0.9) and inst 1 (0.85), both an angle at thorax (node 1).
  const twoOnFrame3 = () =>
    useQcStore.setState({
      findings: [],
      anomaly: { ...RESULT, instances: [scored(3, 0, 0.9), scored(3, 1, 0.85)] },
    });
  const unplaced = (inst: number, node: number) => {
    lfAt(3).userInstances[inst].points[node].xy = [NaN, NaN];
  };
  const mode = () => {
    const s = useAppStore.getState();
    return [s.labelingMode, s.placementNodeIdx];
  };

  beforeEach(() => {
    twoOnFrame3();
    useAppStore.setState({ frameIdx: 3, labeledFrame: lfAt(3) });
  });

  it("clicking the second instance (its node unplaced) aims placement at it, and a click places it", () => {
    unplaced(1, 1);
    openQcReview(); // the first instance, whose node is placed
    expect(useAppStore.getState().instance).toBe(lfAt(3).userInstances[0]);
    expect(mode()).toEqual(["select", null]);
    act(() => useAppStore.getState().setInstance(lfAt(3).userInstances[1])); // as a canvas click does
    expect(mode()).toEqual(["place", 1]);
    // The node you clicked stays selected (no forced node selection mid-drag).
    expect(useQcStore.getState().nodeFocus?.instance).not.toBe(lfAt(3).userInstances[1]);
    placeQcReviewNode(7, 8);
    expect(lfAt(3).userInstances[1].points[1].xy).toEqual([7, 8]);
    expect(useAppStore.getState().labelingMode).toBe("select");
  });

  it("3 on the first instance moves on to the second and aims placement at its node", () => {
    unplaced(1, 1);
    renderHook(() => useKeyboardShortcuts());
    openQcReview();
    expect(useAppStore.getState().instance).toBe(lfAt(3).userInstances[0]);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "3", code: "Digit3", bubbles: true }));
    });
    expect(useAppStore.getState().instance).toBe(lfAt(3).userInstances[1]);
    expect(mode()).toEqual(["place", 1]);
    placeQcReviewNode(9, 9);
    expect(lfAt(3).userInstances[1].points[1].xy).toEqual([9, 9]);
  });

  it("switching between two instances with different unplaced nodes retargets each time", () => {
    unplaced(0, 1);
    unplaced(1, 1);
    lfAt(3).userInstances[1].points[0].xy = [NaN, NaN]; // a non-problem node, unplaced too
    useQcStore.setState({
      anomaly: {
        ...RESULT,
        instances: [scored(3, 0, 0.9), { ...scored(3, 1, 0.85), issueKind: "node", issueNodes: [2] }],
      },
    });
    lfAt(3).userInstances[1].points[2].xy = [NaN, NaN];
    openQcReview();
    expect(mode()).toEqual(["place", 1]);
    act(() => useAppStore.getState().setInstance(lfAt(3).userInstances[1]));
    expect(mode()).toEqual(["place", 2]);
    act(() => useAppStore.getState().setInstance(lfAt(3).userInstances[0]));
    expect(mode()).toEqual(["place", 1]);
    act(() => useAppStore.getState().setInstance(lfAt(3).userInstances[1]));
    placeQcReviewNode(5, 5);
    expect(lfAt(3).userInstances[1].points[2].xy).toEqual([5, 5]);
    expect(Number.isNaN(lfAt(3).userInstances[1].points[0].xy[0])).toBe(true); // only the problem node
    expect(useAppStore.getState().labelingMode).toBe("select");
  });

  it("selecting an instance with nothing to place leaves placement mode", () => {
    unplaced(0, 1);
    openQcReview();
    expect(mode()).toEqual(["place", 1]);
    act(() => useAppStore.getState().setInstance(lfAt(3).userInstances[1]));
    expect(mode()).toEqual(["select", null]);
  });
});

describe("0 in Review", () => {
  const press0 = () =>
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "0", code: "Digit0", bubbles: true }));
    });
  beforeEach(() => {
    renderHook(() => useKeyboardShortcuts());
  });

  it("refits to the selected flagged instance", () => {
    useAppStore.setState({ frameIdx: 3 });
    openQcReview();
    useAppStore.setState({ fitSelection: false });
    press0();
    expect(useAppStore.getState().fitSelection).toBe(true);
    expect(useAppStore.getState().instance).toBe(lfAt(3).userInstances[0]);
  });

  it("goes back to the flagged instance when another is selected", () => {
    useAppStore.setState({ frameIdx: 3 });
    openQcReview();
    useAppStore.setState({ instance: lfAt(3).userInstances[1], fitSelection: false });
    press0();
    expect(useAppStore.getState().instance).toBe(lfAt(3).userInstances[0]);
    expect(useAppStore.getState().fitSelection).toBe(true);
  });

  it("does nothing outside Review", () => {
    useAppStore.setState({ frameIdx: 3, instance: lfAt(3).userInstances[0], fitSelection: false });
    press0();
    expect(useAppStore.getState().fitSelection).toBe(false);
  });
});

describe("re-scoring after a fix", () => {
  const setup = async () => {
    const fixture = await loadSlp(await Bun.file("tests/fixtures/centered_pair.slp").arrayBuffer(), {
      openVideos: false,
    });
    const result = scoreLabelsAnomaly(fixture);
    const gmmT = result.gmmThreshold;
    const flagged = result.instances
      .filter((a) => anomalyVerdict(a, 0.7, gmmT).flagged)
      .sort((x, y) => y.score - x.score)[0];
    const fv = fixture.videos[flagged.videoIdx];
    const lf = fixture.find({ video: fv, frameIdx: flagged.frameIdx })[0];
    useAppStore.setState({ labels: fixture, video: fv, frameIdx: flagged.frameIdx, instance: null });
    useQcStore.setState({
      labels: fixture,
      state: "done",
      findings: [],
      anomaly: result,
      threshold: 0.7,
      dismissed: new Set(),
      rescored: new Map(),
    });
    openQcReview();
    const instAt = (a: AnomalyInstance) =>
      fixture.find({ video: fixture.videos[a.videoIdx], frameIdx: a.frameIdx })[0].userInstances[a.instIdx];
    return {
      result,
      gmmT,
      flagged,
      lf,
      inst: lf.userInstances[flagged.instIdx],
      key: qcInstKey(flagged.videoIdx, flagged.frameIdx, flagged.instIdx),
      instAt,
    };
  };
  const edit = () => act(() => useAppStore.getState().markChanged());

  it("matches the run's scores for a pose nudged by a hair (nothing refit)", async () => {
    const { result, flagged, inst, key } = await setup();
    edit(); // no change yet: nothing re-scored
    expect(useQcStore.getState().rescored.size).toBe(0);
    inst.points[0].xy = [inst.points[0].xy[0] + 1e-7, inst.points[0].xy[1]];
    edit();
    const r = useQcStore.getState().rescored.get(key)!;
    expect(r.rescored).toBe(true);
    expect(r.score).toBeCloseTo(flagged.score, 9);
    // The GMM's share of more typical reference poses can count the instance's
    // own pose from the run: off by at most one pose.
    expect(Math.abs(r.gmmScore! - flagged.gmmScore!)).toBeLessThanOrEqual(1 / result.instances.length + 1e-9);
  });

  it("updates the scores live; a fixed pose stops flagging but stays in the queue until Rerun", async () => {
    const { result, gmmT, flagged, lf, inst, key, instAt } = await setup();
    const queueBefore = liveQcQueue().map((e) => `${e.videoIdx}:${e.frameIdx}`);
    const before = inst.points.map((p) => ({ xy: [...p.xy] as [number, number], visible: p.visible }));

    // "Fix" it: give it the pose of one of the most typical instances.
    const typical = [...result.instances].sort((x, y) => x.score - y.score).slice(0, 5);
    let fixed = false;
    for (const t of typical) {
      instAt(t).points.forEach((p, i) => {
        inst.points[i].xy = [...p.xy] as [number, number];
        inst.points[i].visible = p.visible;
      });
      edit();
      const r = useQcStore.getState().rescored.get(key)!;
      expect(r.rescored).toBe(true);
      if (!anomalyVerdict(r, 0.7, gmmT).flagged) {
        fixed = true;
        break;
      }
    }
    expect(fixed).toBe(true);
    expect(useQcStore.getState().rescored.get(key)!.score).toBeLessThan(flagged.score);
    expect(liveQcQueue().map((e) => `${e.videoIdx}:${e.frameIdx}`)).toEqual(queueBefore);

    const { container } = render(
      <QcReviewFrame>
        <div />
      </QcReviewFrame>,
    );
    act(() => useAppStore.setState({ instance: inst, labeledFrame: lf }));
    expect(container.textContent).toContain("Looks OK now");
    expect(
      screen.getAllByTitle("Scored against the last run; Rerun to re-check against all labels.").length,
    ).toBeGreaterThan(0);

    // Back to the pose the run scored: the re-score goes away.
    inst.points.forEach((p, i) => {
      p.xy = before[i].xy;
      p.visible = before[i].visible;
    });
    edit();
    expect(useQcStore.getState().rescored.has(key)).toBe(false);
  });

  it("doesn't run outside Review, and Rerun drops it", async () => {
    const { inst, key } = await setup();
    useQcStore.getState().setReviewOpen(false);
    inst.points[0].xy = [inst.points[0].xy[0] + 5, inst.points[0].xy[1]];
    edit();
    expect(useQcStore.getState().rescored.size).toBe(0);
    useQcStore.getState().setReviewOpen(true);
    edit();
    expect(useQcStore.getState().rescored.has(key)).toBe(true);
    const rerun = useQcStore.getState().run(useAppStore.getState().labels!);
    expect(useQcStore.getState().rescored.size).toBe(0);
    useQcStore.getState().cancel();
    await rerun;
  });
});
