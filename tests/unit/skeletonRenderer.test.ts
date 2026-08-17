import { describe, it, expect } from "../bun-test";
import {
  renderInstances,
  hitTestNode,
  hitTestInstance,
  nodesInRect,
  type RenderedInstance,
} from "@/canvas/SkeletonRenderer";

/** Minimal CanvasRenderingContext2D spy — counts arc() calls (one per drawn node). */
function mockCtx() {
  const calls = { arc: 0, beginPath: 0 };
  return new Proxy(
    {
      arc: () => { calls.arc++; },
      beginPath: () => { calls.beginPath++; },
    },
    {
      get(target, prop) {
        if (prop === "__calls") return calls;
        if (prop in target) return (target as Record<string, unknown>)[prop as string];
        return () => {}; // no-op for every other ctx method/prop
      },
      set: () => true, // swallow fillStyle/strokeStyle/etc.
    },
  ) as unknown as CanvasRenderingContext2D & { __calls: typeof calls };
}

function inst(over: Partial<RenderedInstance>): RenderedInstance {
  return {
    nodes: [{ x: 1, y: 1, visible: true, complete: true, name: "n" }],
    edges: [],
    color: [255, 0, 0],
    isPredicted: false,
    isSelected: false,
    trackName: null,
    visible: true,
    showNonVisible: true,
    ...over,
  };
}

/** CanvasRenderingContext2D spy that records every strokeStyle/fillStyle set. */
function mockCtxRecordingStyles() {
  const styles: { strokeStyle: unknown[]; fillStyle: unknown[] } = {
    strokeStyle: [],
    fillStyle: [],
  };
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "__styles") return styles;
        return () => {}; // no-op for every ctx method (arc, fill, stroke, ...)
      },
      set(_target, prop, value) {
        if (prop === "strokeStyle") styles.strokeStyle.push(value);
        if (prop === "fillStyle") styles.fillStyle.push(value);
        return true;
      },
    },
  ) as unknown as CanvasRenderingContext2D & { __styles: typeof styles };
}

describe("renderInstances per-instance flags", () => {
  it("skips instances with visible=false", () => {
    const ctx = mockCtx();
    renderInstances(ctx, [inst({ visible: false })], { showInstances: true });
    expect((ctx as unknown as { __calls: { arc: number } }).__calls.arc).toBe(0);
  });

  it("draws an occluded node only when that instance's showNonVisible is true", () => {
    const occluded = inst({
      nodes: [{ x: 1, y: 1, visible: false, complete: false, name: "n" }],
    });
    const onCtx = mockCtx();
    renderInstances(onCtx, [{ ...occluded, showNonVisible: true }], { showInstances: true });
    expect((onCtx as unknown as { __calls: { arc: number } }).__calls.arc).toBe(1);

    const offCtx = mockCtx();
    renderInstances(offCtx, [{ ...occluded, showNonVisible: false }], { showInstances: true });
    expect((offCtx as unknown as { __calls: { arc: number } }).__calls.arc).toBe(0);
  });
});

