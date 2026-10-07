/**
 * Unit tests for the "Use sample video" fetch/cache helpers. The URL constant
 * and the progress-reporting fetch are pure (no real network), so they're
 * fully covered here with an injected `fetchImpl`.
 */
import { describe, it, expect } from "bun:test";
import { SAMPLE_VIDEO, fetchSampleVideoBytes } from "@/lib/sampleVideo";

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
