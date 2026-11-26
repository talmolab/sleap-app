/**
 * JPEG package export end to end (#512), through the app's own Export Labels
 * Package (the in-memory path; the Save dialog and the platform are faked)
 * and sleap-io.js's real writers, then read back with sleap-io.js.
 *
 * - A colour and a grayscale video export as JPEG: the package reads back
 *   with format "jpg", RGB, the video's shape, and stored JPEGs of the right
 *   size and channel count, written with libjpeg's tables at the chosen
 *   quality.
 * - Without a choice the same export stores PNG, as before.
 * - An already-embedded PNG package exported as JPEG is converted.
 * - The desktop path: ffmpeg hands the streaming writer PNG frames, which a
 *   JPEG plan turns into pixels for the worker to encode as JPEG (the worker
 *   is replaced by a recording sink).
 *
 * Needs a sleap-io.js that writes JPEG frames (`imageFormat`); with an older
 * one the suite skips itself and says so.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "../bun-test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as sio from "@talmolab/sleap-io.js";
import {
  Instance,
  LabeledFrame,
  Labels,
  Skeleton,
  Video,
  loadSlp,
  type VideoBackend,
  type VideoFrame,
} from "@talmolab/sleap-io.js";

const saved: Uint8Array[] = [];
vi.mock("@/platform/index", () => ({
  isTauri: false,
  getPlatform: async () => ({ isTauri: false }),
}));
vi.mock("@/commands/fileCommands", () => ({
  saveBytesFile: async (bytes: Uint8Array) => {
    saved.push(bytes);
    return "clip.pkg.slp";
  },
}));
vi.mock("@/lib/resolveVideos", () => ({ prepareVideosForFrameReads: async () => {} }));
const toastError = vi.fn();
vi.mock("@/lib/notify", () => ({
  toast: { success: vi.fn(), error: toastError, warning: vi.fn(), info: vi.fn() },
}));

const { exportLabelsPackage } = await import("@/commands/exportPackageCommands");

type SioJpeg = {
  EMBED_IMAGE_FORMATS?: readonly string[];
  buildSerializableEmbedPlan: (
    labels: Labels,
    embed: string,
    source: string,
    opts: object
  ) => Promise<{ encodeEntries: Array<Record<string, unknown>> }>;
  appendEncodedVideos: (
    sink: unknown,
    labels: Labels,
    entries: unknown[],
    opts: object
  ) => Promise<void>;
};
const HAS_JPEG = ((sio as unknown as SioJpeg).EMBED_IMAGE_FORMATS ?? []).includes("jpg");
if (!HAS_JPEG) {
  console.info(
    "[packageJpegRoundTrip] skipped: the installed sleap-io.js does not write JPEG frames"
  );
}

const W = 64;
const H = 48;
/** libjpeg's `jpeg_set_quality` scaling of the Annex K tables, natural order. */
function libjpegQuantTable(table: "luma" | "chroma", quality: number): number[] {
  const luma = [
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69,
    56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81,
    104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
  ];
  const chroma = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56]
    .concat([99, 99, 99, 99, 99, 47, 66])
    .concat(new Array(38).fill(99));
  const scale = quality < 50 ? Math.floor(5000 / quality) : 200 - quality * 2;
  return (table === "luma" ? luma : chroma).map((v) =>
    Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100)))
  );
}

/** A smooth test image: value of frame `idx` at (x, y), channel `c`. */
const value = (idx: number, x: number, y: number, c: number) =>
  Math.min(255, 10 + x * 3 + y * 2 + c * 40 + idx * 5);

/** A continuous video of RGBA (or one-channel) frames. */
function backend(n: number, channels: 1 | 3): VideoBackend {
  return {
    filename: channels === 1 ? "gray.mp4" : "clip.mp4",
    shape: [n, H, W, channels],
    fps: 30,
    async getFrame(idx: number): Promise<VideoFrame | null> {
      if (idx < 0 || idx >= n) return null;
      if (channels === 1) {
        const data = new Uint8Array(W * H);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data[y * W + x] = value(idx, x, y, 0);
        return { data, width: W, height: H, channels: 1 } as never;
      }
      const data = new Uint8ClampedArray(W * H * 4);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const o = (y * W + x) * 4;
          for (let c = 0; c < 3; c++) data[o + c] = value(idx, x, y, c);
          data[o + 3] = 255;
        }
      }
      return { data, width: W, height: H } as never;
    },
    close() {},
  } as unknown as VideoBackend;
}

