/**
 * Tests for the standalone-video format dispatch added in PR-A of issue #138.
 *
 * Only the decoder-independent dispatch is unit-tested here: unsupported
 * formats must be rejected (return null) WITHOUT attempting a decode. The MP4
 * happy path needs a real Mp4Box decode of a real file, so it's covered by the
 * live E2E rather than a synthetic unit test.
 */

import { describe, it, expect } from "../bun-test";
import { Labels, Video, setImageBytesReader } from "@talmolab/sleap-io.js";
import {
  buildStandaloneVideo,
  addVideoFileToLabels,
  backendKindForFilename,
  resolveImageFramesInFolder,
  resolveExternalVideos,
  isVideoMissing,
  SUPPORTED_VIDEO_EXTS,
} from "@/lib/resolveVideos";

function fakeFile(name: string): File {
  return new File([new Uint8Array([0])], name, { type: "video/mp4" });
}

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
});

describe("resolveExternalVideos (image-sequence existence check)", () => {
  // A known shape lets ImageVideoBackend.create() skip its frame-0 decode, so a
  // backend builds WITHOUT touching disk. That means an image sequence whose
  // files are all missing would still get a non-null (blank) backend and never
  // surface the "Locate image folder…" affordance. The loader must verify the
  // first image actually resolves on disk before accepting the backend.
  function imageSeqVideo(paths: string[]): Video {
    const v = new Video({ filename: paths, openBackend: false });
    v.backend = null;
    v.shape = [paths.length, 8, 8, 1];
    return v;
  }

  it("leaves a missing image-sequence unresolved (flagged missing), not a blank backend", async () => {
    // Stub the reader so create() can't fail for lack of one — it must never be
    // reached: with the images missing we bail BEFORE building the backend.
    setImageBytesReader(async () => new Uint8Array());
    try {
      const video = imageSeqVideo(["/gone/a.jpg", "/gone/b.jpg", "/gone/c.jpg"]);
      const labels = new Labels();
      labels.addVideo(video);

      await resolveExternalVideos(labels, {
        projectPath: "/proj/labels.slp",
        exists: async () => false, // nothing exists on disk
        readFile: async () => new Uint8Array(),
      });

      expect(video.backend).toBeNull();
      expect(isVideoMissing(video)).toBe(true);
    } finally {
      setImageBytesReader(null);
    }
  });

  it("resolves an image-sequence when its first image exists on disk", async () => {
    setImageBytesReader(async () => new Uint8Array());
    try {
      const video = imageSeqVideo(["/imgs/a.jpg", "/imgs/b.jpg", "/imgs/c.jpg"]);
      const labels = new Labels();
      labels.addVideo(video);

      await resolveExternalVideos(labels, {
        projectPath: "/proj/labels.slp",
        exists: async () => true, // images present
        readFile: async () => new Uint8Array(),
      });

      expect(video.backend).not.toBeNull();
      expect(isVideoMissing(video)).toBe(false);
    } finally {
      setImageBytesReader(null);
    }
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
