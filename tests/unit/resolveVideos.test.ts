/**
 * Tests for the standalone-video format dispatch added in PR-A of issue #138.
 *
 * Only the decoder-independent dispatch is unit-tested here: unsupported
 * formats must be rejected (return null) WITHOUT attempting a decode. The MP4
 * happy path needs a real Mp4Box decode of a real file, so it's covered by the
 * live E2E rather than a synthetic unit test.
 */

import { describe, it, expect, afterEach } from "../bun-test";
import {
  Labels,
  Video,
  setImageBytesReader,
  GrayscaleVideoBackend,
  type VideoBackend,
} from "@talmolab/sleap-io.js";
import {
  buildStandaloneVideo,
  addVideoFileToLabels,
  assignVideoBackend,
  backendKindForFilename,
  pickedFromFiles,
  pickedFromPaths,
  resolveImageFramesInFolder,
  resolveExternalVideos,
  ensureVideoBackend,
  isVideoMissing,
  classifyVideoError,
  videoIssue,
  getVideoPathCandidates,
  computePrefixSwap,
  SUPPORTED_VIDEO_EXTS,
  collectHandlesByBasename,
  resolveAllVideosFromFolder,
  isImageSequenceVideo,
  relocateMissingImageFrames,
  isSupportedVideoUrl,
  resolveScrubProxyOpenPath,
  openViaProxyOrNull,
  type ScrubProxyDeps,
  type ProxyOpenDeps,
} from "@/lib/resolveVideos";
import { useAppStore } from "@/stores/appStore";
import { useTranscodeStore } from "@/stores/transcodeStore";
import { shouldBuildScrubProxy } from "@/lib/transcode/proxyPolicy";

// Minimal mock File System Access handle tree for the folder-scan tests.
type MockHandle =
  | { kind: "file" }
  | {
      kind: "directory";
      entries: () => AsyncIterableIterator<[string, MockHandle]>;
    };
function fileHandle(): MockHandle {
  return { kind: "file" };
}
function dirHandle(children: Record<string, MockHandle>): MockHandle {
  return {
    kind: "directory",
    entries: async function* () {
      for (const [name, h] of Object.entries(children)) {
        yield [name, h] as [string, MockHandle];
      }
    },
  };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asDir = (h: MockHandle) => h as any;

function fakeFile(name: string): File {
  return new File([new Uint8Array([0])], name, { type: "video/mp4" });
}

// --- Minimal synthetic .seq builder -----------------------------------------
// `.seq` is the one supported video format that decodes with pure JS parsing
// (no WebCodecs/Mp4Box), so it's the only real-decode path usable in bun's
// test runner without an E2E browser. Trimmed from sleap-io.js's own
// `tests/video/seq.test.ts` fixture builder (uncompressed path only).
const SEQ_HEADER_SIZE = 1024;
const SEQ_MAGIC = 0xfeed;

function seqHeader(opts: {
  width: number;
  height: number;
  color: boolean;
  numFrames: number;
  imageSizeBytes: number;
  trueImageSize: number;
}): Uint8Array {
  const buf = new Uint8Array(SEQ_HEADER_SIZE);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, SEQ_MAGIC, true);
  dv.setInt32(28, 4, true); // version
  dv.setUint32(32, SEQ_HEADER_SIZE, true);
  dv.setUint32(548, opts.width, true);
  dv.setUint32(552, opts.height, true);
  dv.setUint32(556, opts.color ? 24 : 8, true); // bitDepth
  dv.setUint32(560, 8, true); // bitDepthReal
  dv.setUint32(564, opts.imageSizeBytes, true);
  dv.setUint32(568, opts.color ? 200 : 100, true); // imageFormat: raw BGR / monoraw
  dv.setUint32(572, opts.numFrames, true);
  dv.setUint32(580, opts.trueImageSize, true);
  dv.setFloat64(584, 30, true); // fps
  return buf;
}

/** One uncompressed frame's raw bytes: BGR (color) or mono, value `v` on every byte. */
function seqFrameBytes(width: number, height: number, color: boolean, v: number): Uint8Array {
  const nch = color ? 3 : 1;
  return new Uint8Array(width * height * nch).fill(v);
}

/** Build a minimal single-frame uncompressed `.seq` File (version 4 -> 6-byte timestamps). */
function buildSeqFile(opts: {
  name: string;
  width: number;
  height: number;
  color: boolean;
  pixelValue: number;
}): File {
  const nch = opts.color ? 3 : 1;
  const imageSizeBytes = opts.width * opts.height * nch;
  const tsSize = 6;
  const header = seqHeader({
    width: opts.width,
    height: opts.height,
    color: opts.color,
    numFrames: 1,
    imageSizeBytes,
    trueImageSize: imageSizeBytes + tsSize,
  });
  const frame = seqFrameBytes(opts.width, opts.height, opts.color, opts.pixelValue);
  const ts = new Uint8Array(tsSize); // all-zero timestamp is fine
  const buf = new Uint8Array(header.length + frame.length + ts.length);
  buf.set(header, 0);
  buf.set(frame, header.length);
  buf.set(ts, header.length + frame.length);
  return new File([buf], opts.name);
}

describe("classifyVideoError + videoIssue (codec failure surfacing)", () => {
  it("maps 'Codec ... not supported' to a decode error", () => {
    const e = classifyVideoError(
      new Error("Codec hvc1.2.4.L150.90 not supported")
    );
    expect(e.kind).toBe("decode");
    expect(e.message).toContain("hvc1");
  });

  it("maps UnsupportedVideoFormatError to unsupported-format", () => {
    const err = Object.assign(new Error(".avi cannot be decoded"), {
      name: "UnsupportedVideoFormatError",
    });
    expect(classifyVideoError(err).kind).toBe("unsupported-format");
  });

  it("defaults to decode for a located-but-unopenable file", () => {
    expect(classifyVideoError(new Error("boom")).kind).toBe("decode");
    expect(classifyVideoError("weird").kind).toBe("decode");
  });

  it("videoIssue: unsupported-codec when backend is null with a codec error", () => {
    const decode = new Video({
      filename: "clip.mp4",
      backend: null,
      backendError: { kind: "decode", message: "Codec hvc1 not supported" },
      openBackend: false,
    });
    expect(videoIssue(decode)).toBe("unsupported-codec");
    const fmt = new Video({
      filename: "clip.avi",
      backend: null,
      backendError: { kind: "unsupported-format", message: "x" },
      openBackend: false,
    });
    expect(videoIssue(fmt)).toBe("unsupported-codec");
  });

  it("videoIssue: missing when no backend and the file is just absent", () => {
    const gone = new Video({
      filename: "gone.mp4",
      backend: null,
      openBackend: false,
    });
    expect(videoIssue(gone)).toBe("missing");
    // An unresolved image sequence is "missing" (locate a folder), not a codec.
    const img = new Video({
      filename: "frame.png",
      backend: null,
      backendError: { kind: "image-sequence", message: "x" },
      openBackend: false,
    });
    expect(videoIssue(img)).toBe("missing");
  });
});