function labelsOn(video: Video, frames: number[]): Labels {
  const skeleton = new Skeleton({ nodes: ["A"] });
  const labeledFrames = frames.map(
    (frameIdx) =>
      new LabeledFrame({
        video,
        frameIdx,
        instances: [new Instance({ points: { A: [1, 2] }, skeleton })],
      })
  );
  return new Labels({ labeledFrames, videos: [video], skeletons: [skeleton] });
}

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27,
  20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58,
  59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

/** A JPEG's quantization tables (natural order) and frame header. */
function jpegHeader(b: Uint8Array) {
  const tables: number[][] = [];
  let comps = 0;
  let height = 0;
  let width = 0;
  let i = 2;
  while (i + 4 < b.length && b[i] === 0xff) {
    const marker = b[i + 1];
    const len = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xdb) {
      for (let p = i + 4; p < i + 2 + len; p += 65) {
        const zz = b.subarray(p + 1, p + 65);
        const natural = new Array<number>(64);
        ZIGZAG.forEach((n, k) => (natural[n] = zz[k]));
        tables[b[p] & 15] = natural;
      }
    }
    if (marker === 0xc0) {
      height = (b[i + 5] << 8) | b[i + 6];
      width = (b[i + 7] << 8) | b[i + 8];
      comps = b[i + 9];
    }
    if (marker === 0xda) break;
    i += 2 + len;
  }
  return { tables, comps, height, width };
}

