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
  computeClipOutputDimensions,
  deriveClipFilename,
  planClipTimeline,
  evaluateClipEncodeSupport,
  buildExportRenderedInstances,
  runClipExport,
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
