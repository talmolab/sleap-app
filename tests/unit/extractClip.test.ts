/**
 * Labels → Extract Clip and Labels / Extract Clip Labels Package — parity with
 * PyQt SLEAP's ExportLabelsSubset: the seekbar range of the current video
 * (required, as in PyQt) becomes its own project — a trimmed clip + renumbered
 * `.slp`, or a `.pkg.slp` with original frame numbers — opened in a new window.
 * The encoder, platform, package export and new-window opening are mocked;
 * sleap-io is real.
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";
import {
  Instance,
  LabeledFrame,
  Labels,
  Skeleton,
  SuggestionFrame,
  Video,
  loadSlp,
} from "@talmolab/sleap-io.js";

const written = new Map<string, Uint8Array>();
let saveDialogResult: string | null = "/out/sub.slp";
const opened: string[] = [];
const packageCalls: Array<{ labels: Labels; level: string; suggestedName?: string }> = [];
let packageResult: string | null = "/out/sub.pkg.slp";
const encodedFrames: number[] = [];

vi.mock("@/platform/index", () => ({
  getPlatform: async () => ({
    isTauri: true,
    showSaveDialog: async () => saveDialogResult,
    writeFile: async (path: string, bytes: Uint8Array) => void written.set(path, bytes),
  }),
  isTauri: true,
  consumeLastBrowserFileHandle: () => null,
}));
vi.mock("@/lib/newInstance", () => ({
  openNewInstance: async (o: { file?: string }) => void opened.push(o.file ?? ""),
}));
vi.mock("@/commands/exportPackageCommands", () => ({
  exportLabelsPackage: async (
    labels: Labels,
    _filename: string | null,
    level: string,
    options: { suggestedName?: string }
  ) => {
    packageCalls.push({ labels, level, suggestedName: options?.suggestedName });
    return packageResult;
  },
}));
vi.mock("@/lib/videoExportPipeline", () => ({
  clipEncodeProbe: async () => true,
  decodeExportFrame: async (_v: unknown, frameIdx: number) => {
    encodedFrames.push(frameIdx);
    return null;
  },
  buildClipExportPipeline: (p: {
    decodeFrame: (i: number) => Promise<unknown>;
    overlayForFrame: (i: number) => unknown[];
  }) => ({
    decodeFrame: p.decodeFrame,
    overlayForFrame: p.overlayForFrame,
    ctx: { fillStyle: "", fillRect() {}, drawImage() {}, setTransform() {} },
    encoder: {
      async start() {},
      async addFrame() {},
      async finalize() {
        return new Uint8Array([0x6d, 0x70, 0x34]);
      },
      async cancel() {},
    },
  }),
}));
const toastInfo = vi.fn();
vi.mock("@/lib/notify", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: toastInfo },
}));

const {
  extractRange,
  extractFilename,
  labelsForRange,
  ExtractClipAndLabelsCommand,
  ExtractClipLabelsPackageCommand,
} = await import("@/commands/extractClipCommands");

/** A 100-frame video with labels at 5, 20, 40, 90; another video at 20. */
function project() {
  const skeleton = new Skeleton({ nodes: ["head", "tail"], name: "mouse" });
  const unused = new Skeleton({ nodes: ["x"], name: "unused" });
  const mk = (filename: string) =>
    new Video({
      filename,
      backendMetadata: { shape: [100, 32, 48, 1] },
      openBackend: false,
    });
  const video = mk("/data/mice.mp4");
  const other = mk("/data/other.mp4");
  video.fps = 25;
  const lf = (v: Video, frameIdx: number, x: number) =>
    new LabeledFrame({
      video: v,
      frameIdx,
      instances: [new Instance({ points: { head: [x, 1], tail: [x + 1, 2] }, skeleton })],
    });
  const labels = new Labels({
    labeledFrames: [lf(video, 5, 1), lf(video, 20, 2), lf(video, 40, 3), lf(video, 90, 4), lf(other, 20, 9)],
    videos: [video, other],
    skeletons: [skeleton, unused],
    suggestions: [
      new SuggestionFrame({ video, frameIdx: 10 }),
      new SuggestionFrame({ video, frameIdx: 40 }),
      new SuggestionFrame({ video, frameIdx: 60 }),
      new SuggestionFrame({ video: other, frameIdx: 15 }),
    ],
  });
  return { labels, video, other, skeleton };
}

function ctx(labels: Labels, video: Video, frameRange: [number, number] | null) {
  return {
    state: { labels, video, frameRange, filename: "labels.v001.slp", projectPath: "/proj/labels.v001.slp" },
  } as never;
}

beforeEach(() => {
  written.clear();
  opened.length = 0;
  packageCalls.length = 0;
  encodedFrames.length = 0;
  saveDialogResult = "/out/sub.slp";
  packageResult = "/out/sub.pkg.slp";
  toastInfo.mockClear();
});

describe("extract helpers", () => {
  it("takes the seekbar selection; nothing without one", () => {
    const { video } = project();
    expect(extractRange([10, 40], video)).toEqual({ start: 10, end: 40, count: 31 });
    expect(extractRange([90, 500], video)).toEqual({ start: 90, end: 99, count: 10 });
    expect(extractRange(null, video)).toBeNull();
    expect(extractRange([0, 5], new Video({ filename: "x.mp4", openBackend: false }))).toBeNull();
  });

  it("names outputs <project>.clip_<start>-<end>", () => {
    const r = { start: 10, end: 40 };
    expect(extractFilename("labels.v001.slp", r, "slp")).toBe("labels.v001.clip_10-40.slp");
    expect(extractFilename("/a/p.pkg.slp", r, "pkg.slp")).toBe("p.clip_10-40.pkg.slp");
    expect(extractFilename(null, r, "mp4")).toBe("labels.clip_10-40.mp4");
  });
});

