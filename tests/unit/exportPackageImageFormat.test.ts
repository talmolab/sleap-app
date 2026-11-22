/**
 * The frame format of a package export (PNG or JPEG, #512) reaches every
 * write path: the in-memory save, the desktop streaming writer and its ffmpeg
 * frame reader, the browser's OPFS writer, the package commands, and the
 * training job package's two builders. PNG (or no choice) passes no option,
 * so those exports write what they wrote before; JPEG passes io's
 * `imageFormat: "jpg"` and `imageQuality`. JPEG asked of a sleap-io.js that
 * can't write it fails before anything is written.
 *
 * io's writers, the streaming and OPFS writers, ffmpeg and the platform are
 * mocked, so this runs against either pin; whether the installed sleap-io.js
 * can write JPEG is set with the compatibility module's test switch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "../bun-test";

type Opts = Record<string, unknown> & {
  onProgress?: (current: number, total: number, message?: string) => unknown;
  frameReader?: (video: unknown, frames: number[]) => Promise<unknown>;
};

class ExportCancelled extends Error {}

const calls: Array<{ path: string; opts: Opts }> = [];
const ffmpegCalls: unknown[] = [];
const platform = { isTauri: false };
const opfs = { supported: false };
const toastError = vi.fn();
const saved: Uint8Array[] = [];

vi.mock("@talmolab/sleap-io.js", () => ({
  ExportCancelled,
  saveSlpToBytes: async (_labels: unknown, opts: Opts) => {
    calls.push({ path: "memory", opts });
    return new Uint8Array([1]);
  },
  loadSlp: async () => ({ videos: [] }),
  readSlpStreaming: async () => ({ videos: [] }),
}));
vi.mock("@/lib/saveEmbeddedPkgStreaming", () => ({
  saveEmbeddedPkgStreaming: async (_l: unknown, _dest: string, _src: unknown, opts: Opts) => {
    calls.push({ path: "stream", opts });
    await opts.frameReader?.({ filename: "/data/mice.mp4" }, [0, 1]);
  },
}));
vi.mock("@/lib/saveEmbeddedPkgOpfs", () => ({
  isOpfsSaveSupported: () => opfs.supported,
  pickSlpSaveDestination: async () => ({ name: "out.pkg.slp" }),
  exportNewPkgOpfs: async (_l: unknown, _dest: unknown, opts: Opts) => {
    calls.push({ path: "opfs", opts });
    return "out.pkg.slp";
  },
}));
vi.mock("@/lib/transcode/extractFrames", () => ({
  createTauriExtractFramesDeps: () => ({}),
  createFfmpegFrameReader: async (_v: unknown, _f: number[], _d: unknown, image: unknown) => {
    ffmpegCalls.push(image);
    return null;
  },
}));
vi.mock("@/platform/index", () => ({
  isTauri: false,
  getPlatform: async () => ({
    isTauri: platform.isTauri,
    showSaveDialog: async () => "/data/out.pkg.slp",
    writeFile: async (_p: string, bytes: Uint8Array) => void saved.push(bytes),
  }),
}));
vi.mock("@/commands/fileCommands", () => ({
  saveBytesFile: async (bytes: Uint8Array) => {
    saved.push(bytes);
    return "/out/labels.pkg.slp";
  },
}));
vi.mock("@/lib/resolveVideos", () => ({ prepareVideosForFrameReads: async () => {} }));
vi.mock("@/lib/notify", () => ({
  toast: { success: vi.fn(), error: toastError, warning: vi.fn(), info: vi.fn() },
}));

const {
  exportLabelsPackage,
  writeLabelsPackageToPath,
  labelsPackageBytes,
  packageImageParam,
  ExportUserLabelsPackageCommand,
  ExportTrainingPackageCommand,
  ExportFullPackageCommand,
} = await import("@/commands/exportPackageCommands");
const { __setJpegFramesSupported, JPEG_FRAMES_UNAVAILABLE } = await import(
  "@/lib/slpFormatCompat"
);

const JPEG = { format: "jpg" as const, quality: 80 };
const PNG = { format: "png" as const, quality: 80 };

/** A project of one mp4 video with one user-labeled frame. */
function mp4Labels() {
  const video = { filename: "/data/mice.mp4", backend: {}, hasEmbeddedImages: false };
  const l = {
    videos: [video],
    labeledFrames: [{ video, frameIdx: 0, isUserLabeled: true }],
    suggestions: [],
    extract: () => l,
  };
  return l as never;
}

/** The option keys a writer got, sorted. */
const keys = (o: Opts) => Object.keys(o).sort();

