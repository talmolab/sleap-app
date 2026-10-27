/**
 * Desktop package export: frames extracted by the ffmpeg sidecar
 * (`extractFrames.ts`). The filter/args are checked as strings; the reader
 * runs against fake deps (a fake ffmpeg that "writes" numbered PNGs and
 * reports progress). The real sidecar is covered by manual desktop checks.
 */
import { describe, it, expect, beforeEach } from "../bun-test";
import {
  buildFrameSelectFilter,
  buildExtractFramesArgs,
  extractableVideoPath,
  createFfmpegFrameReader,
  __resetFfmpegCheck,
  EXTRACT_PNG_ARGS,
  type ExtractFramesDeps,
} from "@/lib/transcode/extractFrames";
import type { TranscodeProgress } from "@/lib/transcode/transcodeVideo";

function fakeVideo(overrides: Record<string, unknown> = {}) {
  return {
    filename: "/data/fly.mp4",
    hasEmbeddedImages: false,
    shape: [100, 8, 8, 3],
    backend: null,
    ...overrides,
  } as never;
}

/** Fake platform: an in-memory folder and an ffmpeg the test drives. */
function fakeDeps(options: { ffmpegRuns?: boolean } = {}) {
  const files = new Map<string, Uint8Array | string>();
  const removedDirs: string[] = [];
  let progress: (p: TranscodeProgress) => void = () => {};
  let finish: (err?: Error) => void = () => {};
  let args: string[] = [];
  let aborted = false;
  const deps: ExtractFramesDeps = {
    cacheDir: async () => "/cache",
    join: async (...parts: string[]) => parts.join("/"),
    mkdir: async () => {},
    exec: async () => ({ stdout: "", stderr: "", code: options.ffmpegRuns === false ? 1 : 0 }),
    runTranscode: (a, onProgress, signal) => {
      args = a;
      progress = onProgress;
      return new Promise<void>((resolve, reject) => {
        finish = (err) => (err ? reject(err) : resolve());
        signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("Transcode cancelled"));
        });
      });
    },
    readFile: async (path) => {
      const f = files.get(path);
      if (!(f instanceof Uint8Array)) throw new Error(`no file ${path}`);
      return f;
    },
    writeText: async (path, text) => void files.set(path, text),
    removeFile: async (path) => void files.delete(path),
    removeDir: async (path) => void removedDirs.push(path),
    newId: () => "job1",
  };
  const dir = "/cache/export-frames/job1";
  return {
    deps,
    files,
    removedDirs,
    dir,
    get args() {
      return args;
    },
    get aborted() {
      return aborted;
    },
    /** ffmpeg writes output frame `n` (1-based) and reports it. */
    write(n: number) {
      files.set(`${dir}/${String(n).padStart(6, "0")}.png`, new Uint8Array([n]));
      progress({ frame: n, done: false });
    },
    exit: (err?: Error) => finish(err),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => __resetFfmpegCheck());

describe("buildFrameSelectFilter", () => {
  it("selects runs with between() and single frames with eq()", () => {
    expect(buildFrameSelectFilter([0, 1, 2, 5, 9, 10], false)).toBe(
      "select='between(n,0,2)+eq(n,5)+between(n,9,10)',format=rgb24"
    );
  });

  it("keeps the red channel for grayscale, as Python sleap-io does", () => {
    expect(buildFrameSelectFilter([3], true)).toBe(
      "select='eq(n,3)',format=rgb24,format=gbrp,extractplanes=r"
    );
  });
});

describe("buildExtractFramesArgs", () => {
  it("reads the filter from a file, keeps frames exact, and writes PNGs with progress", () => {
    const args = buildExtractFramesArgs({
      input: "/in.mp4",
      filterFile: "/tmp/select.txt",
      outPattern: "/tmp/%06d.png",
      frameCount: 12,
    });
    expect(args[args.indexOf("-i") + 1]).toBe("/in.mp4");
    expect(args[args.indexOf("-/vf") + 1]).toBe("/tmp/select.txt");
    expect(args[args.indexOf("-fps_mode") + 1]).toBe("passthrough");
    // Stops after the last wanted frame instead of decoding to the end.
    expect(args[args.indexOf("-frames:v") + 1]).toBe("12");
    expect(args[args.indexOf("-progress") + 1]).toBe("pipe:1");
    expect(args.join(" ")).toContain(EXTRACT_PNG_ARGS.join(" "));
    expect(args[args.length - 1]).toBe("/tmp/%06d.png");
  });
});

