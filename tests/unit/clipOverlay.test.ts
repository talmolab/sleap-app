/**
 * Render Clip overlay options (PyQt render dialog parity): marker shape, line
 * width, opacity, node/edge switches and trail options, and the renderer
 * support behind them.
 */

import { describe, it, expect } from "../bun-test";
import { lineScale, renderInstances, type RenderedInstance } from "@/canvas/SkeletonRenderer";
import {
  clipOverlayRenderOptions,
  clipScalePreset,
  clipTrailStyle,
  initialClipOverlayStyle,
  type ClipOverlayViewSettings,
} from "@/lib/videoExport";

const VIEW: ClipOverlayViewSettings = {
  distinctlyColor: "track",
  palette: "alphabet",
  showLabels: true,
  nodeLabelSize: 10,
  markerSize: 6,
  boldLines: false,
  showEdges: true,
  trailLength: 0,
  trailNode: "head",
  trailWidth: 3,
  trailAlpha: 0.5,
  trailFade: false,
};

/** Records the ctx calls that draw markers and edges, plus each lineWidth set. */
function recordingCtx() {
  const calls: string[] = [];
  const lineWidths: number[] = [];
  const strokeStyles: string[] = [];
  const fillStyles: string[] = [];
  const ctx = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "measureText") return () => ({ width: 20 }) as TextMetrics;
        if (typeof prop === "string" && ["arc", "rect", "lineTo", "moveTo", "fill", "stroke"].includes(prop)) {
          return () => calls.push(prop);
        }
        return () => {};
      },
      set(_t, prop, value) {
        if (prop === "lineWidth") lineWidths.push(value as number);
        if (prop === "strokeStyle") strokeStyles.push(String(value));
        if (prop === "fillStyle") fillStyles.push(String(value));
        return true;
      },
    }
  ) as unknown as CanvasRenderingContext2D;
  return { ctx, calls, lineWidths, strokeStyles, fillStyles };
}

function inst(): RenderedInstance {
  return {
    nodes: [
      { x: 0, y: 0, visible: true, complete: true, name: "a" },
      { x: 10, y: 0, visible: true, complete: true, name: "b" },
    ],
    edges: [{ srcIdx: 0, dstIdx: 1 }],
    color: [255, 0, 0],
    isPredicted: false,
    isSelected: false,
    trackName: null,
    visible: true,
    showNonVisible: true,
  };
}

const base = { showLabels: false, zoom: 1 };

describe("initialClipOverlayStyle", () => {
  it("starts from the View, drawn solid", () => {
    const s = initialClipOverlayStyle(VIEW);
    expect(s.markerSize).toBe(6);
    expect(s.markerShape).toBe("circle");
    expect(s.lineWidth).toBe(2);
    expect(s.poseOpacity).toBe(1);
    expect(s.showNodes).toBe(true);
    expect(s.showEdges).toBe(true);
    expect(s.trailNode).toBe("head");
    expect(s.trailColor).toBeNull();
    expect(s.colorBy).toBe("track");
    // sleap-io has no "alphabet": PyQt's default palette instead.
    expect(s.palette).toBe("sleap-io/tableau10");
    expect(s.showNodeNames).toBe(true);
    expect(s.nodeLabelSize).toBe(10);
  });

  it("passes node names and their size to the renderer", () => {
    const s = { ...initialClipOverlayStyle(VIEW), showNodeNames: false, nodeLabelSize: 20 };
    const opts = clipOverlayRenderOptions(s);
    expect(opts.showLabels).toBe(false);
    expect(opts.nodeLabelSize).toBe(20);
  });

  it("turns bold lines into a 4 px line width", () => {
    const s = initialClipOverlayStyle({ ...VIEW, boldLines: true });
    expect(s.lineWidth).toBe(4);
    expect(clipOverlayRenderOptions(s).boldLines).toBe(false);
    expect(lineScale(clipOverlayRenderOptions(s))).toBe(2);
  });

  it("starts trails off, at PyQt's 10 frames, when the View has none", () => {
    const s = initialClipOverlayStyle(VIEW);
    expect(s.showTrails).toBe(false);
    expect(s.trailLength).toBe(10);
    expect(clipTrailStyle(s).length).toBe(0);
  });

  it("keeps the View's trail length when trails are on", () => {
    const s = initialClipOverlayStyle({ ...VIEW, trailLength: 25 });
    expect(s.showTrails).toBe(true);
    expect(clipTrailStyle(s).length).toBe(25);
  });
});

describe("clipTrailStyle", () => {
  it("maps a named color, or none to match poses", () => {
    const s = { ...initialClipOverlayStyle({ ...VIEW, trailLength: 5 }), trailColor: "cyan" };
    expect(clipTrailStyle(s).style).toEqual({ node: "head", alpha: 0.5, fade: false, width: 3, color: [0, 255, 255] });
    expect(clipTrailStyle({ ...s, trailColor: null }).style.color).toBeNull();
  });
});

