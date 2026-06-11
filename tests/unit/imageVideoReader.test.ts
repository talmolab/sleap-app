/**
 * Tests for the desktop (Tauri) ImageVideo byte-reader (src/lib/imageVideoReader.ts).
 *
 * sleap-io.js's ImageVideoBackend pulls each frame's bytes through an injected
 * reader. On desktop we inject one backed by Tauri's plugin-fs, resolving the
 * stored image path against the current project directory (absolute as-is;
 * relative against the project dir; basename in the project dir for moved
 * projects) — mirroring the existing external-MP4 resolution.
 */
import { describe, it, expect, beforeEach } from "../bun-test";
import {
  imagePathCandidates,
  setImageProjectDir,
  createImageReader,
} from "@/lib/imageVideoReader";

describe("imagePathCandidates", () => {
  it("returns an absolute path as-is when no project dir is known", () => {
    expect(imagePathCandidates("/abs/imgs/a.png", null)).toEqual([
      "/abs/imgs/a.png",
    ]);
  });

  it("resolves a relative path against the project dir, then basename", () => {
    expect(imagePathCandidates("imgs/a.png", "/proj")).toEqual([
      "/proj/imgs/a.png",
      "/proj/a.png",
    ]);
  });

  it("adds a basename-in-project-dir fallback for an absolute (moved) path", () => {
    expect(imagePathCandidates("/old/imgs/a.png", "/proj")).toEqual([
      "/old/imgs/a.png",
      "/proj/a.png",
    ]);
  });

  it("returns the raw path when relative and no project dir is known", () => {
    expect(imagePathCandidates("imgs/a.png", null)).toEqual(["imgs/a.png"]);
  });
});

describe("createImageReader", () => {
  beforeEach(() => setImageProjectDir(null));

  it("reads a relative path resolved against the project dir", async () => {
    setImageProjectDir("/proj");
    const files: Record<string, Uint8Array> = {
      "/proj/imgs/a.png": new Uint8Array([1, 2, 3]),
    };
    const exists = async (p: string) => p in files;
    const readFile = async (p: string) => files[p];
    const reader = createImageReader(readFile, exists);
    expect(Array.from(await reader("imgs/a.png"))).toEqual([1, 2, 3]);
  });

  it("falls back to the basename in the project dir (moved project)", async () => {
    setImageProjectDir("/proj");
    const files: Record<string, Uint8Array> = {
      "/proj/a.png": new Uint8Array([9]),
    };
    const exists = async (p: string) => p in files;
    const readFile = async (p: string) => files[p];
    const reader = createImageReader(readFile, exists);
    expect(Array.from(await reader("/old/loc/a.png"))).toEqual([9]);
  });

  it("throws when no candidate exists (drives the load guard)", async () => {
    setImageProjectDir("/proj");
    const reader = createImageReader(
      async () => new Uint8Array(),
      async () => false
    );
    await expect(reader("imgs/missing.png")).rejects.toThrow();
  });
});
