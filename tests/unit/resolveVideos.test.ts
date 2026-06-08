/**
 * Tests for the standalone-video format dispatch added in PR-A of issue #138.
 *
 * Only the decoder-independent dispatch is unit-tested here: unsupported
 * formats must be rejected (return null) WITHOUT attempting a decode. The MP4
 * happy path needs a real Mp4Box decode of a real file, so it's covered by the
 * live E2E rather than a synthetic unit test.
 */

import { describe, it, expect } from "../bun-test";
import { Labels } from "@talmolab/sleap-io.js";
import {
  buildStandaloneVideo,
  addVideoFileToLabels,
  backendKindForFilename,
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
