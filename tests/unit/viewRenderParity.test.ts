/**
 * Drawing side of the View-menu parity options: trail node / fade / opacity /
 * width, Bold Lines, the zoom-mode math, and the mean node score.
 */
import { describe, it, expect } from "../bun-test";
import {
  Instance,
  LabeledFrame,
  Labels,
  PredictedInstance,
  Skeleton,
  Track,
  Video,
} from "@talmolab/sleap-io.js";
import { renderTrails, trailPoint } from "@/canvas/TrailRenderer";
import { renderInstances, type RenderedInstance } from "@/canvas/SkeletonRenderer";
import { actualSizeView, fitPointsView } from "@/lib/viewZoom";
import { meanNodeScore } from "@/lib/meanNodeScore";

/** Canvas spy recording each stroke()'s style, width and path points. */
function recordingCtx() {
  const strokes: { style: string; width: number; path: [number, number][] }[] = [];
  let path: [number, number][] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (prop === "beginPath") return () => { path = []; };
      if (prop === "moveTo" || prop === "lineTo") return (x: number, y: number) => { path.push([x, y]); };
      if (prop === "stroke") return () => {
        strokes.push({ style: String(target.strokeStyle), width: Number(target.lineWidth), path });
      };
      if (prop === "measureText") return () => ({ width: 20 }) as TextMetrics;
      if (prop in target) return target[prop as string];
      return () => {};
    },
    set(target, prop, value) {
      target[prop as string] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, strokes };
}

/** Alpha of an `rgba(r, g, b, a)` string. */
const alphaOf = (css: string) => Number(css.match(/rgba\([^)]*,\s*([\d.]+)\)/)?.[1] ?? 1);

/** One track moving right 10 px a frame over frames 0-3; "tail" sits 100 px below "head". */
function movingTrack() {
  const sk = new Skeleton({ nodes: ["head", "tail"] });
  const video = new Video({ filename: "/v/a.mp4", backendMetadata: { shape: [10, 480, 640, 3] }, openBackend: false });
  const track = new Track("A");
  const frames = [0, 1, 2, 3].map((i) => {
    const inst = Instance.fromArray([[i * 10, 0], [i * 10, 100]], sk);
    inst.track = track;
    return new LabeledFrame({ video, frameIdx: i, instances: [inst] });
  });
  const labels = new Labels({ labeledFrames: frames, skeletons: [sk], videos: [video], tracks: [track] });
  return { labels, video, track };
}

describe("trails", () => {
  // Trail Node picks which point the trail follows.
  it("follows the centroid by default and a named node when chosen", () => {
    const { labels, video } = movingTrack();
    const centroid = recordingCtx();
    renderTrails(centroid.ctx, labels, 3, video, 10, labels.tracks, "standard", 1);
    expect(centroid.strokes.every((s) => s.path.every(([, y]) => y === 50))).toBe(true);

    const tail = recordingCtx();
    renderTrails(tail.ctx, labels, 3, video, 10, labels.tracks, "standard", 1, null, {
      node: "tail", alpha: 1, fade: true, width: 4,
    });
    expect(tail.strokes.length).toBe(3);
    expect(tail.strokes.every((s) => s.path.every(([, y]) => y === 100))).toBe(true);
  });

  // A hidden node has no position, so that frame drops out of the trail.
  it("skips frames where the chosen node isn't visible", () => {
    const sk = new Skeleton({ nodes: ["head", "tail"] });
    const inst = Instance.fromArray([[5, 6], [7, 8]], sk);
    inst.points[1].visible = false;
    expect(trailPoint(inst, "head", ["head", "tail"])).toEqual([5, 6]);
    expect(trailPoint(inst, "tail", ["head", "tail"])).toBeNull();
    // Unknown name (e.g. from another project) falls back to the centroid.
    expect(trailPoint(inst, "abdomen", ["head", "tail"])).toEqual([5, 6]);
  });

  // Fade on: newest segment brightest. Fade off: every segment at the chosen opacity.
  it("fades older segments only when Fade Older Trail Segments is on", () => {
    const { labels, video } = movingTrack();
    const faded = recordingCtx();
    renderTrails(faded.ctx, labels, 3, video, 10, labels.tracks, "standard", 1, null, {
      node: "centroid", alpha: 1, fade: true, width: 4,
    });
    const fadedAlphas = faded.strokes.map((s) => alphaOf(s.style));
    // Drawn oldest first, so alphas rise.
    expect(fadedAlphas[0]).toBeLessThan(fadedAlphas[fadedAlphas.length - 1]);

    const flat = recordingCtx();
    renderTrails(flat.ctx, labels, 3, video, 10, labels.tracks, "standard", 1, null, {
      node: "centroid", alpha: 0.5, fade: false, width: 4,
    });
    expect(flat.strokes.map((s) => alphaOf(s.style))).toEqual([0.5, 0.5, 0.5]);
  });

  // Trail Opacity scales every segment, faded or not.
  it("Trail Opacity scales the faded alphas", () => {
    const { labels, video } = movingTrack();
    const full = recordingCtx();
    const half = recordingCtx();
    const style = { node: "centroid", fade: true, width: 4 };
    renderTrails(full.ctx, labels, 3, video, 10, labels.tracks, "standard", 1, null, { ...style, alpha: 1 });
    renderTrails(half.ctx, labels, 3, video, 10, labels.tracks, "standard", 1, null, { ...style, alpha: 0.5 });
    full.strokes.forEach((s, i) => {
      expect(alphaOf(half.strokes[i].style)).toBeCloseTo(alphaOf(s.style) * 0.5, 5);
    });
  });

  // Trail Width is in screen pixels, so it is divided by the zoom.
  it("draws Trail Width in screen pixels at any zoom", () => {
    const { labels, video } = movingTrack();
    const { ctx, strokes } = recordingCtx();
    renderTrails(ctx, labels, 3, video, 10, labels.tracks, "standard", 2, null, {
      node: "centroid", alpha: 1, fade: true, width: 6,
    });
    expect(strokes.every((s) => s.width === 3)).toBe(true);
  });
});

