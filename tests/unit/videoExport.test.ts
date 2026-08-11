import { describe, it, expect } from "../bun-test";
import {
  Instance,
  PredictedInstance,
  Skeleton,
  Track,
  Video,
} from "@talmolab/sleap-io.js";
import {
  resolveClipFrameRange,
  computeInitialClipRange,
  pixelToFrame,
  frameToPixel,
  clampHandleDrag,
  buildInitialClipConfigs,
  clipExportReducer,
  runClipExportBatch,
  type ClipConfig,
  computeClipOutputDimensions,
  deriveClipFilename,
  planClipTimeline,
  evaluateClipEncodeSupport,
  buildExportRenderedInstances,
  runClipExport,
  clampClipScale,
  clipBackgroundColor,
  inferFrameChannels,
  expandFrameBytesToRGBA,
  CLIP_SCALE_MIN,
  CLIP_SCALE_MAX,
  ClipExportCancelled,
  CLIP_EXPORT_CODEC,
  CLIP_EXPORT_UNSUPPORTED_MESSAGE,
  type FrameRange,
  type ClipEncoder,
  type ClipDrawContext,
} from "@/lib/videoExport";

// ---------------------------------------------------------------------------
// Pure: frame-range validation/clamping
// ---------------------------------------------------------------------------