describe("labelsForRange", () => {
  it("for a clip: copies the range's frames, renumbered from 0, on the clip", () => {
    const { labels, video, skeleton } = project();
    const clip = new Video({ filename: "/out/sub.mp4", openBackend: false });
    const sub = labelsForRange(labels, video, { start: 10, end: 40 }, clip);

    expect(sub.videos).toEqual([clip]);
    expect(sub.labeledFrames.map((lf) => [lf.frameIdx, lf.video === clip])).toEqual([
      [10, true],
      [30, true],
    ]);
    expect(sub.suggestions.map((s) => [s.frameIdx, s.video === clip])).toEqual([
      [0, true],
      [30, true],
    ]);
    // The project's skeletons, even ones no frame uses.
    expect(sub.skeletons.map((s) => s.name)).toEqual(["mouse", "unused"]);
    expect(sub.labeledFrames[0].instances[0].skeleton.name).toBe(skeleton.name);
    // The project itself is untouched.
    expect(labels.labeledFrames.map((lf) => lf.frameIdx)).toEqual([5, 20, 40, 90, 20]);
    expect(labels.labeledFrames[1].video).toBe(video);
  });

  it("for a package: the range's own frames, original numbers and video", () => {
    const { labels, video } = project();
    const sub = labelsForRange(labels, video, { start: 10, end: 40 });
    expect(sub.videos).toEqual([video]);
    expect(sub.labeledFrames.map((lf) => lf.frameIdx)).toEqual([20, 40]);
    expect(sub.labeledFrames[0]).toBe(labels.labeledFrames[1]);
    expect(sub.suggestions.map((s) => s.frameIdx)).toEqual([10, 40]);
  });

  it("keeps the video even when the range has no labels", () => {
    const { labels, video } = project();
    const sub = labelsForRange(labels, video, { start: 50, end: 55 });
    expect(sub.videos).toEqual([video]);
    expect(sub.labeledFrames).toEqual([]);
    expect(sub.skeletons.length).toBe(2);
  });
});

describe("Extract Clip and Labels", () => {
  it("writes the range's clip next to a .slp that uses it, then opens it", async () => {
    const { labels, video } = project();
    await ExtractClipAndLabelsCommand.execute(ctx(labels, video, [10, 40]));

    // Every frame of the range, in order, without overlays.
    expect(encodedFrames).toEqual(Array.from({ length: 31 }, (_, i) => 10 + i));
    expect([...written.keys()]).toEqual(["/out/sub.mp4", "/out/sub.slp"]);
    expect(opened).toEqual(["/out/sub.slp"]);

    const sub = await loadSlp(written.get("/out/sub.slp")!.buffer as ArrayBuffer, {
      openVideos: false,
    });
    expect(sub.videos.length).toBe(1);
    expect(sub.videos[0].filename).toBe("/out/sub.mp4");
    expect(sub.videos[0].shape?.[0]).toBe(31);
    expect(sub.labeledFrames.map((lf) => lf.frameIdx).sort((a, b) => a - b)).toEqual([10, 30]);
    expect(sub.suggestions.map((s) => s.frameIdx).sort((a, b) => a - b)).toEqual([0, 30]);
  });

  it("writes the clip at the chosen fps, and opens nothing when asked not to", async () => {
    const { labels, video } = project();
    await ExtractClipAndLabelsCommand.execute(ctx(labels, video, [10, 40]), {
      fps: 12,
      openWhenDone: false,
    });
    const sub = await loadSlp(written.get("/out/sub.slp")!.buffer as ArrayBuffer, {
      openVideos: false,
    });
    expect(sub.videos[0].fps).toBe(12);
    expect(opened).toEqual([]);
  });

  it("needs a selected range, as PyQt", async () => {
    const { labels, video } = project();
    await ExtractClipAndLabelsCommand.execute(ctx(labels, video, null));
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(encodedFrames).toEqual([]);
    expect(written.size).toBe(0);
  });

  it("does nothing when the Save dialog is cancelled", async () => {
    const { labels, video } = project();
    saveDialogResult = null;
    await ExtractClipAndLabelsCommand.execute(ctx(labels, video, [10, 40]));
    expect(encodedFrames).toEqual([]);
    expect(written.size).toBe(0);
  });
});

describe("Extract Clip Labels Package", () => {
  it("exports the range as a Level 3 package and opens it", async () => {
    const { labels, video } = project();
    await ExtractClipLabelsPackageCommand.execute(ctx(labels, video, [10, 40]));

    expect(packageCalls.length).toBe(1);
    expect(packageCalls[0].level).toBe("full");
    expect(packageCalls[0].suggestedName).toBe("labels.v001.clip_10-40.pkg.slp");
    expect(packageCalls[0].labels.labeledFrames.map((lf) => lf.frameIdx)).toEqual([20, 40]);
    expect(opened).toEqual(["/out/sub.pkg.slp"]);
  });

  it("opens nothing when the export didn't write a file, or when asked not to", async () => {
    const { labels, video } = project();
    packageResult = null;
    await ExtractClipLabelsPackageCommand.execute(ctx(labels, video, [10, 40]));
    expect(opened).toEqual([]);
    packageResult = "/out/sub.pkg.slp";
    await ExtractClipLabelsPackageCommand.execute(ctx(labels, video, [10, 40]), {
      openWhenDone: false,
    });
    expect(packageCalls.length).toBe(2);
    expect(opened).toEqual([]);
  });

  it("needs a selected range, as PyQt", async () => {
    const { labels, video } = project();
    await ExtractClipLabelsPackageCommand.execute(ctx(labels, video, null));
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(packageCalls).toEqual([]);
  });
});