describe("Labels runtime API used by pickAndAddVideos", () => {
  // Guards against a sleap-io.js types-vs-runtime mismatch: the .d.ts declared
  // Labels.update() but the shipped JS only implements reindex(), so the
  // typechecker passed while update() threw at runtime. Assert the methods we
  // actually call exist as functions on a real Labels instance.
  it("exposes addVideo and reindex as runtime methods", () => {
    const labels = new Labels();
    expect(typeof labels.addVideo).toBe("function");
    expect(typeof labels.reindex).toBe("function");
  });
});

describe("addVideoFileToLabels", () => {
  it("skips an unsupported format: returns null and adds nothing", async () => {
    const labels = new Labels();
    const result = await addVideoFileToLabels(labels, {
      file: fakeFile("clip.xyz"), // .xyz has no backend → gate-rejected
      absPath: null,
    });
    expect(result).toBeNull();
    expect(labels.videos.length).toBe(0);
  });
});

describe("import-time grayscale (real .seq decode, no WebCodecs needed)", () => {
  it("grayscale: true forces the backend to 1 channel and persists the flag", async () => {
    const file = buildSeqFile({
      name: "color.seq",
      width: 4,
      height: 3,
      color: true,
      pixelValue: 42,
    });
    const video = await buildStandaloneVideo(file, null, true);
    expect(video).not.toBeNull();
    expect(video!.shape).toEqual([1, 3, 4, 1]);
    expect(video!.backendMetadata.grayscale).toBe(true);
    expect(video!.backend).toBeInstanceOf(GrayscaleVideoBackend);

    const frame = (await video!.getFrame(0)) as {
      channels?: number;
      width?: number;
      height?: number;
    };
    expect(frame.channels).toBe(1);
  });

  it("grayscale: false preserves the source's native channel count", async () => {
    const file = buildSeqFile({
      name: "color2.seq",
      width: 4,
      height: 3,
      color: true,
      pixelValue: 99,
    });
    const video = await buildStandaloneVideo(file, null, false);
    expect(video).not.toBeNull();
    expect(video!.shape).toEqual([1, 3, 4, 3]);
    expect(video!.backendMetadata.grayscale).toBe(false);
  });

  it("omitting grayscale adds the video unflagged (today's behavior, unchanged)", async () => {
    const file = buildSeqFile({
      name: "plain.seq",
      width: 4,
      height: 3,
      color: true,
      pixelValue: 7,
    });
    const video = await buildStandaloneVideo(file);
    expect(video).not.toBeNull();
    expect(video!.backend instanceof GrayscaleVideoBackend).toBe(false);
    expect(Object.hasOwn(video!.backendMetadata, "grayscale")).toBe(false);
  });

  it(
    "round-trip: reassigning a backend without an explicit grayscale option " +
      "re-derives it from the video's already-persisted backendMetadata " +
      "(the reopen/relink case after a project reload)",
    async () => {
      const file = buildSeqFile({
        name: "roundtrip.seq",
        width: 4,
        height: 3,
        color: true,
        pixelValue: 55,
      });
      const video = await buildStandaloneVideo(file, null, true);
      expect(video).not.toBeNull();
      expect(video!.shape).toEqual([1, 3, 4, 1]);

      // Simulate a relink/reopen (e.g. "Locate video" after a project reload):
      // a fresh assignVideoBackend call with NO explicit grayscale option.
      const ok = await assignVideoBackend(video!, file);
      expect(ok).toBe(true);
      expect(video!.backend).toBeInstanceOf(GrayscaleVideoBackend);
      expect(video!.shape).toEqual([1, 3, 4, 1]); // still forced to 1 channel.
      expect(video!.backendMetadata.grayscale).toBe(true); // still persisted.
    }
  );
});

describe("SUPPORTED_VIDEO_EXTS", () => {
  it("lists every decodable format, including .avi/.wmv", () => {
    expect([...SUPPORTED_VIDEO_EXTS].sort()).toEqual([
      "avi", "mkv", "mov", "mp4", "mpeg", "mpg", "ogg", "ogv", "seq", "ts", "webm", "wmv",
    ]);
    // AVI/WMV/MPEG are now selectable + routed via the web-demuxer AviVideoBackend
    // (desktop transcodes undecodable payloads; browser shows the convert message).
    expect(SUPPORTED_VIDEO_EXTS).toContain("avi");
    expect(SUPPORTED_VIDEO_EXTS).toContain("wmv");
    expect(SUPPORTED_VIDEO_EXTS).toContain("mpeg");
  });
});

describe("buildStandaloneVideo (gate)", () => {
  // Only UNSUPPORTED extensions here: a supported ext would attempt a real
  // MediaBunny/Mp4Box/AVI decode, which can't run under the bun test runner.
  // (`.avi`/`.wmv` are no longer gate-rejected — they route to AviVideoBackend
  // and fail later at the decode probe, which E2E covers.)
  it("rejects unsupported formats and returns null without decoding", async () => {
    for (const name of ["clip.xyz", "noextension"]) {
      expect(await buildStandaloneVideo(fakeFile(name))).toBeNull();
    }
  });
});

