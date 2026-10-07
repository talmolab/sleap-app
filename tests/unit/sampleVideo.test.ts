/**
 * Unit tests for the "Use sample video" fetch/cache helpers. The URL constant,
 * the progress-reporting fetch, and the browser/desktop `loadSampleVideo`
 * branching are all pure/injectable (no real network, no real Tauri fs), so
 * they're fully covered here via an injected `fetchImpl` / {@link SampleCacheFs}.
 * The real `tauriSampleCacheFs()` leaves (dynamic `@tauri-apps/plugin-fs` /
 * `@tauri-apps/api/path` imports) are Tauri-runtime only and are
 * manual/tauri-pilot-verified, matching the house style for `tauriDraft.ts` /
 * `sessionLog.ts`.
 */
import { describe, it, expect } from "bun:test";
import {
  SAMPLE_VIDEO,
  fetchSampleVideoBytes,
  loadSampleVideo,
  type SampleCacheFs,
} from "@/lib/sampleVideo";

function streamResponse(chunks: Uint8Array[], total?: number): Response {
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      chunks.forEach((x) => c.enqueue(x));
      c.close();
    },
  });
  const headers: Record<string, string> =
    total === undefined ? {} : { "content-length": String(total) };
  return new Response(body, { status: 200, headers });
}

describe("SAMPLE_VIDEO", () => {
  it("is a commit-pinned, CORS-fetchable raw GitHub URL", () => {
    expect(SAMPLE_VIDEO.url).toMatch(
      /^https:\/\/raw\.githubusercontent\.com\/talmolab\/sleap-tutorial-data\/[0-9a-f]{40}\/mice\.mp4$/,
    );
    expect(SAMPLE_VIDEO.name).toBe("mice.mp4");
  });
});

describe("fetchSampleVideoBytes", () => {
  it("concatenates chunks and reports progress", async () => {
    const seen: number[] = [];
    const fetchImpl = async () =>
      streamResponse([new Uint8Array([1, 2]), new Uint8Array([3])], 3);
    const bytes = await fetchSampleVideoBytes({ fetchImpl, onProgress: (f) => seen.push(f) });
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(seen.at(-1)).toBe(1);
  });

  it("throws on a non-OK response", async () => {
    const fetchImpl = async () => new Response("nope", { status: 404 });
    await expect(fetchSampleVideoBytes({ fetchImpl })).rejects.toThrow(/404/);
  });

  it("throws when the body is shorter than content-length (truncated)", async () => {
    const fetchImpl = async () => streamResponse([new Uint8Array([1])], 5);
    await expect(fetchSampleVideoBytes({ fetchImpl })).rejects.toThrow(/incomplete/i);
  });
});

describe("loadSampleVideo", () => {
  it("browser: returns an in-memory File with absPath null", async () => {
    const fetchImpl = async () => streamResponse([new Uint8Array([1, 2, 3])], 3);
    const picked = await loadSampleVideo({ isTauri: false, fetchImpl });
    expect(picked.absPath).toBeNull();
    expect(picked.file.name).toBe("mice.mp4");
    expect(picked.file.size).toBe(3);
  });

  it("desktop cache hit: skips the fetch, reports progress 1, returns the cache path", async () => {
    let fetchCalled = false;
    const fetchImpl = async () => {
      fetchCalled = true;
      return streamResponse([new Uint8Array([1, 2, 3])], 3);
    };
    const seen: number[] = [];
    const fs: SampleCacheFs = {
      cachePath: async () => "/app-data/samples/mice.mp4",
      size: async () => SAMPLE_VIDEO.bytes,
      write: async () => {
        throw new Error("write should not be called on a cache hit");
      },
    };
    const picked = await loadSampleVideo({
      isTauri: true,
      fs,
      fetchImpl,
      onProgress: (f) => seen.push(f),
    });
    expect(fetchCalled).toBe(false);
    expect(picked.absPath).toBe("/app-data/samples/mice.mp4");
    expect(picked.file.name).toBe("mice.mp4");
    expect(seen.at(-1)).toBe(1);
  });

  it("desktop cache miss: fetches once and writes the bytes to the cache path", async () => {
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls += 1;
      return streamResponse([new Uint8Array([1, 2, 3])], 3);
    };
    let written: { path: string; bytes: Uint8Array } | null = null;
    const fs: SampleCacheFs = {
      cachePath: async () => "/app-data/samples/mice.mp4",
      size: async () => null,
      write: async (path, bytes) => {
        written = { path, bytes };
      },
    };
    const picked = await loadSampleVideo({ isTauri: true, fs, fetchImpl });
    expect(fetchCalls).toBe(1);
    expect(written).not.toBeNull();
    expect(written!.path).toBe("/app-data/samples/mice.mp4");
    expect([...written!.bytes]).toEqual([1, 2, 3]);
    expect(picked.absPath).toBe("/app-data/samples/mice.mp4");
  });

  it("desktop wrong-size cached file: re-downloads rather than trusting the cache", async () => {
    let fetchCalls = 0;
    const fetchImpl = async () => {
      fetchCalls += 1;
      return streamResponse([new Uint8Array([1, 2, 3])], 3);
    };
    let writeCalls = 0;
    const fs: SampleCacheFs = {
      cachePath: async () => "/app-data/samples/mice.mp4",
      size: async () => 123, // present, but not the expected size -> stale/truncated
      write: async () => {
        writeCalls += 1;
      },
    };
    const picked = await loadSampleVideo({ isTauri: true, fs, fetchImpl });
    expect(fetchCalls).toBe(1);
    expect(writeCalls).toBe(1);
    expect(picked.absPath).toBe("/app-data/samples/mice.mp4");
  });
});