describe("hit-testing honors per-instance visibility", () => {
  const occludedInst = (over: Partial<RenderedInstance>) =>
    inst({ nodes: [{ x: 1, y: 1, visible: false, complete: false, name: "n" }], ...over });

  it("hitTestNode skips hidden instances (#2755 — not click-selectable)", () => {
    expect(hitTestNode([inst({ visible: false })], 1, 1, 10)).toBeNull();
    // sanity: the same instance visible IS hit
    expect(hitTestNode([inst({ visible: true })], 1, 1, 10)).toEqual({
      instanceIdx: 0,
      nodeIdx: 0,
    });
  });

  it("hitTestNode hits an occluded node only when inst.showNonVisible is true", () => {
    expect(hitTestNode([occludedInst({ showNonVisible: true })], 1, 1, 10)).toEqual({
      instanceIdx: 0,
      nodeIdx: 0,
    });
    expect(hitTestNode([occludedInst({ showNonVisible: false })], 1, 1, 10)).toBeNull();
  });

  it("hitTestNode also hits a node's rendered name label when labelHitTest is given", () => {
    const target = inst({ nodes: [{ x: 1, y: 1, visible: true, complete: true, name: "n" }] });
    const labelOpts = { zoom: 1, markerSize: 4, nodeLabelSize: 12 };
    // Point (10, -5): well outside the marker's own hit radius (dist ~10.8 from
    // (1,1)), but inside where renderNodeLabel actually draws "n"'s text box.
    expect(hitTestNode([target], 10, -5, 3)).toBeNull(); // no labelHitTest -> marker-only
    expect(hitTestNode([target], 10, -5, 3, labelOpts)).toEqual({
      instanceIdx: 0,
      nodeIdx: 0,
    });
  });

  it("hitTestNode excludes predicted instances from label hit-testing", () => {
    const predicted = inst({
      isPredicted: true,
      nodes: [{ x: 1, y: 1, visible: true, complete: true, name: "n" }],
    });
    const labelOpts = { zoom: 1, markerSize: 4, nodeLabelSize: 12 };
    expect(hitTestNode([predicted], 10, -5, 3, labelOpts)).toBeNull();
  });

  it("hitTestInstance skips hidden instances", () => {
    expect(hitTestInstance([inst({ visible: false })], 1, 1, 30)).toBeNull();
    expect(hitTestInstance([inst({ visible: true })], 1, 1, 30)).toBe(0);
  });

  it("nodesInRect skips hidden instances", () => {
    expect(nodesInRect([inst({ visible: false })], 0, 0, 2, 2).size).toBe(0);
    expect(nodesInRect([inst({ visible: true })], 0, 0, 2, 2).size).toBe(1);
  });
});

describe("predicted instances use their track/instance color, not a fixed hue (#267)", () => {
  it("renders a predicted node's stroke in its computed instance color when colorPredicted is on", () => {
    const ctx = mockCtxRecordingStyles();
    const predicted = inst({
      isPredicted: true,
      color: [10, 20, 30],
      nodes: [{ x: 1, y: 1, visible: true, complete: true, name: "n" }],
    });
    renderInstances(ctx, [predicted], { showInstances: true, colorPredicted: true });
    const strokes = ctx.__styles.strokeStyle;
    // The node marker's stroke must be the instance's own color -- never a
    // hardcoded color unrelated to the instance/track.
    expect(strokes).toContain("rgb(10, 20, 30)");
    expect(strokes.some((s) => String(s).includes("250, 204, 21"))).toBe(false);
  });

  it("falls back to PyQt's uncolored_prediction_color (yellow) for node strokes when colorPredicted is off", () => {
    const ctx = mockCtxRecordingStyles();
    const predicted = inst({
      isPredicted: true,
      color: [10, 20, 30],
      nodes: [{ x: 1, y: 1, visible: true, complete: true, name: "n" }],
    });
    // colorPredicted defaults to false -- matches PyQt's ColorManager:
    // `if is_predicted and not color_predicted: return uncolored_prediction_color
    // if isinstance(item, Node) else (128, 128, 128)`.
    renderInstances(ctx, [predicted], { showInstances: true });
    const strokes = ctx.__styles.strokeStyle;
    expect(strokes).toContain("rgb(250, 250, 10)");
    expect(strokes).not.toContain("rgb(10, 20, 30)");
  });

  it("renders a predicted edge in its computed instance color", () => {
    const ctx = mockCtxRecordingStyles();
    const predicted = inst({
      isPredicted: true,
      color: [40, 50, 60],
      nodes: [
        { x: 1, y: 1, visible: true, complete: true, name: "a" },
        { x: 2, y: 2, visible: true, complete: true, name: "b" },
      ],
      edges: [{ srcIdx: 0, dstIdx: 1 }],
    });
    renderInstances(ctx, [predicted], { showInstances: true, showEdges: true });
    const strokes = ctx.__styles.strokeStyle.map(String);
    expect(strokes.some((s) => s.startsWith("rgba(40, 50, 60,"))).toBe(true);
    expect(strokes.some((s) => s.includes("250, 204, 21"))).toBe(false);
  });
});