describe("resolveImageFramesInFolder", () => {
  it("maps each frame positionally to <folder>/<basename> and splits missing", async () => {
    const frames = ["/old/a.png", "/old/b.png", "/old/c.png"];
    const present = new Set(["/imgs/a.png", "/imgs/c.png"]);
    const exists = async (p: string) => present.has(p);

    const { located, missing } = await resolveImageFramesInFolder(
      frames,
      "/imgs",
      exists
    );

    // positional: one located path per input frame, in order
    expect(located).toEqual(["/imgs/a.png", "/imgs/b.png", "/imgs/c.png"]);
    // b.png wasn't found
    expect(missing).toEqual(["/old/b.png"]);
  });

  it("strips a trailing slash on the folder", async () => {
    const { located } = await resolveImageFramesInFolder(
      ["x/a.png"],
      "/imgs/",
      async () => true
    );
    expect(located).toEqual(["/imgs/a.png"]);
  });

  it("infers a Windows separator from the folder", async () => {
    const { located } = await resolveImageFramesInFolder(
      ["C:\\old\\a.png"],
      "D:\\imgs",
      async () => true
    );
    expect(located).toEqual(["D:\\imgs\\a.png"]);
  });

  it("reports every frame missing when none exist", async () => {
    const frames = ["/old/a.png", "/old/b.png"];
    const { located, missing } = await resolveImageFramesInFolder(
      frames,
      "/empty",
      async () => false
    );
    expect(located.length).toBe(2);
    expect(missing).toEqual(frames);
  });

  it("detects a subfolder tail so any ANCESTOR folder works (avoids the huge leaf dir)", async () => {
    // User picks the PROJECT folder, not the leaf `raw/` directory that holds the
    // 10k images: we detect the one-level tail from frame 0 and apply it to all.
    const frames = ["/home/u/proj/raw/a.png", "/home/u/proj/raw/b.png"];
    const present = new Set(["/proj/raw/a.png", "/proj/raw/b.png"]);
    const exists = async (p: string) => present.has(p);
    const { located, missing } = await resolveImageFramesInFolder(
      frames,
      "/proj",
      exists
    );
    expect(located).toEqual(["/proj/raw/a.png", "/proj/raw/b.png"]);
    expect(missing).toEqual([]);
  });

  it("resolves a MIXED-depth sequence (frames at different subdir depths) per-frame", async () => {
    // COCO datasets can reference images at varying depths (some in the folder
    // root, some in subfolders). A single voted depth applied to every frame
    // would drop the subfolder for the odd-depth frames; each frame must resolve
    // at its OWN depth.
    const frames = ["/old/a.png", "/old/sub/b.png"];
    const present = new Set(["/imgs/a.png", "/imgs/sub/b.png"]);
    const exists = async (p: string) => present.has(p);
    const { located, missing } = await resolveImageFramesInFolder(
      frames,
      "/imgs",
      exists
    );
    expect(located).toEqual(["/imgs/a.png", "/imgs/sub/b.png"]);
    expect(missing).toEqual([]);
  });

  it("keeps an already-correct absolute frame path that isn't under the folder", async () => {
    // A frame whose stored absolute path already exists (e.g. COCO with absolute
    // file_names) should be kept as-is when it can't be grafted under the folder.
    const frames = ["/mnt/data/a.png"];
    const present = new Set(["/mnt/data/a.png"]);
    const exists = async (p: string) => present.has(p);
    const { located, missing } = await resolveImageFramesInFolder(
      frames,
      "/imgs",
      exists
    );
    expect(located).toEqual(["/mnt/data/a.png"]);
    expect(missing).toEqual([]);
  });

  it("recovers present frames when frame 0 is missing (depth voted from other frames)", async () => {
    // Frame 0 was deleted; the rest live in a subfolder under the picked parent.
    // Depth must be voted from the surviving frames, not defaulted to basename.
    const frames = ["/orig/imgs/000.png", "/orig/imgs/001.png", "/orig/imgs/002.png"];
    const present = new Set(["/proj/imgs/001.png", "/proj/imgs/002.png"]); // 000 gone
    const exists = async (p: string) => present.has(p);
    const { located, missing } = await resolveImageFramesInFolder(
      frames,
      "/proj",
      exists
    );
    expect(located).toEqual([
      "/proj/imgs/000.png",
      "/proj/imgs/001.png",
      "/proj/imgs/002.png",
    ]);
    expect(missing).toEqual(["/orig/imgs/000.png"]); // only the truly-deleted frame
  });

  it("picks the true subfolder depth despite a stray same-named copy in the ancestor", async () => {
    // A stray /proj/a.png sits beside the picked folder while the real images are
    // in /proj/raw/. Frame 0 votes depth 1 (stray), the rest vote depth 2; the
    // majority wins so every real image resolves.
    const frames = ["/old/raw/a.png", "/old/raw/b.png", "/old/raw/c.png"];
    const present = new Set([
      "/proj/a.png", // stray shallow copy (frame 0 basename)
      "/proj/raw/a.png",
      "/proj/raw/b.png",
      "/proj/raw/c.png",
    ]);
    const exists = async (p: string) => present.has(p);
    const { located, missing } = await resolveImageFramesInFolder(
      frames,
      "/proj",
      exists
    );
    expect(located).toEqual([
      "/proj/raw/a.png",
      "/proj/raw/b.png",
      "/proj/raw/c.png",
    ]);
    expect(missing).toEqual([]);
  });
});