const tmp = mkdtempSync(join(tmpdir(), "sleap-app-jpeg-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
let nFiles = 0;

/** Read a written package back from a file, as a user would open it. */
async function readBack(bytes: Uint8Array) {
  const path = join(tmp, `out${nFiles++}.pkg.slp`);
  writeFileSync(path, bytes);
  const labels = await loadSlp(path);
  const video = labels.videos[0];
  const backend = video.backend as unknown as {
    embeddedFormat: string;
    embeddedChannelOrder: string;
    getFrameBuffer: (i: number) => Promise<Uint8Array | null>;
  };
  return { labels, video, backend };
}

beforeEach(() => {
  saved.length = 0;
  toastError.mockClear();
});

describe.skipIf(!HAS_JPEG)("JPEG package export, read back (local sleap-io.js build)", () => {
  it("stores a colour video's frames as JPEG at the chosen quality", async () => {
    const labels = labelsOn(new Video({ filename: "clip.mp4", backend: backend(10, 3) }), [1, 4, 7]);
    const where = await exportLabelsPackage(labels, "clip.slp", "user", {
      image: { format: "jpg", quality: 90 },
    });
    expect(toastError).not.toHaveBeenCalled();
    expect(where).toBe("clip.pkg.slp");

    const { labels: back, video, backend: b } = await readBack(saved[0]);
    expect(video.hasEmbeddedImages).toBe(true);
    expect(b.embeddedFormat).toBe("jpg");
    expect(b.embeddedChannelOrder).toBe("RGB");
    expect(video.shape?.slice(1)).toEqual([H, W, 3]);
    expect(back.labeledFrames.map((f) => f.frameIdx)).toEqual([1, 4, 7]);
    for (const frameIdx of [1, 4, 7]) {
      const jpeg = (await b.getFrameBuffer(frameIdx))!;
      expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
      const header = jpegHeader(jpeg);
      expect([header.comps, header.height, header.width]).toEqual([3, H, W]);
      // The standard libjpeg tables for quality 90, as sleap-io.js's encoder writes them.
      expect(header.tables[0]).toEqual(libjpegQuantTable("luma", 90));
      expect(header.tables[1]).toEqual(libjpegQuantTable("chroma", 90));
    }
  });

  it("stores a grayscale video's frames as one-channel JPEGs", async () => {
    const labels = labelsOn(new Video({ filename: "gray.mp4", backend: backend(5, 1) }), [0, 3]);
    await exportLabelsPackage(labels, "gray.slp", "user", { image: { format: "jpg", quality: 75 } });
    const { video, backend: b } = await readBack(saved[0]);
    expect(b.embeddedFormat).toBe("jpg");
    expect(video.shape?.slice(1)).toEqual([H, W, 1]);
    const header = jpegHeader((await b.getFrameBuffer(3))!);
    expect([header.comps, header.height, header.width]).toEqual([1, H, W]);
    expect(header.tables[0]).toEqual(libjpegQuantTable("luma", 75));
  });

  it("stores PNG, as before, without a choice", async () => {
    const labels = labelsOn(new Video({ filename: "clip.mp4", backend: backend(10, 3) }), [2]);
    await exportLabelsPackage(labels, "clip.slp", "user");
    const { backend: b } = await readBack(saved[0]);
    expect(b.embeddedFormat).toBe("png");
    const png = (await b.getFrameBuffer(2))!;
    expect([png[0], png[1], png[2], png[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it("converts an already-embedded PNG package to JPEG", async () => {
    const labels = labelsOn(new Video({ filename: "clip.mp4", backend: backend(10, 3) }), [1, 6]);
    await exportLabelsPackage(labels, "clip.slp", "user");
    const { labels: pngPackage, backend: before } = await readBack(saved[0]);
    expect(before.embeddedFormat).toBe("png");

    await exportLabelsPackage(pngPackage, "clip.pkg.slp", "user", {
      image: { format: "jpg", quality: 85 },
    });
    expect(toastError).not.toHaveBeenCalled();
    const { labels: back, video, backend: b } = await readBack(saved[1]);
    expect(b.embeddedFormat).toBe("jpg");
    expect(video.shape?.slice(1)).toEqual([H, W, 3]);
    expect(back.labeledFrames.map((f) => f.frameIdx)).toEqual([1, 6]);
    for (const frameIdx of [1, 6]) {
      const header = jpegHeader((await b.getFrameBuffer(frameIdx))!);
      expect([header.comps, header.height, header.width]).toEqual([3, H, W]);
      expect(header.tables[0]).toEqual(libjpegQuantTable("luma", 85));
    }
  });

  it("desktop: ffmpeg's PNG frames go to the worker as pixels under a jpg entry", async () => {
    const io = sio as unknown as SioJpeg;
    // PNG frames as ffmpeg would extract them: here, those of a PNG package.
    const source = labelsOn(new Video({ filename: "clip.mp4", backend: backend(10, 3) }), [3]);
    await exportLabelsPackage(source, "clip.slp", "user");
    const png = (await (await readBack(saved[0])).backend.getFrameBuffer(3))!;
    expect([png[0], png[1], png[2], png[3]]).toEqual([0x89, 0x50, 0x4e, 0x47]);

    const labels = labelsOn(new Video({ filename: "clip.mp4", backend: backend(10, 3) }), [3, 5]);
    const { withImageFormat } = await import("@/lib/packageImageFormat");
    const plan = await io.buildSerializableEmbedPlan(
      labels,
      "user",
      "",
      withImageFormat({ allowEncode: true }, { format: "jpg", quality: 90 })
    );
    expect(plan.encodeEntries).toHaveLength(1);
    const entry = plan.encodeEntries[0];
    // What the worker encodes in and records on the dataset.
    expect(entry.format).toBe("jpg");
    expect(entry.formatChosen).toBe(true);
    expect(entry.quality).toBe(90);
    expect(entry.channelOrder).toBe("RGB");

    const appended: Array<{ frameIdx: number; kind: string; channels?: number }> = [];
    const sink = {
      beginEncodedVideo: async () => {},
      appendEncodedFrame: async (frameIdx: number, frame: { kind: string; channels?: number }) =>
        void appended.push({ frameIdx, kind: frame.kind, channels: frame.channels }),
      endEncodedVideo: async () => ({ framesWritten: appended.length }),
    };
    await io.appendEncodedVideos(sink, labels, plan.encodeEntries, {
      frameReader: async () => ({ read: async () => png.slice(), close: () => {} }),
    });
    // Decoded here, encoded as JPEG by the worker: never stored as PNG.
    expect(appended.map((a) => [a.frameIdx, a.kind])).toEqual([
      [3, "pixels"],
      [5, "pixels"],
    ]);
    expect(appended[0].channels).toBe(3);
  });
});