describe("extractableVideoPath", () => {
  it("is the local file of a continuous video", () => {
    expect(extractableVideoPath(fakeVideo())).toBe("/data/fly.mp4");
  });

  it("is null for embedded images, image sequences and URLs", () => {
    expect(extractableVideoPath(fakeVideo({ hasEmbeddedImages: true }))).toBeNull();
    expect(extractableVideoPath(fakeVideo({ filename: ["/a.png", "/b.png"] }))).toBeNull();
    expect(extractableVideoPath(fakeVideo({ filename: "https://x.org/v.mp4" }))).toBeNull();
  });
});

describe("createFfmpegFrameReader", () => {
  it("returns each frame once ffmpeg has finished it, then deletes it", async () => {
    const f = fakeDeps();
    const reader = await createFfmpegFrameReader(fakeVideo(), [4, 7, 8], f.deps);
    expect(reader).not.toBeNull();
    expect(f.files.get(`${f.dir}/select.txt`)).toBe(
      "select='eq(n,4)+between(n,7,8)',format=rgb24"
    );
    expect(f.args[f.args.length - 1]).toBe(`${f.dir}/%06d.png`);
    expect(f.args[f.args.indexOf("-frames:v") + 1]).toBe("3");

    let first: unknown = "pending";
    void reader!.read(4).then((b) => (first = b));
    f.write(1);
    await tick();
    // The newest file may still be being written.
    expect(first).toBe("pending");
    f.write(2);
    await tick();
    expect(first).toEqual(new Uint8Array([1]));
    expect(f.files.has(`${f.dir}/000001.png`)).toBe(false);

    f.write(3);
    f.exit();
    expect(await reader!.read(7)).toEqual(new Uint8Array([2]));
    // After ffmpeg exits, the last frame is complete too.
    expect(await reader!.read(8)).toEqual(new Uint8Array([3]));
    await reader!.close();
    expect(f.removedDirs).toEqual([f.dir]);
  });

  it("asks ffmpeg for grayscale frames when the video has one channel", async () => {
    const f = fakeDeps();
    await createFfmpegFrameReader(fakeVideo({ shape: [10, 8, 8, 1] }), [0], f.deps);
    expect(f.files.get(`${f.dir}/select.txt`)).toContain("extractplanes=r");
  });

  it("refuses frames asked for out of order", async () => {
    const f = fakeDeps();
    const reader = await createFfmpegFrameReader(fakeVideo(), [1, 2], f.deps);
    await expect(reader!.read(2)).rejects.toThrow("out of order");
  });

  it("returns null for a frame ffmpeg never wrote", async () => {
    const f = fakeDeps();
    const reader = await createFfmpegFrameReader(fakeVideo(), [99], f.deps);
    f.exit();
    expect(await reader!.read(99)).toBeNull();
  });

  it("surfaces an ffmpeg failure instead of waiting forever", async () => {
    const f = fakeDeps();
    const reader = await createFfmpegFrameReader(fakeVideo(), [0], f.deps);
    f.exit(new Error("ffmpeg exited with code 1"));
    await expect(reader!.read(0)).rejects.toThrow("code 1");
  });

  it("stops ffmpeg and removes the folder when closed early", async () => {
    const f = fakeDeps();
    const reader = await createFfmpegFrameReader(fakeVideo(), [0, 1, 2], f.deps);
    f.write(1);
    await reader!.close();
    expect(f.aborted).toBe(true);
    expect(f.removedDirs).toEqual([f.dir]);
  });

  it("is null (decode in the app) when ffmpeg can't run or the video isn't a local file", async () => {
    const broken = fakeDeps({ ffmpegRuns: false });
    expect(await createFfmpegFrameReader(fakeVideo(), [0], broken.deps)).toBeNull();
    __resetFfmpegCheck();
    const f = fakeDeps();
    expect(
      await createFfmpegFrameReader(fakeVideo({ hasEmbeddedImages: true }), [0], f.deps)
    ).toBeNull();
    expect(await createFfmpegFrameReader(fakeVideo(), [], f.deps)).toBeNull();
  });
});