describe("resolveExternalVideos (image sequences)", () => {
  // Image sequences (ImageVideo) are opened by the SLP reader's FsResolver during
  // loadSlp when their paths resolve. A missing one arrives here with
  // backend === null + backendError.kind === "image-sequence". resolveExternalVideos
  // then AUTO-locates it against the project dir + ancestors (#215) — but must never
  // route a frame LIST into the single-file (mp4box) path, which hangs on a JPEG.
  function missingImageSeq(paths: string[]): Video {
    const v = new Video({ filename: paths, openBackend: false });
    v.backend = null;
    v.backendError = { kind: "image-sequence", message: "not found" };
    v.shape = [paths.length, 8, 8, 1];
    return v;
  }

  it("leaves a genuinely-missing image sequence flagged missing", async () => {
    const video = missingImageSeq(["/gone/a.jpg", "/gone/b.jpg", "/gone/c.jpg"]);
    const labels = new Labels();
    labels.addVideo(video);

    await resolveExternalVideos(labels, {
      projectPath: "/proj/labels.slp",
      exists: async () => false,
      readFile: async () => new Uint8Array(),
    });

    expect(video.backend).toBeNull();
    expect(isVideoMissing(video)).toBe(true);
  });

  it("never routes a frame list into the single-file (mp4box) path", async () => {
    // The failure this guards: feeding a JPEG list to mp4box (which hangs). Even a
    // filesystem that claims every candidate exists must resolve an image sequence
    // via the image path (its own backend), never the single-file readFile path.
    setImageBytesReader(async () => new Uint8Array([0]));
    const video = missingImageSeq(["frames/a.jpg", "frames/b.jpg"]);
    const labels = new Labels();
    labels.addVideo(video);

    let readFileCalled = false;
    await resolveExternalVideos(labels, {
      projectPath: "/proj/labels.slp",
      exists: async () => true, // pretend everything resolves
      readFile: async () => {
        readFileCalled = true;
        return new Uint8Array([0, 0, 0]);
      },
    });

    // The single-file (mp4box) path reads bytes via readFile; the image path never does.
    expect(readFileCalled).toBe(false);
    // It went through the image path: filenames were rewritten to located absolutes.
    expect(Array.isArray(video.filename)).toBe(true);
    expect((video.filename as string[]).every((f) => f.startsWith("/proj"))).toBe(true);
  });

  it("auto-locates a relative image sequence against the project dir (#215)", async () => {
    setImageBytesReader(async () => new Uint8Array([0]));
    // Frames stored RELATIVE to the .slp; the images live beside it under frames/.
    const rel = ["frames/001.png", "frames/002.png", "frames/003.png"];
    const video = missingImageSeq(rel);
    const labels = new Labels();
    labels.addVideo(video);

    const present = new Set([
      "/proj/dir/frames/001.png",
      "/proj/dir/frames/002.png",
      "/proj/dir/frames/003.png",
    ]);

    await resolveExternalVideos(labels, {
      projectPath: "/proj/dir/sod1.slp",
      exists: async (p) => present.has(p),
      readFile: async () => new Uint8Array(),
    });

    // Frame paths rewritten to the located absolutes beside the .slp.
    expect(video.filename).toEqual([
      "/proj/dir/frames/001.png",
      "/proj/dir/frames/002.png",
      "/proj/dir/frames/003.png",
    ]);
    // Original relative path preserved for re-save.
    expect((video.backendMetadata as Record<string, unknown>).sourceFilename).toBe(
      "frames/001.png"
    );
    expect(isVideoMissing(video)).toBe(false);
  });

  it("leaves an already-opened image sequence untouched", async () => {
    // The loader built a working backend for a resolvable sequence;
    // resolveExternalVideos must not disturb it.
    const video = new Video({ filename: ["/imgs/a.jpg"], openBackend: false });
    video.backend = { getFrame: async () => null } as never; // non-null (loader-built)
    video.shape = [1, 8, 8, 1];
    const labels = new Labels();
    labels.addVideo(video);

    await resolveExternalVideos(labels, {
      projectPath: "/proj/labels.slp",
      exists: async () => false,
      readFile: async () => new Uint8Array(),
    });

    expect(video.backend).not.toBeNull();
    expect(isVideoMissing(video)).toBe(false);
  });

  it("resolves a large ABSOLUTE-path sequence from ONE probe (no per-frame sweep)", async () => {
    // Regression: a 1000-frame sequence whose stored absolute paths are still
    // valid (mounted volume) must resolve WITHOUT one exists() per frame — that
    // per-frame sweep was ~one network round-trip per frame (the dominant cost
    // of opening such a project). The first-frame probe + prefix-swap does it.
    setImageBytesReader(async () => new Uint8Array([0]));
    const N = 1000;
    const paths = Array.from({ length: N }, (_, i) => `/vol/seq/img_${i}.jpg`);
    const video = missingImageSeq(paths);
    const labels = new Labels();
    labels.addVideo(video);

    const present = new Set(paths); // only the verbatim absolute paths exist
    let existsCalls = 0;
    await resolveExternalVideos(labels, {
      projectPath: "/proj/dir/labels.slp",
      exists: async (p) => {
        existsCalls++;
        return present.has(p);
      },
      readFile: async () => new Uint8Array(),
    });

    expect(isVideoMissing(video)).toBe(false);
    // Frame paths kept verbatim (already valid); all N present.
    expect(video.filename).toEqual(paths);
    // Bounded probe count — a small constant, NOT one per frame (would be ~1000).
    expect(existsCalls).toBeLessThan(30);
  });

  it("grafts a large RELATIVE sequence beside the .slp from ONE probe (#216 intent, bounded)", async () => {
    // #216's target: frames stored RELATIVE, images sitting beside the .slp. The
    // located folder is found from the first frame, then the same prefix-swap is
    // applied to every frame — no per-frame probing.
    setImageBytesReader(async () => new Uint8Array([0]));
    const N = 800;
    const rel = Array.from(
      { length: N },
      (_, i) => `frames/${String(i).padStart(4, "0")}.png`,
    );
    const video = missingImageSeq(rel);
    const labels = new Labels();
    labels.addVideo(video);

    let existsCalls = 0;
    await resolveExternalVideos(labels, {
      projectPath: "/proj/dir/labels.slp",
      exists: async (p) => {
        existsCalls++;
        return p.startsWith("/proj/dir/frames/");
      },
      readFile: async () => new Uint8Array(),
    });

    expect(isVideoMissing(video)).toBe(false);
    expect(video.filename).toEqual(rel.map((f) => `/proj/dir/${f}`));
    expect(existsCalls).toBeLessThan(30);
  });
});

describe("relocateMissingImageFrames (surgical per-frame locate)", () => {
  function resolvedSeq(paths: string[]): Video {
    const v = new Video({ filename: paths, openBackend: false });
    v.backend = { getFrame: async () => null } as never; // resolved (loader-built)
    v.shape = [paths.length, 8, 8, 1];
    return v;
  }

  it("relocates ONLY the known-missing frames, leaving found frames untouched", async () => {
    setImageBytesReader(async () => new Uint8Array([0]));
    const N = 10;
    const paths = Array.from({ length: N }, (_, i) => `/vol/seq/img_${i}.jpg`);
    const video = resolvedSeq(paths);

    // Frames 3 and 7 were found missing at view time; the rest are fine.
    const missingIdx = [3, 7];
    // The picked backup folder holds only those two images.
    const present = new Set(["/backup/seq/img_3.jpg", "/backup/seq/img_7.jpg"]);
    const probed: string[] = [];
    const exists = async (p: string) => {
      probed.push(p);
      return present.has(p);
    };

    const { located, swap } = await relocateMissingImageFrames(
      video,
      missingIdx,
      "/backup/seq",
      exists,
    );

    expect(located.slice().sort((a, b) => a - b)).toEqual([3, 7]);
    // Missing frames repointed into the backup folder...
    expect((video.filename as string[])[3]).toBe("/backup/seq/img_3.jpg");
    expect((video.filename as string[])[7]).toBe("/backup/seq/img_7.jpg");
    // ...found frames left exactly as they were.
    expect((video.filename as string[])[0]).toBe("/vol/seq/img_0.jpg");
    expect((video.filename as string[])[5]).toBe("/vol/seq/img_5.jpg");
    // Derived head-swap returned for optional persistence (common suffix
    // "seq/img_N.jpg" is preserved, so the swap is /vol -> /backup).
    expect(swap).toEqual({ oldPrefix: "/vol", newPrefix: "/backup" });
    // The found frames were NEVER probed — only the two known-missing ones.
    const foundBasenames = [0, 1, 2, 4, 5, 6, 8, 9].map((i) => `img_${i}.jpg`);
    expect(probed.some((p) => foundBasenames.some((b) => p.includes(b)))).toBe(
      false,
    );
    // Backend rebuilt (I/O-free); video still resolved.
    expect(video.backend).not.toBeNull();
    expect(isVideoMissing(video)).toBe(false);
  });

  it("leaves the video unchanged when the picked folder lacks the images", async () => {
    setImageBytesReader(async () => new Uint8Array([0]));
    const paths = ["/vol/seq/a.jpg", "/vol/seq/b.jpg", "/vol/seq/c.jpg"];
    const video = resolvedSeq(paths);
    const before = video.backend;

    const { located, swap } = await relocateMissingImageFrames(
      video,
      [1],
      "/nope",
      async () => false,
    );

    expect(located).toEqual([]);
    expect(swap).toBeNull();
    expect(video.filename).toEqual(paths);
    expect(video.backend).toBe(before); // not rebuilt
  });
});