describe("Bold Lines", () => {
  // PyQt's "bold lines" doubles the pen width of edges.
  it("doubles edge widths", () => {
    const ri: RenderedInstance = {
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
    const widths = (boldLines: boolean) => {
      const { ctx, strokes } = recordingCtx();
      renderInstances(ctx, [ri], { boldLines, showLabels: false, zoom: 1 });
      return strokes.map((s) => s.width);
    };
    const normal = widths(false);
    const bold = widths(true);
    expect(normal.length).toBeGreaterThan(0);
    expect(bold).toEqual(normal.map((w) => w * 2));
  });
});

describe("zoom math", () => {
  const fit = { cw: 800, ch: 600, baseScale: 0.5, offsetX: 0, offsetY: 60 };

  // Actual Size: one video pixel per screen pixel, same spot in the middle.
  it("Actual Size gives scale 1 and keeps the centre point", () => {
    const before = { zoom: 2, panX: -100, panY: 40 };
    const after = actualSizeView(before, fit);
    expect(fit.baseScale * after.zoom).toBe(1);
    const centre = (v: typeof before) => [
      (fit.cw / 2 - fit.offsetX - v.panX) / (fit.baseScale * v.zoom),
      (fit.ch / 2 - fit.offsetY - v.panY) / (fit.baseScale * v.zoom),
    ];
    expect(centre(after)[0]).toBeCloseTo(centre(before)[0], 6);
    expect(centre(after)[1]).toBeCloseTo(centre(before)[1], 6);
  });

  // Fitting to a selection centres its box and fills the canvas.
  it("fits and centres a box of points", () => {
    const v = fitPointsView([{ x: 100, y: 100 }, { x: 200, y: 150 }], fit, 0, 100)!;
    const scale = fit.baseScale * v.zoom;
    expect(fit.offsetX + v.panX + 150 * scale).toBeCloseTo(fit.cw / 2, 6);
    expect(fit.offsetY + v.panY + 125 * scale).toBeCloseTo(fit.ch / 2, 6);
    expect(100 * scale).toBeCloseTo(fit.cw, 6);
  });

  // No points (e.g. every node hidden) means leave the view alone.
  it("returns null with nothing to fit", () => {
    expect(fitPointsView([], fit)).toBeNull();
    expect(fitPointsView([{ x: NaN, y: NaN }], fit)).toBeNull();
  });
});

describe("mean node score", () => {
  // Same rule as PyQt's Instances dock: placed nodes only, NaN scores ignored.
  it("averages scores of nodes that have a position", () => {
    expect(
      meanNodeScore([
        { xy: [1, 1], score: 0.9 },
        { xy: [2, 2], score: 0.5 },
        { xy: [NaN, NaN], score: 0.1 },
        { xy: [3, 3], score: NaN },
      ]),
    ).toBeCloseTo(0.7, 6);
  });

  // User instances carry no point scores: show nothing rather than 0.
  it("is null without scores", () => {
    expect(meanNodeScore([{ xy: [1, 1] }])).toBeNull();
    expect(meanNodeScore([])).toBeNull();
  });

  // Works on a real predicted instance from sleap-io.js.
  it("reads PredictedInstance point scores", () => {
    const sk = new Skeleton({ nodes: ["a", "b"] });
    const pred = PredictedInstance.fromArray([[1, 1, 0.8], [2, 2, 0.4]], sk, 0.99);
    expect(meanNodeScore(pred.points)).toBeCloseTo(0.6, 6);
  });
});