beforeEach(() => {
  calls.length = 0;
  ffmpegCalls.length = 0;
  saved.length = 0;
  platform.isTauri = false;
  opfs.supported = false;
  toastError.mockClear();
  __setJpegFramesSupported(true);
});
afterEach(() => {
  __setJpegFramesSupported(null);
  delete (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
});

describe("in-memory package export (browser, or already-embedded videos)", () => {
  it("passes no format option for PNG or no choice: written as before", async () => {
    await exportLabelsPackage(mp4Labels(), "labels.slp", "user");
    await exportLabelsPackage(mp4Labels(), "labels.slp", "user", { image: PNG });
    expect(calls.map((c) => c.path)).toEqual(["memory", "memory"]);
    for (const { opts } of calls) {
      expect(keys(opts)).toEqual(["embed", "onProgress", "unlabeledAs"]);
      expect(opts.embed).toBe("user");
    }
  });

  it("passes imageFormat jpg and the quality for JPEG", async () => {
    await exportLabelsPackage(mp4Labels(), "labels.slp", "training", { image: JPEG });
    const { opts } = calls[0];
    expect(opts.imageFormat).toBe("jpg");
    expect(opts.imageQuality).toBe(80);
    expect(opts.embed).toBe("user+suggestions");
    expect(opts.unlabeledAs).toBe("absent");
    expect(saved).toHaveLength(1);
  });

  it("writes nothing, and says why, when the installed sleap-io.js can't write JPEG", async () => {
    __setJpegFramesSupported(false);
    const result = await exportLabelsPackage(mp4Labels(), "labels.slp", "user", { image: JPEG });
    expect(result).toBeNull();
    expect(calls).toEqual([]);
    expect(saved).toEqual([]);
    const [, toastOpts] = toastError.mock.calls[0] as unknown as [string, { description: string }];
    expect(toastOpts.description).toBe(JPEG_FRAMES_UNAVAILABLE);
  });
});

describe("streamed package export (desktop)", () => {
  function onDesktop() {
    platform.isTauri = true;
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = true;
  }

  it("hands the format to the streaming writer and to ffmpeg's frame reader", async () => {
    onDesktop();
    await exportLabelsPackage(mp4Labels(), "labels.slp", "user", { image: JPEG });
    expect(calls.map((c) => c.path)).toEqual(["stream"]);
    expect(calls[0].opts.image).toEqual(JPEG);
    expect(ffmpegCalls).toEqual([{ format: "jpg", quality: 80 }]);
  });

  it("passes no format without a choice, and ffmpeg extracts PNGs", async () => {
    onDesktop();
    await exportLabelsPackage(mp4Labels(), "labels.slp", "user");
    expect(calls[0].opts.image).toBeUndefined();
    expect(ffmpegCalls).toEqual([{ format: undefined, quality: undefined }]);
  });

  it("the training job package's desktop writer passes it the same way", async () => {
    onDesktop();
    await writeLabelsPackageToPath(mp4Labels(), "user", "/tmp/x.pkg.slp", () => true, JPEG);
    expect(calls[0].opts.image).toEqual(JPEG);
    expect(ffmpegCalls).toEqual([{ format: "jpg", quality: 80 }]);
  });
});

describe("OPFS package export (Chromium)", () => {
  it("hands the format to the OPFS writer", async () => {
    opfs.supported = true;
    await exportLabelsPackage(mp4Labels(), "labels.slp", "full", { image: JPEG });
    expect(calls.map((c) => c.path)).toEqual(["opfs"]);
    expect(calls[0].opts.image).toEqual(JPEG);
    expect(calls[0].opts.embed).toBe("all");
  });
});

describe("training job package builders", () => {
  it("in memory: JPEG adds the options, none leaves them out", async () => {
    await labelsPackageBytes(mp4Labels(), "user", () => true, JPEG);
    await labelsPackageBytes(mp4Labels(), "user", () => true);
    expect(calls[0].opts.imageFormat).toBe("jpg");
    expect(calls[0].opts.imageQuality).toBe(80);
    expect(keys(calls[1].opts)).toEqual(["embed", "onProgress", "unlabeledAs"]);
  });

  it("to a path without streaming: the same", async () => {
    await writeLabelsPackageToPath(mp4Labels(), "user", "/tmp/x.pkg.slp", () => true, JPEG);
    expect(calls[0].path).toBe("memory");
    expect(calls[0].opts.imageFormat).toBe("jpg");
  });
});

describe("package commands", () => {
  const ctx = () => ({ state: { labels: mp4Labels(), filename: "labels.slp" } }) as never;

  it("take the dialog's format from their params", async () => {
    for (const cmd of [
      ExportUserLabelsPackageCommand,
      ExportTrainingPackageCommand,
      ExportFullPackageCommand,
    ]) {
      await cmd.execute(ctx(), { image: JPEG });
    }
    expect(calls.map((c) => c.opts.imageFormat)).toEqual(["jpg", "jpg", "jpg"]);
  });

  it("export PNG without params (as before)", async () => {
    await ExportTrainingPackageCommand.execute(ctx());
    expect(keys(calls[0].opts)).toEqual(["embed", "onProgress", "unlabeledAs"]);
  });

  it("ignore a malformed format param", () => {
    expect(packageImageParam(undefined)).toBeUndefined();
    expect(packageImageParam({ image: { format: "webp", quality: 3 } })).toBeUndefined();
    expect(packageImageParam({ image: "jpg" })).toBeUndefined();
    expect(packageImageParam({ image: { format: "jpg", quality: 70 } })).toEqual({
      format: "jpg",
      quality: 70,
    });
  });
});
