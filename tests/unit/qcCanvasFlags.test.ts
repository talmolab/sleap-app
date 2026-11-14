/**
 * Label QC on the canvas: which instances get a dashed box and which nodes a
 * circle (qcCanvasFlags), the drawing itself (renderQcFlags), and zooming to
 * the flagged instance on navigation.
 */
import { describe, it, expect, vi } from "../bun-test";
import {
  Labels,
  LabeledFrame,
  Instance,
  PredictedInstance,
  Skeleton,
  Video,
} from "@talmolab/sleap-io.js";
import type { AnomalyInstance, AnomalyVerdict } from "@/lib/analyze/qc/anomaly";
import type { QcFinding } from "@/lib/analyze/labelQc";
import type { QcQueueEntry } from "@/stores/qcStore";
import type { RenderedInstance, RenderOptions } from "@/canvas/SkeletonRenderer";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() }),
}));

const { qcCanvasFlags, useQcFrameFlags } = await import("@/hooks/useQcFrameFlags");
const { renderQcFlags, renderInstances, FOCUS_DIM_OPACITY } = await import("@/canvas/SkeletonRenderer");
const { useQcStore } = await import("@/stores/qcStore");
const { renderHook } = await import("@testing-library/react");
const { useAppStore } = await import("@/stores/appStore");
const { goToQcEntry } = await import("@/stores/qcStore");

const skeleton = new Skeleton({ nodes: ["a", "b", "c"], edges: [["a", "b"], ["b", "c"]] });
const video = new Video({ filename: "clip.mp4", openBackend: false, backendMetadata: { shape: [10, 100, 100, 1] } });
const pts = [[10, 10], [20, 20], [30, 30]];
const user0 = Instance.fromNumpy({ pointsData: pts, skeleton });
const user1 = Instance.fromNumpy({ pointsData: pts, skeleton });
const pred = PredictedInstance.fromNumpy({ pointsData: pts, skeleton });
// A prediction FIRST, so the frame's instance order differs from userInstances.
const lf = new LabeledFrame({ video, frameIdx: 2, instances: [pred, user0, user1] });

const anomalyOn = (instIdx: number, by: AnomalyVerdict["by"], issueNodes: number[], gmmNode: number | null) => ({
  a: {
    videoIdx: 0,
    frameIdx: 2,
    instIdx,
    score: 0.9,
    confidence: "high",
    topIssue: "Unusual edge length",
    issueNodes,
    contributions: {},
    gmmScore: 0.97,
    gmmIssue: null,
    gmmNode,
  } as AnomalyInstance,
  v: { flagged: true, by, score: 0.9, confidence: "high", issue: "x" } as AnomalyVerdict,
});

const entry = (over: Partial<QcQueueEntry>): QcQueueEntry => ({
  videoIdx: 0,
  frameIdx: 2,
  rules: [],
  definite: false,
  anomalies: [],
  worst: 0.9,
  ...over,
});

describe("qcCanvasFlags", () => {
  it("maps QC's userInstances index to the frame's instance index", () => {
    const flags = qcCanvasFlags(entry({ anomalies: [anomalyOn(1, "anomaly", [0, 1], null)] }), lf, false);
    expect(flags).toEqual([{ instanceIdx: 2, nodes: [0, 1], stale: false }]);
  });

  it("circles the anomaly's nodes and the GMM's node only for the checks that flagged", () => {
    expect(qcCanvasFlags(entry({ anomalies: [anomalyOn(0, "both", [0, 1], 2)] }), lf, false)[0].nodes).toEqual([0, 1, 2]);
    expect(qcCanvasFlags(entry({ anomalies: [anomalyOn(0, "gmm", [0, 1], 2)] }), lf, false)[0].nodes).toEqual([2]);
    expect(qcCanvasFlags(entry({ anomalies: [anomalyOn(0, "anomaly", [0, 1], 2)] }), lf, false)[0].nodes).toEqual([0, 1]);
  });

  it("boxes instances with a rule finding, merged with their anomaly flag", () => {
    const rule: QcFinding = { kind: "duplicate", message: "", video, videoIdx: 0, frameIdx: 2, instanceIdx: 0 };
    const flags = qcCanvasFlags(entry({ rules: [rule], anomalies: [anomalyOn(0, "anomaly", [1], null)] }), lf, true);
    expect(flags).toEqual([{ instanceIdx: 1, nodes: [1], stale: true }]);
  });

  it("skips frame-level findings, which name no instance", () => {
    const rule: QcFinding = { kind: "incomplete_frame", message: "", video, videoIdx: 0, frameIdx: 2 };
    expect(qcCanvasFlags(entry({ rules: [rule] }), lf, false)).toEqual([]);
  });
});