describe("renderer options used by clips", () => {
  it("lineScale follows lineWidth and bold lines", () => {
    expect(lineScale({})).toBe(1);
    expect(lineScale({ lineWidth: 6 })).toBe(3);
    expect(lineScale({ lineWidth: 6, boldLines: true })).toBe(6);
  });

  it("draws circles by default and squares when asked", () => {
    const circle = recordingCtx();
    renderInstances(circle.ctx, [inst()], { ...base, showEdges: false });
    expect(circle.calls.filter((c) => c === "arc")).toHaveLength(2);
    expect(circle.calls).not.toContain("rect");

    const square = recordingCtx();
    renderInstances(square.ctx, [inst()], { ...base, showEdges: false, markerShape: "square" });
    expect(square.calls.filter((c) => c === "rect")).toHaveLength(2);
    expect(square.calls).not.toContain("arc");
  });

  it("draws a cross as two strokes and no fill", () => {
    const { ctx, calls } = recordingCtx();
    renderInstances(ctx, [{ ...inst(), nodes: [inst().nodes[0]], edges: [] }], { ...base, markerShape: "cross" });
    expect(calls.filter((c) => c === "moveTo")).toHaveLength(2);
    expect(calls.filter((c) => c === "lineTo")).toHaveLength(2);
  });

  it("skips node markers when showNodes is off, but still draws edges", () => {
    const { ctx, calls } = recordingCtx();
    renderInstances(ctx, [inst()], { ...base, showNodes: false });
    expect(calls).not.toContain("arc");
    expect(calls).toContain("lineTo");
  });

  it("draws user edges at lineWidth", () => {
    const { ctx, lineWidths } = recordingCtx();
    renderInstances(ctx, [inst()], { ...base, showNodes: false, lineWidth: 5 });
    expect(lineWidths).toContain(5);
  });
});

describe("clipScalePreset (PyQt's Quality presets)", () => {
  it("names the preset a scale matches, else custom", () => {
    expect(clipScalePreset(0.25)).toBe("preview");
    expect(clipScalePreset(0.5)).toBe("draft");
    expect(clipScalePreset(1)).toBe("final");
    expect(clipScalePreset(0.7)).toBe("custom");
  });
});

describe("solid poses (sleap-io / PyQt clip look)", () => {
  const solid = { ...base, solidPoses: true };

  it("is on for every clip, with predictions colored like user instances", () => {
    const opts = clipOverlayRenderOptions(initialClipOverlayStyle(VIEW));
    expect(opts.solidPoses).toBe(true);
    expect(opts.colorPredicted).toBe(true);
  });

  it("fills markers in the solid instance color with no outline", () => {
    const { ctx, calls, fillStyles } = recordingCtx();
    renderInstances(ctx, [inst()], { ...solid, showEdges: false });
    expect(calls.filter((c) => c === "fill")).toHaveLength(2);
    expect(calls).not.toContain("stroke");
    expect(fillStyles.every((f) => f === "rgb(255, 0, 0)" || f === "rgba(255, 0, 0, 1)")).toBe(true);
  });

  it("draws edges opaque at lineWidth", () => {
    const { ctx, lineWidths, strokeStyles } = recordingCtx();
    renderInstances(ctx, [inst()], { ...solid, showNodes: false, lineWidth: 3 });
    expect(lineWidths).toContain(3);
    expect(strokeStyles).toContain("rgb(255, 0, 0)");
  });

  it("skips hidden nodes and the edges touching them", () => {
    const { ctx, calls } = recordingCtx();
    const i = inst();
    i.nodes[1] = { ...i.nodes[1], visible: false };
    renderInstances(ctx, [i], solid);
    expect(calls.filter((c) => c === "fill")).toHaveLength(1);
    expect(calls).not.toContain("lineTo");
  });

  it("colors an edge like its destination node when nodes have their own colors", () => {
    const { ctx, strokeStyles } = recordingCtx();
    renderInstances(ctx, [{ ...inst(), nodeColors: [[0, 0, 255], [0, 255, 0]] }], { ...solid, showNodes: false });
    expect(strokeStyles).toContain("rgb(0, 255, 0)");
    expect(strokeStyles).not.toContain("rgb(0, 0, 255)");
  });

  it("draws predictions like user instances: solid, not dashed", () => {
    const dashes: number[][] = [];
    const { ctx, calls } = recordingCtx();
    (ctx as unknown as { setLineDash: (d: number[]) => void }).setLineDash = (d) => dashes.push(d);
    renderInstances(ctx, [{ ...inst(), isPredicted: true }], solid);
    expect(calls.filter((c) => c === "fill")).toHaveLength(2);
    expect(dashes.filter((d) => d.length > 0)).toHaveLength(0);
  });

  it("strokes a + cross, as sleap-io does", () => {
    const { ctx, calls, lineWidths } = recordingCtx();
    renderInstances(ctx, [{ ...inst(), nodes: [inst().nodes[0]], edges: [] }], { ...solid, markerShape: "cross", markerSize: 5 });
    expect(calls.filter((c) => c === "stroke")).toHaveLength(1);
    expect(calls).not.toContain("fill");
    expect(lineWidths).toContain(2); // 0.4 × marker size
  });
});