describe("backendKindForFilename (format → backend dispatch)", () => {
  it("maps MP4 to the Mp4Box backend", () => {
    expect(backendKindForFilename("clip.mp4")).toBe("mp4box");
  });
  it("maps WebM/MKV/MOV/Ogg/MPEG-TS to the MediaBunny backend", () => {
    for (const name of ["a.webm", "a.mkv", "a.mov", "a.ogg", "a.ogv", "a.ts"]) {
      expect(backendKindForFilename(name)).toBe("mediabunny");
    }
  });
  it("maps Norpix .seq to the Seq backend", () => {
    expect(backendKindForFilename("rec.seq")).toBe("seq");
  });
  it("maps AVI/WMV/MPEG to the AVI (web-demuxer) backend", () => {
    for (const name of ["clip.avi", "clip.wmv", "clip.mpeg", "clip.mpg"]) {
      expect(backendKindForFilename(name)).toBe("avi");
    }
  });
  it("is case-insensitive on the extension", () => {
    expect(backendKindForFilename("CLIP.MOV")).toBe("mediabunny");
    expect(backendKindForFilename("CLIP.MP4")).toBe("mp4box");
    expect(backendKindForFilename("CLIP.AVI")).toBe("avi");
  });
  it("returns null for unsupported or extension-less names", () => {
    for (const name of ["clip.mj2", "clip.xyz", "noextension", ""]) {
      expect(backendKindForFilename(name)).toBeNull();
    }
  });
});

describe("getVideoPathCandidates (relative-path resolution, #188)", () => {
  it("walks the .slp's ancestors so a relative path anchored above it resolves", () => {
    // The exact reported layout: .slp three levels down from the root the video
    // path is relative to (tests/data/slp_hdf5/*.slp vs tests/data/json_format_v1/*.mp4,
    // both relative to /home/u/sleap). Windows separator in the stored path.
    const video = new Video({
      filename: "tests/data/json_format_v1\\centered_pair_low_quality.mp4",
      openBackend: false,
    });
    const candidates = getVideoPathCandidates(
      video,
      "/home/u/sleap/tests/data/slp_hdf5/centered_pair.slp"
    );

    // The real location (grafted onto the 3rd ancestor) must be offered...
    expect(candidates).toContain(
      "/home/u/sleap/tests/data/json_format_v1/centered_pair_low_quality.mp4"
    );
    // ...and the old doubled path (graft onto the .slp dir) is still first,
    // preserving prior behavior for videos that DO sit beside the .slp.
    expect(candidates[0]).toBe(
      "/home/u/sleap/tests/data/slp_hdf5/tests/data/json_format_v1/centered_pair_low_quality.mp4"
    );
    // The doubled (wrong) path is offered before the real one (closest-first).
    const wrong = candidates.indexOf(
      "/home/u/sleap/tests/data/slp_hdf5/tests/data/json_format_v1/centered_pair_low_quality.mp4"
    );
    const right = candidates.indexOf(
      "/home/u/sleap/tests/data/json_format_v1/centered_pair_low_quality.mp4"
    );
    expect(wrong).toBeLessThan(right);
  });

  it("resolves a video sitting beside the .slp (depth-0 graft)", () => {
    const video = new Video({ filename: "clip.mp4", openBackend: false });
    const candidates = getVideoPathCandidates(
      video,
      "/data/proj/session.slp"
    );
    expect(candidates).toContain("/data/proj/clip.mp4");
  });

  it("offers an absolute path as-is, then grafts its trailing tails onto the .slp dir", () => {
    const video = new Video({
      filename: "/mnt/store/clip.mp4",
      openBackend: false,
    });
    const candidates = getVideoPathCandidates(video, "/data/proj/session.slp");
    // As-is first (same-machine reopen)...
    expect(candidates[0]).toBe("/mnt/store/clip.mp4");
    // ...then the one-subfolder graft (a video moved with its parent dir under
    // the project), but NOT the full foreign path reproduced under the .slp dir.
    expect(candidates).toContain("/data/proj/store/clip.mp4");
    expect(candidates).not.toContain("/data/proj/mnt/store/clip.mp4");
  });

  it("always includes the basename in the .slp dir as a fallback", () => {
    const video = new Video({
      filename: "some/deep/tree/clip.mp4",
      openBackend: false,
    });
    const candidates = getVideoPathCandidates(video, "/data/proj/session.slp");
    expect(candidates).toContain("/data/proj/clip.mp4");
  });
});

describe("computePrefixSwap (locate-one-relocate-siblings, #188)", () => {
  it("derives the anchoring root when the stored path was fully relative", () => {
    // old stored relative, located at <root>/<same relative> -> oldPrefix empty,
    // newPrefix is the root to prepend onto the other relative siblings.
    const swap = computePrefixSwap(
      "tests/data/json_format_v1\\centered_pair_low_quality.mp4",
      "/home/u/sleap/tests/data/json_format_v1/centered_pair_low_quality.mp4"
    );
    expect(swap).toEqual({
      oldPrefix: "",
      newPrefix: "/home/u/sleap",
    });
  });

  it("derives a head swap when only the leading directories changed", () => {
    const swap = computePrefixSwap(
      "D:\\old\\proj\\videos\\a.mp4",
      "/mnt/new/proj/videos/a.mp4"
    );
    // Common tail: proj/videos/a.mp4 -> heads differ.
    expect(swap).toEqual({ oldPrefix: "D:/old", newPrefix: "/mnt/new" });
  });

  it("returns null when the basenames differ (a rename, not a move)", () => {
    expect(
      computePrefixSwap("/old/dir/a.mp4", "/new/dir/b.mp4")
    ).toBeNull();
  });

  it("returns null for a no-op (paths already agree)", () => {
    expect(
      computePrefixSwap("/same/dir/a.mp4", "/same/dir/a.mp4")
    ).toBeNull();
  });
});

