/**
 * Tests for the standalone-video format dispatch added in PR-A of issue #138.
 *
 * Only the decoder-independent dispatch is unit-tested here: unsupported
 * formats must be rejected (return null) WITHOUT attempting a decode. The MP4
 * happy path needs a real Mp4Box decode of a real file, so it's covered by the
 * live E2E rather than a synthetic unit test.
 */

import { describe, it, expect } from "../bun-test";
import { Labels, Video } from "@talmolab/sleap-io.js";
import {
  buildStandaloneVideo,
  addVideoFileToLabels,
  backendKindForFilename,
  resolveImageFramesInFolder,
  resolveExternalVideos,
  isVideoMissing,
  classifyVideoError,
  videoIssue,
  getVideoPathCandidates,
  computePrefixSwap,
  SUPPORTED_VIDEO_EXTS,
} from "@/lib/resolveVideos";

function fakeFile(name: string): File {
  return new File([new Uint8Array([0])], name, { type: "video/mp4" });
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
      file: fakeFile("clip.avi"), // .avi has no backend → gate-rejected
      absPath: null,
    });
    expect(result).toBeNull();
    expect(labels.videos.length).toBe(0);
  });
});

describe("SUPPORTED_VIDEO_EXTS", () => {
  it("lists every decodable format and excludes .avi", () => {
    expect([...SUPPORTED_VIDEO_EXTS].sort()).toEqual([
      "mkv", "mov", "mp4", "ogg", "ogv", "seq", "ts", "webm",
    ]);
    expect(SUPPORTED_VIDEO_EXTS).not.toContain("avi");
  });
});

describe("buildStandaloneVideo (gate)", () => {
  // Only UNSUPPORTED extensions here: a supported ext would attempt a real
  // MediaBunny/Mp4Box decode, which can't run under the bun test runner.
  it("rejects unsupported formats and returns null without decoding", async () => {
    for (const name of ["clip.avi", "clip.xyz", "noextension"]) {
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

describe("resolveExternalVideos (image sequences delegated to the SLP reader)", () => {
  // Image sequences (ImageVideo) are now resolved and opened by the SLP reader
  // itself via the injected FsResolver (issue #213 / sleap-io.js#216): a resolvable
  // one arrives with a working backend, a missing one with backend === null +
  // backendError.kind === "image-sequence". resolveExternalVideos must NOT try to
  // re-resolve or rebuild them — and, above all, must never route a frame LIST into
  // the single-file (mp4box) path, which hangs on a JPEG.
  function missingImageSeq(paths: string[]): Video {
    const v = new Video({ filename: paths, openBackend: false });
    v.backend = null;
    v.backendError = { kind: "image-sequence", message: "not found" };
    v.shape = [paths.length, 8, 8, 1];
    return v;
  }

  it("leaves a missing image sequence flagged missing (never builds a blank backend)", async () => {
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

  it("never routes a frame list into the single-file path, even if every path 'exists'", async () => {
    // The failure this guards: feeding a JPEG list to mp4box (which hangs). Even a
    // filesystem that claims every candidate exists and returns bytes must not
    // cause an image sequence to be opened as a single-file video — it is skipped.
    const video = missingImageSeq(["/gone/a.jpg", "/gone/b.jpg"]);
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

    expect(readFileCalled).toBe(false); // the frame list was skipped, not read
    expect(video.backend).toBeNull();
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
  it("is case-insensitive on the extension", () => {
    expect(backendKindForFilename("CLIP.MOV")).toBe("mediabunny");
    expect(backendKindForFilename("CLIP.MP4")).toBe("mp4box");
  });
  it("returns null for unsupported or extension-less names", () => {
    for (const name of ["clip.avi", "clip.xyz", "noextension", ""]) {
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