describe("resolveClipFrameRange", () => {
  it("accepts an in-bounds inclusive range and computes count", () => {
    const r = resolveClipFrameRange(10, 20, 100);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.range).toEqual({ start: 10, end: 20, count: 11 });
  });

  it("clamps out-of-range values into [0, totalFrames-1]", () => {
    const r = resolveClipFrameRange(-5, 999, 100);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.range).toEqual({ start: 0, end: 99, count: 100 });
  });

  it("supports a single-frame range", () => {
    const r = resolveClipFrameRange(42, 42, 100);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.range).toEqual({ start: 42, end: 42, count: 1 });
  });

  it("floors fractional inputs", () => {
    const r = resolveClipFrameRange(2.9, 5.1, 100);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.range).toEqual({ start: 2, end: 5, count: 4 });
  });

  it("rejects an inverted range", () => {
    const r = resolveClipFrameRange(20, 10, 100);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/less than or equal/i);
  });

  it("rejects a video with no frames", () => {
    const r = resolveClipFrameRange(0, 0, 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no frames/i);
  });

  it("rejects NaN inputs", () => {
    const r = resolveClipFrameRange(NaN, 10, 100);
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pure: initial dialog range seeded from the timeline selection
// ---------------------------------------------------------------------------

describe("computeInitialClipRange", () => {
  it("defaults to the whole video when there is no selection", () => {
    expect(computeInitialClipRange(null, 100)).toEqual({ start: 0, end: 99 });
  });

  it("seeds from an active timeline selection (0-based inclusive)", () => {
    expect(computeInitialClipRange([10, 20], 100)).toEqual({ start: 10, end: 20 });
  });

  it("normalizes a reverse selection", () => {
    expect(computeInitialClipRange([20, 10], 100)).toEqual({ start: 10, end: 20 });
  });

  it("clamps a stale/out-of-range selection into [0, nFrames-1]", () => {
    expect(computeInitialClipRange([-5, 999], 100)).toEqual({ start: 0, end: 99 });
  });

  it("floors fractional selection bounds", () => {
    expect(computeInitialClipRange([2.9, 5.1], 100)).toEqual({ start: 2, end: 5 });
  });

  it("handles a video with no frames", () => {
    expect(computeInitialClipRange(null, 0)).toEqual({ start: 0, end: 0 });
    expect(computeInitialClipRange([3, 7], 0)).toEqual({ start: 0, end: 0 });
  });
});

// ---------------------------------------------------------------------------
// Pure: scrubbar pixel<->frame mapping + handle clamping (preview)
// ---------------------------------------------------------------------------

describe("pixelToFrame", () => {
  it("maps track ends to first/last frame", () => {
    expect(pixelToFrame(0, 100, 101)).toBe(0);
    expect(pixelToFrame(100, 100, 101)).toBe(100);
  });
  it("maps the midpoint to the middle frame", () => {
    expect(pixelToFrame(50, 100, 101)).toBe(50);
  });
  it("clamps out-of-track pixels", () => {
    expect(pixelToFrame(-10, 100, 101)).toBe(0);
    expect(pixelToFrame(200, 100, 101)).toBe(100);
  });
  it("returns 0 for a single-frame video or zero-width track", () => {
    expect(pixelToFrame(50, 100, 1)).toBe(0);
    expect(pixelToFrame(50, 0, 101)).toBe(0);
  });
});

describe("frameToPixel", () => {
  it("maps first/last frame to track ends", () => {
    expect(frameToPixel(0, 100, 101)).toBe(0);
    expect(frameToPixel(100, 100, 101)).toBe(100);
  });
  it("maps the middle frame to the midpoint", () => {
    expect(frameToPixel(50, 100, 101)).toBe(50);
  });
  it("returns 0 for a single-frame video", () => {
    expect(frameToPixel(0, 100, 1)).toBe(0);
  });
});

describe("clampHandleDrag", () => {
  it("passes an in-range start/end through (floored)", () => {
    expect(clampHandleDrag("start", 30.9, { start: 20, end: 80, len: 100 })).toBe(30);
    expect(clampHandleDrag("end", 60.9, { start: 20, end: 80, len: 100 })).toBe(60);
  });
  it("clamps the start handle to [0, end]", () => {
    expect(clampHandleDrag("start", -5, { start: 20, end: 80, len: 100 })).toBe(0);
    expect(clampHandleDrag("start", 90, { start: 20, end: 80, len: 100 })).toBe(80);
  });
  it("clamps the end handle to [start, len-1]", () => {
    expect(clampHandleDrag("end", 10, { start: 20, end: 80, len: 100 })).toBe(20);
    expect(clampHandleDrag("end", 200, { start: 20, end: 80, len: 100 })).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// Pure: multi-video config seeding + reducer (Phase 2)
// ---------------------------------------------------------------------------

function vid(len: number, name: string): Video {
  return new Video({
    filename: name,
    backendMetadata: { shape: [len, 480, 640, 3] },
    openBackend: false,
  });
}

describe("buildInitialClipConfigs", () => {
  it("seeds the current video from the selection, others full; only current included", () => {
    const a = vid(100, "a.mp4");
    const b = vid(200, "b.mp4");
    const st = buildInitialClipConfigs([a, b], a, [10, 20]);
    expect(st.focused).toBe(a);
    expect(st.configs.length).toBe(2);
    const ca = st.configs[0];
    expect(ca.video).toBe(a);
    expect(ca.include).toBe(true);
    expect(ca.start).toBe(10);
    expect(ca.end).toBe(20);
    expect(ca.fps).toBe(30);
    expect(ca.scale).toBe(1);
    expect(ca.background).toBe("original");
    const cb = st.configs[1];
    expect(cb.include).toBe(false);
    expect(cb.start).toBe(0);
    expect(cb.end).toBe(199);
  });

  it("defaults the current video to the whole video when there is no selection", () => {
    const a = vid(100, "a.mp4");
    const st = buildInitialClipConfigs([a], a, null);
    expect(st.configs[0].start).toBe(0);
    expect(st.configs[0].end).toBe(99);
    expect(st.configs[0].include).toBe(true);
  });

  it("focuses the first video and includes none when there is no current video", () => {
    const a = vid(100, "a.mp4");
    const b = vid(200, "b.mp4");
    const st = buildInitialClipConfigs([a, b], null, null);
    expect(st.focused).toBe(a);
    expect(st.configs.every((c) => !c.include)).toBe(true);
  });
});

describe("clipExportReducer", () => {
  const mk = () =>
    buildInitialClipConfigs([vid(100, "a.mp4"), vid(200, "b.mp4")], null, null);

  it("focuses a video", () => {
    const st = mk();
    const b = st.configs[1].video;
    expect(clipExportReducer(st, { type: "focus", video: b }).focused).toBe(b);
  });

  it("toggles include for one video without mutating the input", () => {
    const st = mk();
    const b = st.configs[1].video;
    const ns = clipExportReducer(st, { type: "toggleInclude", video: b });
    expect(ns.configs[1].include).toBe(true);
    expect(st.configs[1].include).toBe(false);
  });

  it("sets all included on and off", () => {
    const st = mk();
    expect(
      clipExportReducer(st, { type: "setAllIncluded", include: true }).configs.every((c) => c.include)
    ).toBe(true);
    expect(
      clipExportReducer(st, { type: "setAllIncluded", include: false }).configs.every((c) => !c.include)
    ).toBe(true);
  });

  it("sets range / fps / scale / background for a video", () => {
    const st = mk();
    const a = st.configs[0].video;
    expect(clipExportReducer(st, { type: "setRange", video: a, start: 5, end: 50 }).configs[0].start).toBe(5);
    expect(clipExportReducer(st, { type: "setRange", video: a, start: 5, end: 50 }).configs[0].end).toBe(50);
    expect(clipExportReducer(st, { type: "setFps", video: a, fps: 24 }).configs[0].fps).toBe(24);
    expect(clipExportReducer(st, { type: "setScale", video: a, scale: 0.5 }).configs[0].scale).toBe(0.5);
    expect(clipExportReducer(st, { type: "setBackground", video: a, background: "black" }).configs[0].background).toBe("black");
  });

  it("resets the whole state (re-seed on dialog open)", () => {
    const st = mk();
    const other = buildInitialClipConfigs([vid(50, "c.mp4")], null, null);
    expect(clipExportReducer(st, { type: "reset", state: other })).toBe(other);
  });
});

// ---------------------------------------------------------------------------
// Pure: per-video filename + sequential batch runner (Phase 3)
// ---------------------------------------------------------------------------

describe("deriveClipFilename with a per-video label", () => {
  it("keeps the plain form when no video label is given", () => {
    expect(deriveClipFilename("proj.slp", { start: 10, end: 20 })).toBe("proj.clip_10-20.mp4");
  });
  it("inserts a sanitized video label (extension stripped)", () => {
    expect(deriveClipFilename("proj.slp", { start: 10, end: 20 }, "0001.jpg")).toBe("proj.0001.clip_10-20.mp4");
    expect(deriveClipFilename("proj.slp", { start: 0, end: 5 }, "my video.mp4")).toBe("proj.my_video.clip_0-5.mp4");
  });
});

describe("runClipExportBatch", () => {
  const cfg = (video: Video, include: boolean): ClipConfig => ({
    video,
    include,
    start: 0,
    end: 10,
    fps: 30,
    scale: 1,
    background: "original",
  });

  it("exports only the included videos, in order, reporting done", async () => {
    const a = vid(100, "a");
    const b = vid(100, "b");
    const c = vid(100, "c");
    const statuses: Array<[string, string]> = [];
    const summary = await runClipExportBatch([cfg(a, true), cfg(b, false), cfg(c, true)], {
      exportOne: async () => new Uint8Array([1]),
      saveOne: async () => "/out/x.mp4",
      onStatus: (v, s) => statuses.push([v.filename as string, s]),
      signal: new AbortController().signal,
    });
    expect(summary).toEqual({ done: 2, failed: 0, cancelled: 0 });
    expect(statuses.some(([f]) => f === "b")).toBe(false);
    expect(statuses.filter(([, s]) => s === "done").map(([f]) => f)).toEqual(["a", "c"]);
  });

  it("isolates a failure and continues (failure-isolation)", async () => {
    const a = vid(100, "a");
    const b = vid(100, "b");
    const summary = await runClipExportBatch([cfg(a, true), cfg(b, true)], {
      exportOne: async (config) => {
        if (config.video === a) throw new Error("boom");
        return new Uint8Array([1]);
      },
      saveOne: async () => "/out/x.mp4",
      onStatus: () => {},
      signal: new AbortController().signal,
    });
    expect(summary).toEqual({ done: 1, failed: 1, cancelled: 0 });
  });

  it("cancels the remaining videos when a job is cancelled", async () => {
    const a = vid(100, "a");
    const b = vid(100, "b");
    const summary = await runClipExportBatch([cfg(a, true), cfg(b, true)], {
      exportOne: async () => {
        throw new ClipExportCancelled();
      },
      saveOne: async () => "/out/x.mp4",
      onStatus: () => {},
      signal: new AbortController().signal,
    });
    expect(summary).toEqual({ done: 0, failed: 0, cancelled: 2 });
  });

  it("marks all cancelled when the signal is already aborted", async () => {
    const a = vid(100, "a");
    const b = vid(100, "b");
    const ac = new AbortController();
    ac.abort();
    const summary = await runClipExportBatch([cfg(a, true), cfg(b, true)], {
      exportOne: async () => new Uint8Array([1]),
      saveOne: async () => "/out/x.mp4",
      onStatus: () => {},
      signal: ac.signal,
    });
    expect(summary).toEqual({ done: 0, failed: 0, cancelled: 2 });
  });
});

// ---------------------------------------------------------------------------
// Pure: output-dimension derivation
// ---------------------------------------------------------------------------

describe("computeClipOutputDimensions", () => {
  it("returns source dims (even) at scale 1", () => {
    expect(computeClipOutputDimensions(640, 480, 1)).toEqual({
      width: 640,
      height: 480,
    });
  });

  it("scales and rounds each side to an even number", () => {
    // 641 * 0.5 = 320.5 -> round 320 (even); 481 * 0.5 = 240.5 -> 240
    expect(computeClipOutputDimensions(641, 481, 0.5)).toEqual({
      width: 320,
      height: 240,
    });
  });

  it("forces even dimensions (H.264 requirement)", () => {
    const d = computeClipOutputDimensions(101, 99, 1);
    expect(d.width % 2).toBe(0);
    expect(d.height % 2).toBe(0);
  });

  it("floors at 2px and treats invalid scale as 1", () => {
    expect(computeClipOutputDimensions(1, 1, 0)).toEqual({ width: 2, height: 2 });
    expect(computeClipOutputDimensions(10, 10, -3)).toEqual({
      width: 10,
      height: 10,
    });
  });
});

// ---------------------------------------------------------------------------
// Pure: filename derivation
// ---------------------------------------------------------------------------

describe("deriveClipFilename", () => {
  it("strips .slp and appends the range", () => {
    expect(deriveClipFilename("mouse.slp", { start: 10, end: 20 })).toBe(
      "mouse.clip_10-20.mp4"
    );
  });

  it("strips .json case-insensitively", () => {
    expect(deriveClipFilename("Proj.JSON", { start: 0, end: 5 })).toBe(
      "Proj.clip_0-5.mp4"
    );
  });

  it("falls back to 'labels' with no project filename", () => {
    expect(deriveClipFilename(null, { start: 1, end: 2 })).toBe(
      "labels.clip_1-2.mp4"
    );
    expect(deriveClipFilename(undefined, { start: 3, end: 4 })).toBe(
      "labels.clip_3-4.mp4"
    );
  });

  it("keeps a path prefix (base stripped only of extension)", () => {
    expect(
      deriveClipFilename("/data/session1.slp", { start: 0, end: 9 })
    ).toBe("/data/session1.clip_0-9.mp4");
  });
});

// ---------------------------------------------------------------------------
// Pure: timeline planning
// ---------------------------------------------------------------------------

describe("planClipTimeline", () => {
  const range: FrameRange = { start: 5, end: 7, count: 3 };

  it("emits one entry per frame with sequential source indices", () => {
    const t = planClipTimeline(range, 10);
    expect(t.map((e) => e.frameIdx)).toEqual([5, 6, 7]);
  });

  it("computes timestamps at i/fps seconds", () => {
    const t = planClipTimeline(range, 10);
    expect(t.map((e) => e.timestamp)).toEqual([0, 0.1, 0.2]);
    expect(t.every((e) => Math.abs(e.duration - 0.1) < 1e-9)).toBe(true);
  });

  it("falls back to 30fps for a non-positive rate", () => {
    const t = planClipTimeline({ start: 0, end: 0, count: 1 }, 0);
    expect(t[0].duration).toBeCloseTo(1 / 30, 9);
  });
});

// ---------------------------------------------------------------------------
// Pure: encode-capability gate (injected probe)
// ---------------------------------------------------------------------------

describe("evaluateClipEncodeSupport", () => {
  it("reports supported when the probe resolves true", async () => {
    let seenCodec = "";
    const probe = async (codec: string) => {
      seenCodec = codec;
      return true;
    };
    const s = await evaluateClipEncodeSupport(probe as never, {
      width: 640,
      height: 480,
    });
    expect(s.supported).toBe(true);
    expect(seenCodec).toBe(CLIP_EXPORT_CODEC);
  });

  it("reports unsupported (with a Linux-aware message) when probe resolves false", async () => {
    const probe = async () => false;
    const s = await evaluateClipEncodeSupport(probe as never, {
      width: 640,
      height: 480,
    });
    expect(s.supported).toBe(false);
    expect(s.message).toBe(CLIP_EXPORT_UNSUPPORTED_MESSAGE);
  });

  it("treats a thrown probe as unsupported rather than crashing", async () => {
    const probe = async () => {
      throw new Error("WebCodecs missing");
    };
    const s = await evaluateClipEncodeSupport(probe as never, {
      width: 640,
      height: 480,
    });
    expect(s.supported).toBe(false);
    expect(s.message).toBe(CLIP_EXPORT_UNSUPPORTED_MESSAGE);
  });

  it("forwards the output dimensions to the probe", async () => {
    let seen: { width?: number; height?: number } | undefined;
    const probe = async (
      _codec: string,
      opts?: { width?: number; height?: number }
    ) => {
      seen = opts;
      return true;
    };
    await evaluateClipEncodeSupport(probe as never, { width: 1920, height: 1080 });
    expect(seen?.width).toBe(1920);
    expect(seen?.height).toBe(1080);
  });
});

// ---------------------------------------------------------------------------
// Pure-ish: overlay instance mapping (data-only; no canvas)
// ---------------------------------------------------------------------------

describe("buildExportRenderedInstances", () => {
  const skeleton = new Skeleton({ nodes: ["A", "B"], name: "s" });
  skeleton.addEdge("A", "B");
  const video = new Video({ filename: "v.mp4", openBackend: false });

  const baseOpts = {
    palette: "Standard",
    distinctlyColor: "instance",
    colorPredicted: false,
    showNonVisibleNodes: true,
    tracks: [] as Track[],
    video,
  };

  it("maps points to nodes, marking NaN points not visible", () => {
    const inst = Instance.fromArray(
      [
        [10, 20],
        [NaN, NaN],
      ],
      skeleton
    );
    const [r] = buildExportRenderedInstances([inst], baseOpts);
    expect(r.nodes).toHaveLength(2);
    expect(r.nodes[0]).toMatchObject({ x: 10, y: 20, visible: true, name: "A" });
    expect(r.nodes[1].visible).toBe(false);
    expect(r.edges).toEqual([{ srcIdx: 0, dstIdx: 1 }]);
    expect(r.isSelected).toBe(false);
    expect(r.visible).toBe(true);
  });

  it("flags predicted instances and colours them grey when colorPredicted is off", () => {
    const pred = PredictedInstance.fromArray([[1, 2], [3, 4]], skeleton, 0.8);
    const [r] = buildExportRenderedInstances([pred], baseOpts);
    expect(r.isPredicted).toBe(true);
    expect(r.color).toEqual([128, 128, 128]);
    expect(r.score).toBeCloseTo(0.8, 5);
  });

  it("honours the showNonVisibleNodes flag", () => {
    const inst = Instance.fromArray([[1, 2], [3, 4]], skeleton);
    const [hidden] = buildExportRenderedInstances([inst], {
      ...baseOpts,
      showNonVisibleNodes: false,
    });
    expect(hidden.showNonVisible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Thin integration: encode loop with a stubbed encoder + fake ctx + spy overlay
// (real decode/canvas/WebCodecs can only run in a browser/Tauri).
// ---------------------------------------------------------------------------

/** A fake 2D context recording only the ops the export loop performs. */
function fakeCtx(): ClipDrawContext & { fillRects: number; drawImages: number } {
  const ctx = {
    fillStyle: "",
    fillRects: 0,
    drawImages: 0,
    fillRect() {
      ctx.fillRects++;
    },
    drawImage() {
      ctx.drawImages++;
    },
    setTransform() {},
  };
  return ctx as unknown as ClipDrawContext & {
    fillRects: number;
    drawImages: number;
  };
}

function fakeEncoder(): ClipEncoder & {
  events: string[];
  timestamps: number[];
} {
  const events: string[] = [];
  const timestamps: number[] = [];
  return {
    events,
    timestamps,
    async start() {
      events.push("start");
    },
    async addFrame(ts) {
      events.push("add");
      timestamps.push(ts);
    },
    async finalize() {
      events.push("finalize");
      return new Uint8Array([1, 2, 3, 4]);
    },
    async cancel() {
      events.push("cancel");
    },
  };
}

const baseParams = {
  range: { start: 0, end: 2, count: 3 } as FrameRange,
  fps: 30,
  scale: 1,
  sourceWidth: 100,
  sourceHeight: 80,
  output: { width: 100, height: 80 },
  renderOptions: {
    markerSize: 4,
    nodeLabelSize: 12,
    edgeStyle: "Line" as const,
    showInstances: true,
    showLabels: true,
    showEdges: true,
    showNonVisibleNodes: true,
    colorPredicted: false,
  },
};

describe("runClipExport (integration, stubbed)", () => {
  it("starts, encodes one frame per timeline entry, and finalizes to bytes", async () => {
    const enc = fakeEncoder();
    const ctx = fakeCtx();
    const decoded: number[] = [];
    const overlaid: number[] = [];
    let renderCalls = 0;
    const progress: Array<[number, number]> = [];

    const bytes = await runClipExport(
      baseParams,
      {
        decodeFrame: async (idx) => {
          decoded.push(idx);
          return null; // no real frame; loop paints background only
        },
        overlayForFrame: (idx) => {
          overlaid.push(idx);
          return [];
        },
        ctx,
        encoder: enc,
        renderOverlay: () => {
          renderCalls++;
        },
      },
      { onProgress: (d, t) => progress.push([d, t]) }
    );

    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
    expect(enc.events[0]).toBe("start");
    expect(enc.events[enc.events.length - 1]).toBe("finalize");
    expect(enc.events.filter((e) => e === "add")).toHaveLength(3);
    expect(decoded).toEqual([0, 1, 2]);
    expect(overlaid).toEqual([0, 1, 2]);
    expect(renderCalls).toBe(3);
    expect(enc.timestamps).toEqual([0, 1 / 30, 2 / 30]);
    expect(ctx.fillRects).toBe(3); // background painted each frame
    expect(progress).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it("draws the decoded frame when one is available", async () => {
    const enc = fakeEncoder();
    const ctx = fakeCtx();
    const fakeFrame = { width: 100, height: 80 } as unknown as CanvasImageSource;
    await runClipExport(
      baseParams,
      {
        decodeFrame: async () => fakeFrame,
        overlayForFrame: () => [],
        ctx,
        encoder: enc,
        renderOverlay: () => {},
      }
    );
    expect(ctx.drawImages).toBe(3);
  });

  it("aborts before finalize and cancels the encoder when the signal is already aborted", async () => {
    const enc = fakeEncoder();
    const ctx = fakeCtx();
    const controller = new AbortController();
    controller.abort();

    await expect(
      runClipExport(
        baseParams,
        {
          decodeFrame: async () => null,
          overlayForFrame: () => [],
          ctx,
          encoder: enc,
          renderOverlay: () => {},
        },
        { signal: controller.signal }
      )
    ).rejects.toBeInstanceOf(ClipExportCancelled);

    expect(enc.events).toContain("cancel");
    expect(enc.events).not.toContain("finalize");
  });

  it("stops mid-way and cancels when the signal aborts during encoding", async () => {
    const enc = fakeEncoder();
    const ctx = fakeCtx();
    const controller = new AbortController();
    let seen = 0;

    await expect(
      runClipExport(
        baseParams,
        {
          decodeFrame: async (idx) => {
            seen++;
            if (idx === 1) controller.abort(); // abort after first frame decoded
            return null;
          },
          overlayForFrame: () => [],
          ctx,
          encoder: enc,
          renderOverlay: () => {},
        },
        { signal: controller.signal }
      )
    ).rejects.toBeInstanceOf(ClipExportCancelled);

    // Frame 0 fully encoded; abort caught before frame 1 is added.
    expect(enc.events.filter((e) => e === "add")).toHaveLength(1);
    expect(enc.events).toContain("cancel");
    expect(seen).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Pure: scale clamp (no upscaling — PyQt parity)
// ---------------------------------------------------------------------------

describe("clampClipScale", () => {
  it("caps values above 1.0 at the max (no upscaling)", () => {
    expect(clampClipScale(2)).toBe(CLIP_SCALE_MAX);
    expect(clampClipScale(1.5)).toBe(1);
    expect(clampClipScale(100)).toBe(1);
  });

  it("raises values below 0.1 to the min", () => {
    expect(clampClipScale(0.05)).toBe(CLIP_SCALE_MIN);
    expect(clampClipScale(0)).toBe(0.1);
    expect(clampClipScale(-3)).toBe(0.1);
  });

  it("passes through in-range values unchanged", () => {
    expect(clampClipScale(0.1)).toBe(0.1);
    expect(clampClipScale(0.5)).toBe(0.5);
    expect(clampClipScale(1)).toBe(1);
  });

  it("falls back to 1 for a non-finite input", () => {
    expect(clampClipScale(NaN)).toBe(1);
    expect(clampClipScale(Infinity)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Pure: background choice → CSS colour (dialog plumbing)
// ---------------------------------------------------------------------------

describe("clipBackgroundColor", () => {
  it("maps black/white/grey to CSS colours", () => {
    expect(clipBackgroundColor("black")).toBe("#000000");
    expect(clipBackgroundColor("white")).toBe("#ffffff");
    expect(clipBackgroundColor("grey")).toBe("#808080");
  });

  it("returns undefined for 'original' so the core keeps its default", () => {
    expect(clipBackgroundColor("original")).toBeUndefined();
  });
});

describe("runClipExport background plumbing", () => {
  it("paints the frame background with params.background", async () => {
    const fills: string[] = [];
    const ctx = {
      fillStyle: "",
      fillRect() {
        fills.push(ctx.fillStyle as string);
      },
      drawImage() {},
      setTransform() {},
    } as unknown as ClipDrawContext;

    await runClipExport(
      { ...baseParams, background: "#ffffff" },
      {
        decodeFrame: async () => null,
        overlayForFrame: () => [],
        ctx,
        encoder: fakeEncoder(),
        renderOverlay: () => {},
      }
    );

    // One background fill per frame, using the threaded colour.
    expect(fills).toEqual(["#ffffff", "#ffffff", "#ffffff"]);
  });

  it("defaults to black when no background is provided", async () => {
    const fills: string[] = [];
    const ctx = {
      fillStyle: "",
      fillRect() {
        fills.push(ctx.fillStyle as string);
      },
      drawImage() {},
      setTransform() {},
    } as unknown as ClipDrawContext;

    await runClipExport(baseParams, {
      decodeFrame: async () => null,
      overlayForFrame: () => [],
      ctx,
      encoder: fakeEncoder(),
      renderOverlay: () => {},
    });

    expect(fills.every((c) => c === "#000000")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pure: raw-frame channel detection + RGBA expansion (the decode channel fix)
// ---------------------------------------------------------------------------

describe("inferFrameChannels", () => {
  it("prefers a valid declared channel count (1/3/4)", () => {
    expect(inferFrameChannels(999, 4, 4, 1)).toBe(1);
    expect(inferFrameChannels(999, 4, 4, 3)).toBe(3);
    expect(inferFrameChannels(999, 4, 4, 4)).toBe(4);
  });

  it("infers from byte length / (w*h) when the declared count is absent/invalid", () => {
    const px = 4 * 4; // 16 pixels
    expect(inferFrameChannels(px * 1, 4, 4, null)).toBe(1);
    expect(inferFrameChannels(px * 3, 4, 4, undefined)).toBe(3);
    expect(inferFrameChannels(px * 4, 4, 4, 0)).toBe(4);
  });

  it("falls back to grayscale (1) when nothing matches", () => {
    expect(inferFrameChannels(7, 4, 4, null)).toBe(1); // 7 not divisible by 16
    expect(inferFrameChannels(0, 0, 0, null)).toBe(1); // no pixels
  });
});

describe("expandFrameBytesToRGBA", () => {
  it("broadcasts a single grayscale sample across R/G/B with opaque alpha", () => {
    // 2x1 grayscale image: [50, 200]
    const out = expandFrameBytesToRGBA(new Uint8Array([50, 200]), 2, 1, 1);
    expect(Array.from(out)).toEqual([50, 50, 50, 255, 200, 200, 200, 255]);
  });

  it("copies RGB triplets and sets alpha to 255", () => {
    // 2x1 RGB image: red, green
    const out = expandFrameBytesToRGBA(
      new Uint8Array([255, 0, 0, 0, 255, 0]),
      2,
      1,
      3
    );
    expect(Array.from(out)).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
  });

  it("passes RGBA through unchanged", () => {
    const rgba = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const out = expandFrameBytesToRGBA(rgba, 2, 1, 4);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("always yields exactly width*height*4 bytes", () => {
    expect(expandFrameBytesToRGBA(new Uint8Array(9), 3, 3, 1).length).toBe(36);
    expect(expandFrameBytesToRGBA(new Uint8Array(27), 3, 3, 3).length).toBe(36);
    expect(expandFrameBytesToRGBA(new Uint8Array(36), 3, 3, 4).length).toBe(36);
  });

  it("zero-fills missing samples from a short buffer instead of throwing", () => {
    // Ask for 2 RGB pixels but only supply 3 bytes (1 pixel worth).
    const out = expandFrameBytesToRGBA(new Uint8Array([10, 20, 30]), 2, 1, 3);
    expect(Array.from(out)).toEqual([10, 20, 30, 255, 0, 0, 0, 255]);
  });
});
