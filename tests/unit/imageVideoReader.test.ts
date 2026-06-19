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

describe("createImageReader (resolve-once)", () => {
  beforeEach(() => setImageProjectDir(null));

  it("resolves the path strategy once, then reads later frames without per-frame exists()", async () => {
    setImageProjectDir("/proj");
    const existsCalls: string[] = [];
    const readCalls: string[] = [];
    const exists = async (p: string) => {
      existsCalls.push(p);
      return true; // absolute path present as-is
    };
    const readFile = async (p: string) => {
      readCalls.push(p);
      return new Uint8Array([1]);
    };
    const reader = createImageReader(readFile, exists);
    await reader("/imgs/a.jpg");
    await reader("/imgs/b.jpg");
    await reader("/imgs/c.jpg");
    expect(existsCalls.length).toBe(1); // only the first frame stats
    expect(readCalls).toEqual(["/imgs/a.jpg", "/imgs/b.jpg", "/imgs/c.jpg"]);
  });

  it("caches the basename-in-project-dir strategy (moved project) and reuses it without re-stat", async () => {
    setImageProjectDir("/proj");
    const existsCalls: string[] = [];
    const reads: string[] = [];
    const exists = async (p: string) => {
      existsCalls.push(p);
      return p.startsWith("/proj/");
    };
    const readFile = async (p: string) => {
      reads.push(p);
      return new Uint8Array([1]);
    };
    const reader = createImageReader(readFile, exists);
    await reader("/old/a.jpg"); // abs missing -> basename /proj/a.jpg (2 stats)
    await reader("/old/b.jpg"); // direct -> /proj/b.jpg (0 stats)
    expect(reads).toEqual(["/proj/a.jpg", "/proj/b.jpg"]);
    expect(existsCalls.length).toBe(2);
  });

  it("re-resolves when the cached strategy's read fails", async () => {
    setImageProjectDir("/proj");
    const present = new Set(["/v/a.jpg", "/v/b.jpg", "/proj/c.jpg"]);
    const reads: string[] = [];
    const exists = async (p: string) => present.has(p);
    const readFile = async (p: string) => {
      reads.push(p);
      if (!present.has(p)) throw new Error("missing");
      return new Uint8Array([7]);
    };
    const reader = createImageReader(readFile, exists);
    await reader("/v/a.jpg"); // resolves index 0 (as-is)
    await reader("/v/b.jpg"); // fast path: /v/b.jpg present
    const bytes = await reader("/x/c.jpg"); // fast path fails -> re-resolve -> /proj/c.jpg
    expect(Array.from(bytes)).toEqual([7]);
    expect(reads).toContain("/proj/c.jpg");
  });
});
