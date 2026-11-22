/**
 * JPEG package export end to end (#512), through the app's own Export Labels
 * Package (the in-memory path; the Save dialog and the platform are faked)
 * and sleap-io.js's real writers, then read back with sleap-io.js.
 *
 * - A colour and a grayscale video export as JPEG: the package reads back
 *   with format "jpg", RGB, the video's shape, and stored JPEGs of the right
 *   size and channel count, written with libjpeg's tables at the chosen
 *   quality: the tables the desktop's ffmpeg extraction is given
 *   (`libjpegQuantTable`).
 * - Without a choice the same export stores PNG, as before.
 * - JPEGs extracted by ffmpeg with the app's arguments (the fixture
 *   `ffmpeg_extract_q90.jpg`, made with `buildExtractFramesArgs` at quality
 *   90) are stored as they are, on the in-memory path and on the streaming
 *   writer's (whose worker is replaced by a recording sink), so the package's
 *   `format` attribute and its bytes agree.
 *
 * Needs a sleap-io.js that writes JPEG frames (`imageFormat`); with an older
 * one the suite skips itself and says so.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "../bun-test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const { libjpegQuantTable } = await import("@/lib/transcode/extractFrames");

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
const FIXTURE = new Uint8Array(
  readFileSync(join(import.meta.dir, "../fixtures/ffmpeg_extract_q90.jpg"))
);

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

/** A video whose frames come back as encoded bytes, as ffmpeg's do. */
function encodedBackend(n: number, bytes: Uint8Array): VideoBackend {
  return {
    filename: "clip.mp4",
    shape: [n, H, W, 3],
    fps: 30,
    embeddedChannelOrder: "RGB",
    async getFrame(idx: number): Promise<VideoFrame | null> {
      return idx >= 0 && idx < n ? (bytes.slice() as never) : null;
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
      // The tables ffmpeg is given for quality 90 on the desktop.
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

  it("the ffmpeg fixture was made with the documented tables (AC; ffmpeg's DC is 8)", () => {
    const header = jpegHeader(FIXTURE);
    expect([header.comps, header.height, header.width]).toEqual([3, H, W]);
    for (const [k, table] of (["luma", "chroma"] as const).entries()) {
      expect(header.tables[k].slice(1)).toEqual(libjpegQuantTable(table, 90).slice(1));
      expect(header.tables[k][0]).toBe(8);
    }
  });

  it("keeps ffmpeg's JPEGs as they are, with format jpg (in memory)", async () => {
    const labels = labelsOn(new Video({ filename: "clip.mp4", backend: encodedBackend(4, FIXTURE) }), [0, 2]);
    await exportLabelsPackage(labels, "clip.slp", "user", { image: { format: "jpg", quality: 90 } });
    const { backend: b } = await readBack(saved[0]);
    expect(b.embeddedFormat).toBe("jpg");
    expect(b.embeddedChannelOrder).toBe("RGB");
    expect(await b.getFrameBuffer(2)).toEqual(FIXTURE);
  });

  it("keeps ffmpeg's JPEGs as they are on the streaming writer, whose entry says jpg", async () => {
    const io = sio as unknown as SioJpeg;
    const labels = labelsOn(new Video({ filename: "clip.mp4", backend: backend(10, 3) }), [3, 5]);
    const { withImageFormat } = await import("@/lib/slpFormatCompat");
    const image = { format: "jpg" as const, quality: 90 };
    const plan = await io.buildSerializableEmbedPlan(
      labels,
      "user",
      "",
      withImageFormat({ allowEncode: true }, image)
    );
    expect(plan.encodeEntries).toHaveLength(1);
    const entry = plan.encodeEntries[0];
    // What the worker records on the dataset: format and channel order.
    expect(entry.format).toBe("jpg");
    expect(entry.channelOrder).toBe("RGB");
    expect(entry.quality).toBe(90);

    const appended: Array<{ frameIdx: number; kind: string; bytes?: Uint8Array }> = [];
    const sink = {
      beginEncodedVideo: async () => {},
      appendEncodedFrame: async (frameIdx: number, frame: { kind: string; bytes?: Uint8Array }) =>
        void appended.push({ frameIdx, kind: frame.kind, bytes: frame.bytes }),
      endEncodedVideo: async () => ({ framesWritten: appended.length }),
    };
    // ffmpeg's reader, as the desktop export hands it over: the extracted JPEGs.
    await io.appendEncodedVideos(sink, labels, plan.encodeEntries, {
      frameReader: async () => ({ read: async () => FIXTURE.slice(), close: () => {} }),
    });
    expect(appended.map((a) => [a.frameIdx, a.kind])).toEqual([
      [3, "jpg"],
      [5, "jpg"],
    ]);
    expect(appended[0].bytes).toEqual(FIXTURE);
  });
});
