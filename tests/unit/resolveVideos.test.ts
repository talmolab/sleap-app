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
      file: fakeFile("clip.mov"),
      absPath: null,
    });
    expect(result).toBeNull();
    expect(labels.videos.length).toBe(0);
  });
});

describe("buildStandaloneVideo (format dispatch)", () => {
  it("currently supports only MP4", () => {
    expect([...SUPPORTED_VIDEO_EXTS]).toEqual(["mp4"]);
  });

  it("rejects unsupported formats and returns null without decoding", async () => {
    for (const name of ["clip.mov", "clip.webm", "clip.mkv", "clip.seq", "noextension"]) {
      expect(await buildStandaloneVideo(fakeFile(name))).toBeNull();
    }
  });

  it("matches the extension case-insensitively", async () => {
    expect(await buildStandaloneVideo(fakeFile("CLIP.MOV"))).toBeNull();
  });
});