describe("lazy video backends (defer decoder open, #perf)", () => {
  it("lazy resolve locates the file WITHOUT reading it, marks it present, defers the decoder", async () => {
    const video = new Video({ filename: "clip.mp4", openBackend: false });
    video.backend = null;
    const labels = new Labels();
    labels.addVideo(video);

    let readCount = 0;
    await resolveExternalVideos(labels, {
      projectPath: "/proj/labels.slp",
      exists: async () => true, // located on the first candidate
      readFile: async () => {
        readCount++;
        return new Uint8Array();
      },
      lazy: true,
    });

    // Located, but NOT read or decoded (the whole point — O(1), not O(N reads)):
    expect(readCount).toBe(0);
    expect(video.backend).toBeNull();
    expect((video.backendMetadata as Record<string, unknown>).lazyPath).toBe(
      "/proj/clip.mp4"
    );
    // A deferred-but-located video reads as present, so the panel shows it found:
    expect(isVideoMissing(video)).toBe(false);
  });

  it("ensureVideoBackend is a no-op for a video that wasn't lazily deferred", async () => {
    const video = new Video({ filename: "/proj/clip.mp4", openBackend: false });
    video.backend = null; // missing, but no lazyPath → nothing deferred to open
    const ok = await ensureVideoBackend(video);
    expect(ok).toBe(false);
    expect(video.backend).toBeNull();
  });
});

describe("resolveExternalVideos (persisted prefix-swap reapply on open)", () => {
  // .slp lives under /Volumes/talmo/elise; the video's stored compute-node path
  // is under a SIBLING subtree /root/vast/mustafa. Tail-grafting onto the .slp
  // dir + ancestors can never reach /Volumes/talmo/mustafa — only a remembered
  // /root/vast → /Volumes/talmo swap does.
  const storedPath = "/root/vast/mustafa/session/clip.mp4";
  const realPath = "/Volumes/talmo/mustafa/session/clip.mp4";
  const projectPath = "/Volumes/talmo/elise/proj.slp";

  const missingVideo = () => {
    const video = new Video({ filename: storedPath, openBackend: false });
    video.backend = null;
    const labels = new Labels();
    labels.addVideo(video);
    return { video, labels };
  };

  it("reaches a sibling subtree using a remembered swap the tail-graft can't", async () => {
    const { video, labels } = missingVideo();
    useAppStore.setState({
      videoPrefixSwaps: [
        { oldPrefix: "/root/vast", newPrefix: "/Volumes/talmo" },
      ],
    });
    try {
      await resolveExternalVideos(labels, {
        projectPath,
        exists: async (p) => p === realPath, // only the swapped path exists
        readFile: async () => new Uint8Array(),
        lazy: true,
      });
      expect(
        (video.backendMetadata as Record<string, unknown>).lazyPath,
      ).toBe(realPath);
      expect(isVideoMissing(video)).toBe(false);
    } finally {
      useAppStore.setState({ videoPrefixSwaps: [] });
    }
  });

  it("without a remembered swap, the sibling-subtree file is NOT auto-located", async () => {
    const { video, labels } = missingVideo();
    useAppStore.setState({ videoPrefixSwaps: [] });
    await resolveExternalVideos(labels, {
      projectPath,
      exists: async (p) => p === realPath,
      readFile: async () => new Uint8Array(),
      lazy: true,
    });
    expect(
      (video.backendMetadata as Record<string, unknown>).lazyPath,
    ).toBeUndefined();
    expect(isVideoMissing(video)).toBe(true);
  });
});

describe("collectHandlesByBasename (folder video re-match scan)", () => {
  it("finds a top-level file by case-insensitive basename", async () => {
    const target = fileHandle();
    const tree = dirHandle({ "Video.MP4": target, "other.mp4": fileHandle() });
    const found = await collectHandlesByBasename(asDir(tree), new Set(["video.mp4"]));
    expect(found.get("video.mp4")).toBe(target);
    expect(found.size).toBe(1);
  });

  it("recurses into subdirectories", async () => {
    const target = fileHandle();
    const tree = dirHandle({
      sub: dirHandle({ deep: dirHandle({ "clip.mp4": target }) }),
    });
    const found = await collectHandlesByBasename(asDir(tree), new Set(["clip.mp4"]));
    expect(found.get("clip.mp4")).toBe(target);
  });

  it("respects maxDepth (a file too deep is not found)", async () => {
    const target = fileHandle();
    const tree = dirHandle({ a: dirHandle({ b: dirHandle({ "clip.mp4": target }) }) });
    const found = await collectHandlesByBasename(asDir(tree), new Set(["clip.mp4"]), {
      maxDepth: 1,
    });
    expect(found.size).toBe(0);
  });

  it("stops after the entry budget is exhausted", async () => {
    const target = fileHandle();
    // clip.mp4 is the 3rd entry; a budget of 2 never reaches it.
    const tree = dirHandle({ x1: fileHandle(), x2: fileHandle(), "clip.mp4": target });
    const found = await collectHandlesByBasename(asDir(tree), new Set(["clip.mp4"]), {
      maxEntries: 2,
    });
    expect(found.size).toBe(0);
  });

  it("finds every wanted key when present", async () => {
    const a = fileHandle();
    const b = fileHandle();
    const tree = dirHandle({ "a.mp4": a, nested: dirHandle({ "b.mp4": b }) });
    const found = await collectHandlesByBasename(
      asDir(tree),
      new Set(["a.mp4", "b.mp4"]),
    );
    expect(found.get("a.mp4")).toBe(a);
    expect(found.get("b.mp4")).toBe(b);
    expect(found.size).toBe(2);
  });
});

