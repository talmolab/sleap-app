import { describe, it, expect, vi, beforeEach } from "../bun-test";
import { WorkerProtocolError, FS_NOT_FOUND } from "@/lib/protocolV1/errors";
import type { WorkerClient } from "@/lib/protocolV1/client";

// `readSlpStreaming` runs its H5 parser in a real Worker over a
// SharedArrayBuffer + `Atomics` bridge (sleap-io.js's "B-seam") — it can't
// run for real under bun's test runner, so every other test in this repo
// that reaches it mocks it too (see tests/unit/loadProgressStreaming.test.ts).
// `loadWorkerLabels`'s own logic (fsStat → RangeSource → readSlpStreaming,
// plus the lastError rethrow) is what's under test here; the RangeSource
// returned by `createWorkerFileRangeSource` is exercised directly below
// against real byte ranges and a real fake `fs.read`, independent of the
// mock.
const readSlpStreamingMock = vi.fn(async (_source: unknown, _options: unknown) => {
  return { skeletons: [], videos: [], labeledFrames: [] };
});
vi.mock("@talmolab/sleap-io.js", () => ({
  readSlpStreaming: readSlpStreamingMock,
}));

const { createWorkerFileRangeSource, loadWorkerLabels, checkWorkerFileVideos } = await import(
  "@/lib/workerLabels"
);

const FILE_BYTES = new Uint8Array(10_000);
for (let i = 0; i < FILE_BYTES.length; i++) FILE_BYTES[i] = i % 256;

/** A fake `WorkerClient` serving `fs.read`/`fs.stat` out of an in-memory buffer. */
function makeFakeClient(bytes: Uint8Array, opts: { fsReadShouldThrow?: Error } = {}) {
  const fsReadCalls: Array<[number, number]> = [];
  const client = {
    fsStat: async (_path: string) => ({
      path: _path,
      type: "file" as const,
      size: bytes.length,
      modified: 0,
    }),
    fsRead: async (_path: string, offset = 0, length?: number) => {
      fsReadCalls.push([offset, length ?? bytes.length - offset]);
      if (opts.fsReadShouldThrow) throw opts.fsReadShouldThrow;
      const end = length === undefined ? bytes.length : Math.min(offset + length, bytes.length);
      const content = bytes.subarray(offset, end);
      return {
        path: _path,
        content,
        offset,
        size: content.length,
        totalSize: bytes.length,
        eof: end >= bytes.length,
      };
    },
  } as unknown as WorkerClient;
  return { client, fsReadCalls };
}

describe("createWorkerFileRangeSource", () => {
  it("reads exactly the requested range", async () => {
    const { client } = makeFakeClient(FILE_BYTES);
    const source = createWorkerFileRangeSource(client, "/data/x.slp", FILE_BYTES.length);

    const bytes = await source.readRange(100, 50);

    expect(bytes).toEqual(FILE_BYTES.subarray(100, 150));
  });

  it("caches pages: two reads inside the same page issue only one fs.read", async () => {
    const { client, fsReadCalls } = makeFakeClient(FILE_BYTES);
    const source = createWorkerFileRangeSource(client, "/data/x.slp", FILE_BYTES.length, {
      pageSize: 1000,
    });

    await source.readRange(10, 20);
    await source.readRange(30, 20); // same 1000-byte page as above

    expect(fsReadCalls.length).toBe(1);
  });

  it("evicts the least-recently-used page once past maxPages", async () => {
    const { client, fsReadCalls } = makeFakeClient(FILE_BYTES);
    const source = createWorkerFileRangeSource(client, "/data/x.slp", FILE_BYTES.length, {
      pageSize: 1000,
      maxPages: 2,
    });

    await source.readRange(0, 1); // page 0
    await source.readRange(1000, 1); // page 1
    await source.readRange(2000, 1); // page 2 — evicts page 0 (LRU)
    expect(fsReadCalls.length).toBe(3);

    await source.readRange(0, 1); // page 0 again — must re-fetch
    expect(fsReadCalls.length).toBe(4);
  });

  it("splits a page fetch larger than the worker's 4 MiB fs.read cap into several calls", async () => {
    const bigFile = new Uint8Array(6 * 1024 * 1024);
    const { client, fsReadCalls } = makeFakeClient(bigFile);
    const source = createWorkerFileRangeSource(client, "/data/big.slp", bigFile.length, {
      pageSize: 5 * 1024 * 1024, // exceeds the 4 MiB per-call cap
    });

    const bytes = await source.readRange(0, 10);

    expect(bytes.length).toBe(10);
    expect(fsReadCalls.length).toBeGreaterThan(1);
    for (const [, length] of fsReadCalls) {
      expect(length).toBeLessThanOrEqual(4 * 1024 * 1024);
    }
  });

  it("records the fs.read failure as lastError() without changing the thrown error", async () => {
    const boom = new WorkerProtocolError(FS_NOT_FOUND, "fs.read('/data/x.slp'): not found");
    const { client } = makeFakeClient(FILE_BYTES, { fsReadShouldThrow: boom });
    const source = createWorkerFileRangeSource(client, "/data/x.slp", FILE_BYTES.length);

    await expect(source.readRange(0, 10)).rejects.toBe(boom);
    expect(source.lastError()).toBe(boom);
  });
});

