import { describe, it, expect, vi, beforeEach } from "../bun-test";
import { WorkerProtocolError, FS_NOT_FOUND, FS_FORBIDDEN, PROTO_UNKNOWN_METHOD } from "@/lib/protocolV1/errors";
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
// Embedded (pkg.slp) previews: a fake reader + backend, recording what was asked.
const embeddedCalls = { opened: 0, closed: 0, dataset: "", frames: [] as number[] };
class FakeStreamingHdf5VideoBackend {
  frameNumbers = [5, 9];
  shape = [10, 4, 6, 1];
  constructor(opts: { datasetPath: string }) {
    embeddedCalls.dataset = opts.datasetPath;
  }
  async ensureLoaded() {}
  async getFrame(frame: number) {
    embeddedCalls.frames.push(frame);
    return { decoded: frame };
  }
}
vi.mock("@talmolab/sleap-io.js", () => ({
  readSlpStreaming: readSlpStreamingMock,
  openH5Worker: async () => {
    embeddedCalls.opened++;
    return {
      close: async () => {
        embeddedCalls.closed++;
      },
    };
  },
  StreamingHdf5VideoBackend: FakeStreamingHdf5VideoBackend,
}));
vi.mock("@/lib/frameBitmap", () => ({
  frameToBitmap: async (frame: { decoded: number }) => ({ width: 6, height: 4, decoded: frame.decoded }),
}));

const {
  createWorkerFileRangeSource,
  loadWorkerLabels,
  checkWorkerFileVideos,
  needsLabelsRepoint,
  videoChecksToVisibility,
  workerFramePath,
  fetchWorkerPreviewFrame,
} = await import("@/lib/workerLabels");

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

    // Non-adjacent pages, so no read-ahead muddies the count.
    await source.readRange(0, 1); // page 0
    await source.readRange(2000, 1); // page 2
    await source.readRange(4000, 1); // page 4 — evicts page 0 (LRU)
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

  it("fetches a large read in worker-sized pieces, several at once, skipping the page cache", async () => {
    const bigFile = new Uint8Array(20 * 1024 * 1024);
    for (let i = 0; i < bigFile.length; i += 4096) bigFile[i] = (i / 4096) % 256;
    let inFlight = 0;
    let maxInFlight = 0;
    const calls: Array<[number, number]> = [];
    const client = {
      fsRead: async (_path: string, offset = 0, length = 0) => {
        calls.push([offset, length]);
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 1));
        inFlight--;
        const content = bigFile.subarray(offset, Math.min(offset + length, bigFile.length));
        return { path: _path, content, offset, size: content.length, totalSize: bigFile.length, eof: false };
      },
    } as unknown as WorkerClient;
    const source = createWorkerFileRangeSource(client, "/data/big.slp", bigFile.length);

    const bytes = await source.readRange(1000, 18 * 1024 * 1024);

    expect(bytes).toEqual(bigFile.subarray(1000, 1000 + 18 * 1024 * 1024));
    expect(calls.length).toBe(5); // 18 MiB in ≤4 MiB pieces
    expect(calls.every(([, length]) => length <= 4 * 1024 * 1024)).toBe(true);
    expect(maxInFlight).toBeGreaterThan(1);
  });

  it("keeps small reads paged at 1 MiB", async () => {
    const bigFile = new Uint8Array(8 * 1024 * 1024);
    const { client, fsReadCalls } = makeFakeClient(bigFile);
    const source = createWorkerFileRangeSource(client, "/data/big.slp", bigFile.length);

    await source.readRange(3 * 1024 * 1024 + 10, 100);

    expect(fsReadCalls).toEqual([[3 * 1024 * 1024, 1024 * 1024]]);
  });

  it("reads ahead while reading forward page by page", async () => {
    const { client, fsReadCalls } = makeFakeClient(FILE_BYTES);
    const source = createWorkerFileRangeSource(client, "/data/x.slp", FILE_BYTES.length, {
      pageSize: 1000,
    });

    await source.readRange(0, 10); // page 0: no run yet
    await source.readRange(1000, 10); // page 1: sequential, so page 2 is fetched too
    const afterRun = fsReadCalls.length;
    await source.readRange(2000, 10); // page 2: already fetched

    expect(afterRun).toBe(3);
    expect(fsReadCalls.length).toBe(3 + 2); // page 2 hit, and the run grows: pages 3-4 fetched ahead
  });

  it("reports the bytes each fs.read brought back", async () => {
    const { client } = makeFakeClient(FILE_BYTES);
    let total = 0;
    const source = createWorkerFileRangeSource(client, "/data/x.slp", FILE_BYTES.length, {
      pageSize: 1000,
      onBytes: (n) => {
        total += n;
      },
    });

    await source.readRange(5000, 10);

    expect(total).toBe(1000);
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
    readSlpStreamingMock.mockImplementationOnce(async () => {
      throw genericError;
    });

    await expect(loadWorkerLabels(client, "/data/x.slp")).rejects.toBe(genericError);
  });
});