describe("resolveAllVideosFromFolder — image-sequence safety", () => {
  it("ignores image-sequence videos: no folder prompt, no change, returns 0", async () => {
    // A missing ImageVideo (frame-path list). The folder re-match must skip it —
    // image sequences have their own per-row locate flow, and this proves the
    // 'Locate All Missing' folder pick never touches (let alone rewrites) them.
    const imgSeq = new Video({
      filename: ["/imgs/frame000.png", "/imgs/frame001.png"],
      backend: null,
      openBackend: false,
    });
    expect(isVideoMissing(imgSeq)).toBe(true);
    expect(isImageSequenceVideo(imgSeq)).toBe(true);

    // Only image sequences present → early return BEFORE any folder picker,
    // and the video object is left untouched (filename unchanged).
    const before = imgSeq.filename;
    const count = await resolveAllVideosFromFolder([imgSeq]);
    expect(count).toBe(0);
    expect(imgSeq.filename).toBe(before);
    expect(imgSeq.backend).toBeNull();
  });
});

describe("isSupportedVideoUrl", () => {
  it("accepts an http(s) URL ending in a supported video extension", () => {
    expect(isSupportedVideoUrl("https://example.com/clip.mp4")).toBe(true);
    expect(isSupportedVideoUrl("http://example.com/a/b/clip.avi")).toBe(true);
    expect(isSupportedVideoUrl("https://example.com/clip.webm")).toBe(true);
  });

  it("strips query/hash so presigned URLs resolve by extension", () => {
    expect(
      isSupportedVideoUrl(
        "https://bucket.s3.amazonaws.com/clip.mp4?X-Amz-Signature=abc&X-Amz-Expires=900",
      ),
    ).toBe(true);
    expect(isSupportedVideoUrl("https://example.com/clip.mov#t=10")).toBe(true);
  });

  it("rejects unsupported extensions and extension-less URLs", () => {
    expect(isSupportedVideoUrl("https://example.com/notes.txt")).toBe(false);
    expect(isSupportedVideoUrl("https://drive.google.com/file/d/ID")).toBe(
      false,
    );
  });

  it("rejects non-fetchable (non-URL / unsupported scheme) inputs", () => {
    expect(isSupportedVideoUrl("/local/path/clip.mp4")).toBe(false);
    expect(isSupportedVideoUrl("ftp://example.com/clip.mp4")).toBe(false);
    expect(isSupportedVideoUrl("")).toBe(false);
  });
});

describe("drag-and-drop video filtering (dropzone, #138)", () => {
  it("pickedFromFiles keeps supported videos and drops the rest (browser, no absPath)", () => {
    const picked = pickedFromFiles([
      new File([], "a.mp4"),
      new File([], "b.slp"), // project file, not a video
      new File([], "c.avi"),
      new File([], "notes.txt"),
    ]);
    expect(picked.map((p) => p.file.name)).toEqual(["a.mp4", "c.avi"]);
    expect(picked.every((p) => p.absPath === null)).toBe(true);
  });

  it("pickedFromPaths keeps supported videos by path (desktop: absPath set, basename as file name)", () => {
    const picked = pickedFromPaths([
      "/data/clip1.mp4",
      "/data/proj.slp",
      "/vids/legacy.wmv",
    ]);
    expect(picked.map((p) => p.absPath)).toEqual(["/data/clip1.mp4", "/vids/legacy.wmv"]);
    expect(picked.map((p) => p.file.name)).toEqual(["clip1.mp4", "legacy.wmv"]);
  });

  it("returns [] when nothing dropped is a supported video", () => {
    expect(pickedFromFiles([new File([], "x.slp")])).toEqual([]);
    expect(pickedFromPaths(["/a/y.json"])).toEqual([]);
  });
});