describe("loadWorkerLabels", () => {
  beforeEach(() => {
    readSlpStreamingMock.mockClear();
  });

  it("stats the file then streams it with openVideos: false and a filenameHint", async () => {
    const { client } = makeFakeClient(FILE_BYTES);

    await loadWorkerLabels(client, "/data/x.slp");

    expect(readSlpStreamingMock).toHaveBeenCalledTimes(1);
    const [source, options] = readSlpStreamingMock.mock.calls[0]!;
    expect((source as { size: number }).size).toBe(FILE_BYTES.length);
    expect(options).toMatchObject({ openVideos: false, filenameHint: "/data/x.slp" });
  });

  it("rethrows the RangeSource's lastError when readSlpStreaming fails after a readRange error", async () => {
    const boom = new WorkerProtocolError(FS_NOT_FOUND, "fs.read('/data/x.slp'): not found");
    const { client } = makeFakeClient(FILE_BYTES, { fsReadShouldThrow: boom });
    readSlpStreamingMock.mockImplementationOnce(async (source: { readRange: (o: number, l: number) => Promise<Uint8Array> }) => {
      // Simulate the B-seam bridge: it calls readRange, the call throws, and
      // that failure never propagates out of readSlpStreaming as a
      // rejection with the real cause — it surfaces only as a generic parse
      // failure once the (now-empty) bytes fail to parse.
      await source.readRange(0, 10).catch(() => {});
      throw new Error("Failed to parse HDF5 file");
    });

    await expect(loadWorkerLabels(client, "/data/x.slp")).rejects.toBe(boom);
  });

  it("falls back to readSlpStreaming's own error when no readRange failure was recorded", async () => {
    const { client } = makeFakeClient(FILE_BYTES);
    const genericError = new Error("Failed to parse HDF5 file");
    readSlpStreamingMock.mockRejectedValueOnce(genericError);

    await expect(loadWorkerLabels(client, "/data/x.slp")).rejects.toBe(genericError);
  });
});

/** A minimal stand-in for a sleap-io.js `Video` — `checkWorkerFileVideos` only ever reads these two members. */
function fakeVideo(filename: string | string[], hasEmbeddedImages: boolean) {
  return { filename, hasEmbeddedImages };
}

describe("checkWorkerFileVideos", () => {
  it("counts an embedded video as found without statting it", async () => {
    const client = {
      fsStat: vi.fn(async () => {
        throw new Error("should never be called for an embedded video");
      }),
    } as unknown as WorkerClient;
    const labels = { videos: [fakeVideo("video0.mp4", true)] } as unknown as Parameters<
      typeof checkWorkerFileVideos
    >[1];

    const result = await checkWorkerFileVideos(client, labels);

    expect(result).toEqual([{ index: 0, path: "video0.mp4", embedded: true, found: true }]);
    expect(client.fsStat).not.toHaveBeenCalled();
  });

  it("stats every non-embedded video in parallel and reports found/not-found", async () => {
    const statCalls: string[] = [];
    const client = {
      fsStat: vi.fn(async (path: string) => {
        statCalls.push(path);
        if (path === "/mnt/data/missing.mp4") {
          throw new WorkerProtocolError(FS_NOT_FOUND, `fs.stat('${path}'): not found`);
        }
        return { path, type: "file" as const, size: 123, modified: 0 };
      }),
    } as unknown as WorkerClient;
    const labels = {
      videos: [
        fakeVideo("/mnt/data/a.mp4", false),
        fakeVideo("/mnt/data/missing.mp4", false),
        fakeVideo("embedded.mp4", true),
      ],
    } as unknown as Parameters<typeof checkWorkerFileVideos>[1];

    const result = await checkWorkerFileVideos(client, labels);

    expect(result).toEqual([
      { index: 0, path: "/mnt/data/a.mp4", embedded: false, found: true },
      { index: 1, path: "/mnt/data/missing.mp4", embedded: false, found: false },
      { index: 2, path: "embedded.mp4", embedded: true, found: true },
    ]);
    expect(statCalls.sort()).toEqual(["/mnt/data/a.mp4", "/mnt/data/missing.mp4"]);
  });

  it("uses the first filename for a multi-file ImageVideo", async () => {
    const client = {
      fsStat: vi.fn(async (path: string) => ({ path, type: "file" as const, size: 1, modified: 0 })),
    } as unknown as WorkerClient;
    const labels = {
      videos: [fakeVideo(["/mnt/seq/img0.png", "/mnt/seq/img1.png"], false)],
    } as unknown as Parameters<typeof checkWorkerFileVideos>[1];

    const result = await checkWorkerFileVideos(client, labels);

    expect(result).toEqual([{ index: 0, path: "/mnt/seq/img0.png", embedded: false, found: true }]);
  });

  it("propagates a non-not-found fs.stat error instead of treating it as missing", async () => {
    const client = {
      fsStat: vi.fn(async () => {
        throw new Error("fs.stat('x'): forbidden");
      }),
    } as unknown as WorkerClient;
    const labels = { videos: [fakeVideo("/mnt/data/a.mp4", false)] } as unknown as Parameters<
      typeof checkWorkerFileVideos
    >[1];

    await expect(checkWorkerFileVideos(client, labels)).rejects.toThrow("forbidden");
  });
});
