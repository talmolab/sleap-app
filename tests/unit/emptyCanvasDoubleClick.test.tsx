/**
 * Unit & VideoPlayer integration tests for double-clicking an empty region of
 * the canvas to create a new instance at the clicked coordinates.
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from "../bun-test";
import { render, fireEvent, cleanup, act } from "@testing-library/react";
import {
  Instance,
  LabeledFrame,
  Labels,
  PredictedInstance,
  Skeleton,
  Video,
} from "@talmolab/sleap-io.js";
import {
  resolveEmptyCanvasDoubleClick,
  type EmptyCanvasDoubleClickContext,
} from "@/lib/canvasDoubleClick";
import { useAppStore } from "@/stores/appStore";
import { commandContext } from "@/commands/CommandContext";

vi.mock("@/lib/platform", () => ({ isTauri: false, isMac: false, modKey: "Ctrl" }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

function baseCtx(
  overrides: Partial<EmptyCanvasDoubleClickContext> = {},
): EmptyCanvasDoubleClickContext {
  return {
    isZoomBoxGesture: false,
    shouldPan: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    skeletonBuildMode: false,
    bboxDrawMode: false,
    areaDeleteMode: false,
    imageFeatureRoiDrawActive: false,
    pickingAnchor: false,
    instanceSequencePick: false,
    isPlacingNodes: false,
    recentPlacementClick: false,
    hasProject: true,
    skeletonNodeCount: 3,
    showInstances: true,
    isViewOnly: false,
    ...overrides,
  };
}

describe("resolveEmptyCanvasDoubleClick pure routing", () => {
  it("returns add-instance for plain unmodified double-click when editable", () => {
    expect(resolveEmptyCanvasDoubleClick(baseCtx())).toBe("add-instance");
  });

  it("prioritizes Alt+double-click zoom reset over everything else", () => {
    expect(
      resolveEmptyCanvasDoubleClick(baseCtx({ isZoomBoxGesture: true, altKey: true })),
    ).toBe("reset-zoom");
    expect(
      resolveEmptyCanvasDoubleClick(
        baseCtx({ isZoomBoxGesture: true, altKey: true, shouldPan: true }),
      ),
    ).toBe("reset-zoom");
  });

  it("resets pan/zoom in pan mode instead of creating an instance", () => {
    expect(resolveEmptyCanvasDoubleClick(baseCtx({ shouldPan: true }))).toBe(
      "reset-pan-zoom",
    );
  });

  it("returns none for every tool/modal/view-only/modifier/empty-project guard", () => {
    const blockedCases: Array<Partial<EmptyCanvasDoubleClickContext>> = [
      { altKey: true },
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { skeletonBuildMode: true },
      { bboxDrawMode: true },
      { areaDeleteMode: true },
      { imageFeatureRoiDrawActive: true },
      { pickingAnchor: true },
      { instanceSequencePick: true },
      { isPlacingNodes: true },
      { recentPlacementClick: true },
      { hasProject: false },
      { skeletonNodeCount: 0 },
      { showInstances: false },
      { isViewOnly: true },
    ];
    for (const overrides of blockedCases) {
      expect(resolveEmptyCanvasDoubleClick(baseCtx(overrides))).toBe("none");
    }
  });
});

function setupProject(options: {
  instances?: Instance[];
  viewOnly?: boolean;
  defaultToPan?: boolean;
  bboxDrawMode?: boolean;
  areaDeleteMode?: boolean;
  labelingMode?: "select" | "place";
  placementNodeIdx?: number | null;
} = {}) {
  const skeleton = new Skeleton({ nodes: ["head", "thorax", "tail"], name: "mouse" });
  const video = new Video({
    filename: "clip.mp4",
    backendMetadata: { shape: [20, 400, 600, 3] },
    openBackend: false,
  });
  const lf = options.instances
    ? new LabeledFrame({ video, frameIdx: 0, instances: options.instances })
    : null;
  const labels = new Labels({
    videos: [video],
    skeletons: [skeleton],
    labeledFrames: lf ? [lf] : [],
  });
  if (options.viewOnly) {
    labels.sourceFormat = Object.freeze({
      formatId: 3,
      access: "view",
      labelsPath: "ro.slp",
      summary: {
        formatId: 3,
        unlabeledPoints: 0,
        unlabeledUserPoints: 0,
        unlabeledPredictedPoints: 0,
        metadataKeys: { instances: [], frames: [], bboxes: [] },
        unknownColumns: [],
        unreadTables: [],
        lossless: false,
      },
    });
  }

  useAppStore.setState(useAppStore.getInitialState());
  commandContext.reset();
  useAppStore.setState({
    labels,
    video,
    skeleton,
    frameIdx: 0,
    labeledFrame: lf,
    instance: lf?.instances[0] ?? null,
    defaultToPan: options.defaultToPan ?? false,
    bboxDrawMode: options.bboxDrawMode ?? false,
    areaDeleteMode: options.areaDeleteMode ?? false,
    labelingMode: options.labelingMode ?? "select",
    placementNodeIdx: options.placementNodeIdx ?? null,
  });
  return { labels, video, skeleton, lf };
}

function getOverlayCanvas(container: HTMLElement): HTMLCanvasElement {
  // VideoPlayer mounts 3 canvases in order: frame, heatmap, overlay.
  const canvases = container.querySelectorAll("canvas");
  const overlay = canvases[2] as HTMLCanvasElement;
  expect(overlay).toBeDefined();
  // Give the overlay canvas a 1:1 600x400 rect at (0, 0) so clientX/Y == scene x/y.
  overlay.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: 600,
      bottom: 400,
      width: 600,
      height: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  return overlay;
}

describe("VideoPlayer empty-canvas double-click integration", () => {
  beforeEach(() => {
    cleanup();
    useAppStore.setState(useAppStore.getInitialState());
    commandContext.reset();
  });

  it("creates a new user instance centered at the double-clicked coordinates and is undoable", async () => {
    const { labels } = setupProject();
    const { VideoPlayer } = await import("@/components/video/VideoPlayer");
    const { container } = render(<VideoPlayer />);
    const overlay = getOverlayCanvas(container);

    await act(async () => {
      fireEvent.doubleClick(overlay, { clientX: 250, clientY: 180 });
    });

    const lf = labels.labeledFrames[0];
    expect(lf).toBeDefined();
    expect(lf.instances).toHaveLength(1);
    const created = lf.instances[0];
    expect(useAppStore.getState().instance).toBe(created);

    // Centroid matches the clicked scene coordinates (250, 180).
    const cx = created.points.reduce((s, p) => s + p.xy[0], 0) / created.points.length;
    const cy = created.points.reduce((s, p) => s + p.xy[1], 0) / created.points.length;
    expect(cx).toBeCloseTo(250, 3);
    expect(cy).toBeCloseTo(180, 3);

    // Undo removes the newly added instance.
    act(() => {
      expect(commandContext.undo()).toBe(true);
    });
    expect(labels.labeledFrames.flatMap((f) => f.instances)).toHaveLength(0);
  });

  it("does not add an instance in pan mode, box draw mode, area delete mode, placement mode, or view-only mode", async () => {
    const { VideoPlayer } = await import("@/components/video/VideoPlayer");

    for (const opts of [
      { defaultToPan: true },
      { bboxDrawMode: true },
      { areaDeleteMode: true },
      { viewOnly: true },
    ]) {
      const { labels } = setupProject(opts);
      const { container } = render(<VideoPlayer />);
      const overlay = getOverlayCanvas(container);

      await act(async () => {
        fireEvent.doubleClick(overlay, { clientX: 150, clientY: 150 });
      });

      expect(labels.labeledFrames.flatMap((f) => f.instances)).toHaveLength(0);
      cleanup();
    }

    // Alt+double-click resets zoom without creating an instance.
    const { labels: altLabels } = setupProject();
    const { container: altContainer } = render(<VideoPlayer />);
    const altOverlay = getOverlayCanvas(altContainer);
    await act(async () => {
      fireEvent.doubleClick(altOverlay, { clientX: 150, clientY: 150, altKey: true });
    });
    expect(altLabels.labeledFrames.flatMap((f) => f.instances)).toHaveLength(0);
    cleanup();

    // Placement mode: placing the last unplaced node and firing dblclick right
    // after must NOT spawn a second instance.
    const sk = new Skeleton({ nodes: ["head", "tail"], name: "mouse" });
    const partial = new Instance({
      skeleton: sk,
      points: [
        { xy: [50, 50], visible: true, complete: true },
        { xy: [Number.NaN, Number.NaN], visible: false, complete: false },
      ],
    });
    const { labels: placeLabels } = setupProject({
      instances: [partial],
      labelingMode: "place",
      placementNodeIdx: 1,
    });
    useAppStore.setState({ skeleton: sk, instance: partial });
    const { container: placeContainer } = render(<VideoPlayer />);
    const placeOverlay = getOverlayCanvas(placeContainer);
    await act(async () => {
      fireEvent.mouseDown(placeOverlay, { button: 0, clientX: 200, clientY: 200 });
      fireEvent.doubleClick(placeOverlay, { clientX: 200, clientY: 200 });
    });
    expect(placeLabels.labeledFrames[0].instances).toHaveLength(1);
    expect(useAppStore.getState().labelingMode).toBe("select");
  });

  it("still converts a predicted instance when double-clicking on it instead of adding a blank one", async () => {
    const sk = new Skeleton({ nodes: ["head", "thorax", "tail"], name: "mouse" });
    const pred = new PredictedInstance({
      skeleton: sk,
      score: 0.9,
      points: [
        { xy: [100, 100], visible: true, complete: false, score: 0.9 },
        { xy: [120, 100], visible: true, complete: false, score: 0.9 },
        { xy: [140, 100], visible: true, complete: false, score: 0.9 },
      ],
    });
    const { lf } = setupProject({ instances: [pred] });
    useAppStore.setState({ skeleton: sk });
    const { VideoPlayer } = await import("@/components/video/VideoPlayer");
    const { container } = render(<VideoPlayer />);
    const overlay = getOverlayCanvas(container);

    await act(async () => {
      fireEvent.doubleClick(overlay, { clientX: 100, clientY: 100 });
    });

    expect(lf!.instances).toHaveLength(1);
    expect(lf!.instances[0]).not.toBeInstanceOf(PredictedInstance);
  });

  it("still runs AddMissingInstanceNodes when double-clicking a user instance instead of adding a new one", async () => {
    const sk = new Skeleton({ nodes: ["head", "thorax", "tail"], name: "mouse" });
    const userInst = new Instance({
      skeleton: sk,
      points: [
        { xy: [100, 100], visible: true, complete: true },
        { xy: [120, 100], visible: true, complete: true },
        { xy: [Number.NaN, Number.NaN], visible: false, complete: false },
      ],
    });
    const { lf } = setupProject({ instances: [userInst] });
    useAppStore.setState({ skeleton: sk, instance: userInst });
    const { VideoPlayer } = await import("@/components/video/VideoPlayer");
    const { container } = render(<VideoPlayer />);
    const overlay = getOverlayCanvas(container);

    await act(async () => {
      fireEvent.doubleClick(overlay, { clientX: 100, clientY: 100 });
    });

    expect(lf!.instances).toHaveLength(1);
    // The missing tail node was filled in (finite coords, non-visible).
    expect(Number.isFinite(userInst.points[2].xy[0])).toBe(true);
    expect(userInst.points[2].visible).toBe(false);
  });
});