describe("renderQcFlags", () => {
  const rendered = (visible = true): RenderedInstance => ({
    nodes: pts.map(([x, y], i) => ({ x, y, visible: i !== 2, complete: true, name: `n${i}` })),
    edges: [],
    color: [255, 0, 0],
    isPredicted: false,
    isSelected: false,
    trackName: null,
    visible,
    showNonVisible: true,
  });
  const opts = { markerSize: 4, zoom: 2 } as RenderOptions;
  const fakeCtx = () => {
    const calls: string[] = [];
    const ctx = new Proxy(
      {},
      {
        get: (_t, k) => (k in { strokeRect: 1, arc: 1 } ? (...a: number[]) => calls.push(`${String(k)}:${a.slice(0, 2).join(",")}`) : () => {}),
        set: () => true,
      },
    ) as unknown as CanvasRenderingContext2D;
    return { ctx, calls };
  };

  it("draws a box around the visible nodes and a ring (casing + dashes) per flagged node", () => {
    const { ctx, calls } = fakeCtx();
    renderQcFlags(ctx, [rendered()], [{ instanceIdx: 0, nodes: [1] }], opts);
    expect(calls.filter((c) => c.startsWith("strokeRect"))).toHaveLength(1);
    expect(calls.filter((c) => c === "arc:20,20")).toHaveLength(2);
  });

  it("skips hidden instances and out-of-range indices", () => {
    const { ctx, calls } = fakeCtx();
    renderQcFlags(ctx, [rendered(false)], [{ instanceIdx: 0, nodes: [0] }, { instanceIdx: 5, nodes: [] }], opts);
    expect(calls).toEqual([]);
  });
});

describe("focus dimming", () => {
  const inst = (x: number): RenderedInstance => ({
    nodes: [{ x, y: 0, visible: true, complete: true, name: "a" }],
    edges: [],
    color: [255, 0, 0],
    isPredicted: false,
    isSelected: false,
    trackName: null,
    visible: true,
    showNonVisible: true,
  });
  /** globalAlpha in effect at each node's arc, keyed by its x. */
  const alphaPerInstance = (focus: RenderedInstance | null, instances: RenderedInstance[]) => {
    const seen = new Map<number, number>();
    const stack: number[] = [];
    let alpha = 1;
    const ctx = new Proxy(
      {},
      {
        get: (_t, k) => {
          if (k === "globalAlpha") return alpha;
          if (k === "save") return () => stack.push(alpha);
          if (k === "restore") return () => (alpha = stack.pop() ?? 1);
          if (k === "arc") return (x: number) => seen.set(x, alpha);
          return () => {};
        },
        set: (_t, k, v) => {
          if (k === "globalAlpha") alpha = v as number;
          return true;
        },
      },
    ) as unknown as CanvasRenderingContext2D;
    renderInstances(ctx, instances, { zoom: 1, poseOpacity: 1, showLabels: false, focusInstance: focus });
    return seen;
  };

  it("fades every pose but the focused one", () => {
    const [a, b, c] = [inst(1), inst(2), inst(3)];
    const seen = alphaPerInstance(b, [a, b, c]);
    expect(seen.get(2)).toBe(1);
    expect(seen.get(1)).toBeCloseTo(FOCUS_DIM_OPACITY);
    expect(seen.get(3)).toBeCloseTo(FOCUS_DIM_OPACITY);
  });

  it("fades nothing without a focus", () => {
    const seen = alphaPerInstance(null, [inst(1), inst(2)]);
    expect([...seen.values()]).toEqual([1, 1]);
  });
});

describe("useQcFrameFlags", () => {
  const labels = new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [lf] });
  const seed = (panelOpen: boolean) => {
    useAppStore.setState({
      labels,
      video,
      frameIdx: 2,
      labeledFrame: lf,
      instance: user0,
      sidebarCollapsed: false,
      sidebarOpenPanels: panelOpen ? ["videos", "qc"] : ["videos"],
    });
    useQcStore.setState({
      labels,
      state: "done",
      findings: [],
      anomaly: { instances: [anomalyOn(0, "anomaly", [1], null).a], featureNames: [], gmmThreshold: 0.95 },
      threshold: 0.7,
      editedFrames: new Set(),
    });
  };

  it("shows the flags, focused on the selected flagged instance, while the panel is open", () => {
    seed(true);
    const { result } = renderHook(() => useQcFrameFlags());
    expect(result.current.flags).toEqual([{ instanceIdx: 1, nodes: [1], stale: false }]);
    expect(result.current.focusIdx).toBe(1);
  });

  it("shows nothing while the panel is closed", () => {
    seed(false);
    const { result } = renderHook(() => useQcFrameFlags());
    expect(result.current).toEqual({ flags: [], focusIdx: null });
  });

  it("doesn't focus an unflagged selection", () => {
    seed(true);
    useAppStore.setState({ instance: user1 });
    const { result } = renderHook(() => useQcFrameFlags());
    expect(result.current.focusIdx).toBeNull();
  });
});

describe("goToQcEntry", () => {
  it("selects the flagged instance and asks the canvas to zoom to it", () => {
    const labels = new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [lf] });
    useAppStore.setState({ labels, video, frameIdx: 0, fitSelection: false });
    goToQcEntry(labels, entry({ anomalies: [anomalyOn(1, "anomaly", [], null)] }));
    const s = useAppStore.getState();
    expect(s.frameIdx).toBe(2);
    expect(s.instance).toBe(user1);
    expect(s.fitSelection).toBe(true);
  });
});