describe("resolveScrubProxyOpenPath (scrub proxy on decodable video open)", () => {
  // A network-mounted, big, decodable video: the exact case the real gate accepts.
  const ORIGINAL = "/Volumes/nas/session/clip.avi";
  const NAME = "clip.avi";
  const BIG = 500 * 1024 * 1024;

  // Stat-only fake TranscodeDeps: the helper only calls .stat(); the rest of the
  // deps (ffmpeg/ffprobe) is never reached because ensureProxy itself is faked.
  function statDeps(size: number): ReturnType<ScrubProxyDeps["transcodeDeps"]> {
    return { stat: async () => ({ size, mtimeMs: 0 }) } as unknown as ReturnType<
      ScrubProxyDeps["transcodeDeps"]
    >;
  }

  function makeDeps(overrides: Partial<ScrubProxyDeps>): ScrubProxyDeps {
    return {
      isEnabled: () => true,
      transcodeDeps: () => statDeps(BIG),
      shouldBuild: shouldBuildScrubProxy, // exercise the REAL worthiness gate
      ensureProxy: async () => ({ path: ORIGINAL, isProxy: false }),
      ...overrides,
    };
  }

  afterEach(() => {
    // Never leak a stuck job between tests.
    useTranscodeStore.getState().endJob();
  });

  it("disabled: never builds a proxy and opens the original (no job)", async () => {
    let called = false;
    const deps = makeDeps({
      isEnabled: () => false,
      ensureProxy: async () => {
        called = true;
        return { path: "/should-not-open.mp4", isProxy: true };
      },
    });
    const store = useTranscodeStore.getState();
    const res = await resolveScrubProxyOpenPath(
      ORIGINAL,
      NAME,
      store,
      new AbortController(),
      deps
    );
    expect(called).toBe(false);
    expect(res).toEqual({ path: ORIGINAL, isProxy: false });
    expect(useTranscodeStore.getState().job).toBeNull();
  });

  it("enabled + gate passes: opens the PROXY, built from the ORIGINAL path; job runs then clears", async () => {
    const PROXY = "/cache/proxies/abc-proxy-g15.mp4";
    const seen: { path?: string; hasSignal?: boolean } = {};
    const deps = makeDeps({
      ensureProxy: async (p, _d, opts) => {
        seen.path = p; // ensureProxy is given the ORIGINAL source path
        seen.hasSignal = !!opts?.signal;
        opts?.onStart?.({}); // mirror the real build starting the job UI
        opts?.onProgress?.({ frame: 12, done: false });
        return { path: PROXY, isProxy: true };
      },
    });
    const store = useTranscodeStore.getState();
    const controller = new AbortController();

    let res: Awaited<ReturnType<typeof resolveScrubProxyOpenPath>>;
    try {
      // Mirror the caller's try/finally around the proxy step.
      res = await resolveScrubProxyOpenPath(ORIGINAL, NAME, store, controller, deps);
      // Mid-open (before the caller's finally) the store shows an active job,
      // proving onStart wired startJob into the SAME transcode UI.
      expect(useTranscodeStore.getState().job?.name).toBe(NAME);
    } finally {
      store.endJob(); // caller's finally clears it (build OR fallback)
    }

    // Opens the proxy path...
    expect(res).toEqual({ path: PROXY, isProxy: true });
    // ...but that proxy was built FROM the original source (which the .slp records);
    // the open path is deliberately distinct from the recorded original path.
    expect(seen.path).toBe(ORIGINAL);
    expect(res.path).not.toBe(ORIGINAL);
    expect(seen.hasSignal).toBe(true); // shares the caller's AbortController
    expect(useTranscodeStore.getState().job).toBeNull(); // cleared
  });

  it("proxy falls back (frame-check mismatch, isProxy:false): opens the ORIGINAL; job cleared", async () => {
    let called = false;
    const deps = makeDeps({
      ensureProxy: async (p, _d, opts) => {
        called = true;
        opts?.onStart?.({}); // ensureScrubProxyPath fires onStart even on fallback
        return { path: p, isProxy: false }; // its documented fallback contract
      },
    });
    const store = useTranscodeStore.getState();
    let res: Awaited<ReturnType<typeof resolveScrubProxyOpenPath>>;
    try {
      res = await resolveScrubProxyOpenPath(ORIGINAL, NAME, store, new AbortController(), deps);
    } finally {
      store.endJob();
    }
    expect(called).toBe(true);
    expect(res).toEqual({ path: ORIGINAL, isProxy: false });
    expect(useTranscodeStore.getState().job).toBeNull();
  });

  it("build throws (e.g. canceled/ffmpeg error): swallows and opens the ORIGINAL", async () => {
    const deps = makeDeps({
      ensureProxy: async (_p, _d, opts) => {
        opts?.onStart?.({});
        throw new Error("ffmpeg exploded");
      },
    });
    const store = useTranscodeStore.getState();
    let res: Awaited<ReturnType<typeof resolveScrubProxyOpenPath>>;
    try {
      res = await resolveScrubProxyOpenPath(ORIGINAL, NAME, store, new AbortController(), deps);
    } finally {
      store.endJob();
    }
    expect(res).toEqual({ path: ORIGINAL, isProxy: false });
    expect(useTranscodeStore.getState().job).toBeNull();
  });

  it("gate passes for a decodable mp4 AND mov on a network mount (the target case)", async () => {
    // The proxy exists for decodable mp4/mov on NFS — the gate is extension-
    // agnostic (network + big + decodable), so both reach the build.
    for (const src of ["/Volumes/nas/als2h.mp4", "/Volumes/nas/session/clip.mov"]) {
      let seen: string | undefined;
      const deps = makeDeps({
        ensureProxy: async (p) => {
          seen = p;
          return { path: "/cache/proxies/x-proxy-g15.mp4", isProxy: true };
        },
      });
      const store = useTranscodeStore.getState();
      try {
        const res = await resolveScrubProxyOpenPath(
          src,
          src.split("/").pop()!,
          store,
          new AbortController(),
          deps
        );
        expect(res.isProxy).toBe(true);
        expect(res.path).toBe("/cache/proxies/x-proxy-g15.mp4");
        expect(seen).toBe(src); // proxy built FROM the original mp4/mov source
      } finally {
        store.endJob();
      }
    }
  });
});

describe("openViaProxyOrNull (DRY proxy step for decodable open branches)", () => {
  afterEach(() => {
    useTranscodeStore.getState().endJob();
  });

  function baseDeps(overrides: Partial<ProxyOpenDeps>): ProxyOpenDeps {
    return {
      isTauri: async () => true,
      getStore: () => useTranscodeStore.getState(),
      resolveProxy: async (p) => ({ path: p, isProxy: false }),
      openProxyBackend: async () => ({}) as VideoBackend,
      ...overrides,
    };
  }

  it("desktop + proxy built: opens an Mp4Box backend on the PROXY (decided from the ORIGINAL); job cleared", async () => {
    const sentinel = { getFrame: async () => null } as unknown as VideoBackend;
    let decidedFrom: string | undefined;
    let openedFrom: string | undefined;
    const deps = baseDeps({
      resolveProxy: async (p) => {
        decidedFrom = p;
        return { path: "/cache/proxies/als2h-proxy-g15.mp4", isProxy: true };
      },
      openProxyBackend: async (proxyPath) => {
        openedFrom = proxyPath;
        return sentinel;
      },
    });
    const backend = await openViaProxyOrNull(
      "/Volumes/nas/als2h.mp4",
      "als2h.mp4",
      deps
    );
    expect(backend).toBe(sentinel); // opened via the proxy backend
    expect(decidedFrom).toBe("/Volumes/nas/als2h.mp4"); // decision uses ORIGINAL
    expect(openedFrom).toBe("/cache/proxies/als2h-proxy-g15.mp4"); // opens PROXY
    expect(useTranscodeStore.getState().job).toBeNull(); // cleared
  });

  it("desktop + proxy fell back (isProxy:false): returns null so the caller opens the source; never builds a backend", async () => {
    let opened = false;
    const deps = baseDeps({
      resolveProxy: async (p) => ({ path: p, isProxy: false }),
      openProxyBackend: async () => {
        opened = true;
        return {} as VideoBackend;
      },
    });
    const backend = await openViaProxyOrNull(
      "/Volumes/nas/session/clip.mov",
      "clip.mov",
      deps
    );
    expect(backend).toBeNull();
    expect(opened).toBe(false);
    expect(useTranscodeStore.getState().job).toBeNull();
  });

  it("browser (not Tauri): returns null without attempting a proxy", async () => {
    let attempted = false;
    const deps = baseDeps({
      isTauri: async () => false,
      resolveProxy: async (p) => {
        attempted = true;
        return { path: p, isProxy: true };
      },
    });
    expect(
      await openViaProxyOrNull("/Volumes/nas/als2h.mp4", "als2h.mp4", deps)
    ).toBeNull();
    expect(attempted).toBe(false);
    expect(useTranscodeStore.getState().job).toBeNull();
  });

  it("proxy backend construction throws: swallows and returns null (open source normally); job cleared", async () => {
    const deps = baseDeps({
      resolveProxy: async () => ({
        path: "/cache/proxies/x-proxy-g15.mp4",
        isProxy: true,
      }),
      openProxyBackend: async () => {
        throw new Error("mp4box boom");
      },
    });
    expect(
      await openViaProxyOrNull("/Volumes/nas/als2h.mp4", "als2h.mp4", deps)
    ).toBeNull();
    expect(useTranscodeStore.getState().job).toBeNull();
  });
});