/** A minimal stand-in for a sleap-io.js `Video` — `checkWorkerFileVideos` only ever reads these two members. */
function fakeVideo(filename: string | string[], hasEmbeddedImages: boolean) {
  return { filename, hasEmbeddedImages };
}

/** `.slp` worker path used by every `checkWorkerFileVideos` test below, so `next-to-labels` candidates resolve to `${SLP_DIR}/<basename>`. */
const SLP_PATH = "/root/vast/amick/exp1/labels.slp";
const SLP_DIR = "/root/vast/amick/exp1";

describe("checkWorkerFileVideos", () => {
  it("counts an embedded video as found without statting it, and with no worker path", async () => {
    const client = {
      fsStat: vi.fn(async () => {
        throw new Error("should never be called for an embedded video");
      }),
    } as unknown as WorkerClient;
    const labels = { videos: [fakeVideo("video0.mp4", true)] } as unknown as Parameters<
      typeof checkWorkerFileVideos
    >[1];

    const result = await checkWorkerFileVideos(client, labels, SLP_PATH, []);

    expect(result).toEqual([
      { index: 0, path: "video0.mp4", embedded: true, found: true, workerPath: null, via: null },
    ]);
    expect(client.fsStat).not.toHaveBeenCalled();
  });

  it("resolves a video found at its recorded path as-is, without trying any fallback", async () => {
    const statCalls: string[] = [];
    const client = {
      fsStat: vi.fn(async (path: string) => {
        statCalls.push(path);
        return { path, type: "file" as const, size: 1, modified: 0 };
      }),
    } as unknown as WorkerClient;
    const labels = { videos: [fakeVideo("/mnt/data/a.mp4", false)] } as unknown as Parameters<
      typeof checkWorkerFileVideos
    >[1];

    const result = await checkWorkerFileVideos(client, labels, SLP_PATH, []);

    expect(result).toEqual([
      { index: 0, path: "/mnt/data/a.mp4", embedded: false, found: true, workerPath: "/mnt/data/a.mp4", via: "as-is" },
    ]);
    expect(statCalls).toEqual(["/mnt/data/a.mp4"]);
  });

  it("falls back to a remembered path rule when the recorded path isn't found as-is", async () => {
    const statCalls: string[] = [];
    const client = {
      fsStat: vi.fn(async (path: string) => {
        statCalls.push(path);
        if (path === "/root/vast/amick/mice.mp4") return { path, type: "file" as const, size: 1, modified: 0 };
        throw new WorkerProtocolError(FS_NOT_FOUND, `fs.stat('${path}'): not found`);
      }),
    } as unknown as WorkerClient;
    const labels = { videos: [fakeVideo("/Volumes/talmo/amick/mice.mp4", false)] } as unknown as Parameters<
      typeof checkWorkerFileVideos
    >[1];
    const rules = [{ local: "/Volumes/talmo/amick", worker: "/root/vast/amick" }];

    const result = await checkWorkerFileVideos(client, labels, SLP_PATH, rules);

    expect(result).toEqual([
      {
        index: 0,
        path: "/Volumes/talmo/amick/mice.mp4",
        embedded: false,
        found: true,
        workerPath: "/root/vast/amick/mice.mp4",
        via: "rule",
      },
    ]);
    expect(statCalls).toEqual(["/Volumes/talmo/amick/mice.mp4", "/root/vast/amick/mice.mp4"]);
  });

  it("falls back to the recorded file's basename next to the .slp when no rule matches either", async () => {
    const statCalls: string[] = [];
    const client = {
      fsStat: vi.fn(async (path: string) => {
        statCalls.push(path);
        if (path === `${SLP_DIR}/mice.mp4`) return { path, type: "file" as const, size: 1, modified: 0 };
        throw new WorkerProtocolError(FS_NOT_FOUND, `fs.stat('${path}'): not found`);
      }),
    } as unknown as WorkerClient;
    const labels = { videos: [fakeVideo("/Volumes/talmo/amick/mice.mp4", false)] } as unknown as Parameters<
      typeof checkWorkerFileVideos
    >[1];

    const result = await checkWorkerFileVideos(client, labels, SLP_PATH, []);

    expect(result).toEqual([
      {
        index: 0,
        path: "/Volumes/talmo/amick/mice.mp4",
        embedded: false,
        found: true,
        workerPath: `${SLP_DIR}/mice.mp4`,
        via: "next-to-labels",
      },
    ]);
    // No rule configured -> translatePath short-circuits without a stat call for candidate (b).
    expect(statCalls).toEqual(["/Volumes/talmo/amick/mice.mp4", `${SLP_DIR}/mice.mp4`]);
  });

  it("treats fs.forbidden (outside configured mounts) the same as not-found, trying the next candidate", async () => {
    const client = {
      fsStat: vi.fn(async (path: string) => {
        if (path === "/mnt/shared/mice.mp4") return { path, type: "file" as const, size: 1, modified: 0 };
        throw new WorkerProtocolError(FS_FORBIDDEN, `fs.stat('${path}'): outside configured mounts`);
      }),
    } as unknown as WorkerClient;
    const labels = { videos: [fakeVideo("/Volumes/talmo/amick/mice.mp4", false)] } as unknown as Parameters<
      typeof checkWorkerFileVideos
    >[1];
    const rules = [{ local: "/Volumes/talmo/amick", worker: "/mnt/shared" }];

    const result = await checkWorkerFileVideos(client, labels, SLP_PATH, rules);

    expect(result).toEqual([
      {
        index: 0,
        path: "/Volumes/talmo/amick/mice.mp4",
        embedded: false,
        found: true,
        workerPath: "/mnt/shared/mice.mp4",
        via: "rule",
      },
    ]);
  });

  it("reports not-found (null workerPath/via) when every candidate fails", async () => {
    const client = {
      fsStat: vi.fn(async (path: string) => {
        throw new WorkerProtocolError(FS_NOT_FOUND, `fs.stat('${path}'): not found`);
      }),
    } as unknown as WorkerClient;
    const labels = { videos: [fakeVideo("/Volumes/talmo/amick/mice.mp4", false)] } as unknown as Parameters<
      typeof checkWorkerFileVideos
    >[1];

    const result = await checkWorkerFileVideos(client, labels, SLP_PATH, []);

    expect(result).toEqual([
      {
        index: 0,
        path: "/Volumes/talmo/amick/mice.mp4",
        embedded: false,
        found: false,
        workerPath: null,
        via: null,
      },
    ]);
  });

  it("stats multiple non-embedded videos in parallel and reports found/not-found", async () => {
    const statCalls: string[] = [];
    const client = {
      fsStat: vi.fn(async (path: string) => {
        statCalls.push(path);
        if (path !== "/mnt/data/a.mp4") {
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

    const result = await checkWorkerFileVideos(client, labels, SLP_PATH, []);

    expect(result).toEqual([
      { index: 0, path: "/mnt/data/a.mp4", embedded: false, found: true, workerPath: "/mnt/data/a.mp4", via: "as-is" },
      { index: 1, path: "/mnt/data/missing.mp4", embedded: false, found: false, workerPath: null, via: null },
      { index: 2, path: "embedded.mp4", embedded: true, found: true, workerPath: null, via: null },
    ]);
  });

  it("uses the first filename for a multi-file ImageVideo (and only checks that one)", async () => {
    const statCalls: string[] = [];
    const client = {
      fsStat: vi.fn(async (path: string) => {
        statCalls.push(path);
        return { path, type: "file" as const, size: 1, modified: 0 };
      }),
    } as unknown as WorkerClient;
    const labels = {
      videos: [fakeVideo(["/mnt/seq/img0.png", "/mnt/seq/img1.png"], false)],
    } as unknown as Parameters<typeof checkWorkerFileVideos>[1];

    const result = await checkWorkerFileVideos(client, labels, SLP_PATH, []);

    expect(result).toEqual([
      { index: 0, path: "/mnt/seq/img0.png", embedded: false, found: true, workerPath: "/mnt/seq/img0.png", via: "as-is" },
    ]);
    expect(statCalls).toEqual(["/mnt/seq/img0.png"]);
  });

  it("propagates a non-not-found, non-forbidden fs.stat error instead of trying the next candidate", async () => {
    const statCalls: string[] = [];
    const client = {
      fsStat: vi.fn(async (path: string) => {
        statCalls.push(path);
        throw new Error("fs.stat('x'): connection lost");
      }),
    } as unknown as WorkerClient;
    const labels = { videos: [fakeVideo("/mnt/data/a.mp4", false)] } as unknown as Parameters<
      typeof checkWorkerFileVideos
    >[1];

    await expect(checkWorkerFileVideos(client, labels, SLP_PATH, [])).rejects.toThrow("connection lost");
    expect(statCalls).toEqual(["/mnt/data/a.mp4"]); // aborted on the first candidate, never tried rule/next-to-labels
  });
});

describe("needsLabelsRepoint", () => {
  it("is false when every video resolved as-is or is embedded", () => {
    expect(
      needsLabelsRepoint([
        { index: 0, path: "/a.mp4", embedded: false, found: true, workerPath: "/a.mp4", via: "as-is" },
        { index: 1, path: "video0", embedded: true, found: true, workerPath: null, via: null },
      ]),
    ).toBe(false);
  });

  it("is false for an empty check (nothing to repoint)", () => {
    expect(needsLabelsRepoint([])).toBe(false);
  });

  it("is true when a video only resolved via a remembered rule", () => {
    expect(
      needsLabelsRepoint([
        { index: 0, path: "/a.mp4", embedded: false, found: true, workerPath: "/mnt/a.mp4", via: "rule" },
      ]),
    ).toBe(true);
  });

  it("is true when a video only resolved next to the labels file", () => {
    expect(
      needsLabelsRepoint([
        {
          index: 0,
          path: "/a.mp4",
          embedded: false,
          found: true,
          workerPath: "/root/vast/a.mp4",
          via: "next-to-labels",
        },
      ]),
    ).toBe(true);
  });
});

describe("videoChecksToVisibility", () => {
  it("marks an as-is/rule/next-to-labels video visible at its resolved worker path", () => {
    const checks = [
      { index: 0, path: "/a.mp4", embedded: false, found: true, workerPath: "/a.mp4", via: "as-is" as const },
      { index: 1, path: "/b.mp4", embedded: false, found: true, workerPath: "/mnt/b.mp4", via: "rule" as const },
    ];

    expect(videoChecksToVisibility(checks)).toEqual([
      { index: 0, local: "/a.mp4", worker: "/a.mp4", visible: true },
      { index: 1, local: "/b.mp4", worker: "/mnt/b.mp4", visible: true },
    ]);
  });

  it("marks an unresolved video not-visible with a null worker path", () => {
    const checks = [
      { index: 0, path: "/a.mp4", embedded: false, found: false, workerPath: null, via: null },
    ];

    expect(videoChecksToVisibility(checks)).toEqual([
      { index: 0, local: "/a.mp4", worker: null, visible: false },
    ]);
  });

  it("marks an embedded video not-visible so buildRemoteLabelsPayload keeps its own backend instead of clearing it", () => {
    const checks = [
      { index: 0, path: "video0", embedded: true, found: true, workerPath: null, via: null },
    ];

    expect(videoChecksToVisibility(checks)).toEqual([
      { index: 0, local: "video0", worker: null, visible: false },
    ]);
  });
});

describe("workerFramePath", () => {
  const found = (workerPath: string) => ({
    index: 0,
    path: "/Volumes/lab/v.mp4",
    embedded: false,
    found: true,
    workerPath,
    via: "rule" as const,
  });

  it("is the resolved worker path for a single-file video", () => {
    expect(workerFramePath("/Volumes/lab/v.mp4", found("/data/v.mp4"), 99)).toBe("/data/v.mp4");
  });

  it("is that frame's image, in the folder the first image resolved to, for an image sequence", () => {
    const files = ["C:\\imgs\\f0.png", "C:\\imgs\\f1.png", "C:\\imgs\\f2.png"];
    expect(workerFramePath(files, found("/data/imgs/f0.png"), 2)).toBe("/data/imgs/f2.png");
    expect(workerFramePath(files, found("/data/imgs/f0.png"), 3)).toBeNull();
  });

  it("is null for an embedded or missing video", () => {
    expect(workerFramePath("x", { ...found("/a"), embedded: true, workerPath: null }, 0)).toBeNull();
    expect(workerFramePath("x", { ...found("/a"), found: false, workerPath: null }, 0)).toBeNull();
  });
});

describe("fetchWorkerPreviewFrame", () => {
  const labels = { videos: [{ filename: "/Volumes/lab/v.mp4" }] } as never;
  const checks = [
    { index: 0, path: "/Volumes/lab/v.mp4", embedded: false, found: true, workerPath: "/data/v.mp4", via: "rule" as const },
  ];

  it("asks the worker for that frame and keeps the original size", async () => {
    const calls: Array<[string, number]> = [];
    const client = {
      mediaFrame: async (path: string, frameIdx: number) => {
        calls.push([path, frameIdx]);
        return { content: new Uint8Array([1, 2]), mime: "image/jpeg", width: 4096, height: 2048, scaledWidth: 2048, scaledHeight: 1024 };
      },
    } as unknown as WorkerClient;
    const bitmap = { width: 2048, height: 1024 } as unknown as ImageBitmap;
    const original = globalThis.createImageBitmap;
    globalThis.createImageBitmap = (async () => bitmap) as never;
    try {
      const frame = await fetchWorkerPreviewFrame(client, labels, "/data/l.slp", checks, 0, 7);
      expect(calls).toEqual([["/data/v.mp4", 7]]);
      expect(frame).toEqual({ bitmap, width: 4096, height: 2048 });
    } finally {
      globalThis.createImageBitmap = original;
    }
  });

  it("explains an older worker without media.frame", async () => {
    const client = {
      mediaFrame: async () => {
        throw new WorkerProtocolError(PROTO_UNKNOWN_METHOD, "no such method");
      },
    } as unknown as WorkerClient;
    await expect(fetchWorkerPreviewFrame(client, labels, "/data/l.slp", checks, 0, 7)).rejects.toThrow(
      "Update sleap-rtc on the worker to preview its videos",
    );
  });

  it("reads an embedded (pkg.slp) frame's stored image itself, then closes the reader", async () => {
    embeddedCalls.opened = embeddedCalls.closed = 0;
    embeddedCalls.frames = [];
    const pkgLabels = {
      videos: [{ filename: "/data/l.pkg.slp", backendMetadata: { dataset: "video0/video", format: "png" } }],
    } as never;
    const pkgChecks = [
      { index: 0, path: "/data/l.pkg.slp", embedded: true, found: true, workerPath: null, via: null },
    ];
    const mediaFrame = vi.fn();
    const client = {
      mediaFrame,
      fsStat: async () => ({ path: "/data/l.pkg.slp", type: "file", size: 100, modified: 0, shared: true }),
    } as unknown as WorkerClient;

    const frame = await fetchWorkerPreviewFrame(client, pkgLabels, "/data/l.pkg.slp", pkgChecks, 0, 9);
    expect(embeddedCalls.dataset).toBe("video0/video");
    expect(embeddedCalls.frames).toEqual([9]);
    expect(frame).toMatchObject({ width: 6, height: 4 });
    // Frame 0 isn't stored (no labeled frame): falls back to the first stored one.
    await fetchWorkerPreviewFrame(client, pkgLabels, "/data/l.pkg.slp", pkgChecks, 0, 0);
    expect(embeddedCalls.frames).toEqual([9, 5]);

    expect(mediaFrame).not.toHaveBeenCalled();
    expect(embeddedCalls.closed).toBe(embeddedCalls.opened);
  });

  it("explains a video that isn't on the worker, without asking it", async () => {
    const client = { mediaFrame: vi.fn() } as unknown as WorkerClient;
    const missing = [{ ...checks[0], found: false, workerPath: null }];
    await expect(fetchWorkerPreviewFrame(client, labels, "/data/l.slp", missing, 0, 7)).rejects.toThrow(
      "Video not found on the worker",
    );
    expect((client as unknown as { mediaFrame: ReturnType<typeof vi.fn> }).mediaFrame).not.toHaveBeenCalled();
  });
});
