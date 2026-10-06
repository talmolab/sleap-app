/**
 * Tests for the off-main decode upgrade orchestrator
 * (src/lib/workerDecodeUpgrade.ts): open on-main, upgrade to the worker backend
 * when supported, and NEVER clobber a proxy swap / corrupt a cached-proxy backend.
 */
import { describe, it, expect } from "../bun-test";
import {
  runWorkerDecodeUpgrade,
  buildBlobByteSourceDescriptor,
  buildUrlByteSourceDescriptor,
  type WorkerUpgradeDeps,
} from "@/lib/workerDecodeUpgrade";
import type {
  ByteSourceDescriptor,
  Mp4ParseResult,
  VideoBackend,
} from "@talmolab/sleap-io.js";

function parseResult(fileSize = 1000): Mp4ParseResult {
  return {
    samples: [],
    keyframeIndices: [],
    config: { codec: "avc1.42E01E", codedWidth: 64, codedHeight: 64 },
    shape: [10, 64, 64, 3],
    fps: 30,
    fileSize,
  };
}

const descriptor = (size = 1000): ByteSourceDescriptor => ({
  kind: "tauri",
  url: "ipc://localhost/read_range",
  headers: {},
  path: "/x.mp4",
  size,
});

/** A minimal original backend exposing getParseResult + close. */
function fakeOriginal(fileSize = 1000) {
  const state = { closed: false };
  const backend = {
    getParseResult: async () => parseResult(fileSize),
    close: () => {
      state.closed = true;
    },
  } as unknown as VideoBackend;
  return { backend, state };
}

function fakeWorkerBackend() {
  const state = { closed: false };
  const backend = {
    close: () => {
      state.closed = true;
    },
  } as unknown as VideoBackend;
  return { backend, state };
}

/** Build deps with sensible passing defaults + overrides + call spies. */
function makeDeps(
  original: VideoBackend,
  worker: VideoBackend,
  overrides: Partial<WorkerUpgradeDeps> = {},
) {
  const calls = { swapped: null as VideoBackend | null, reread: 0, upgraded: 0 };
  let backend: VideoBackend | null = original;
  const deps: WorkerUpgradeDeps = {
    isAvailable: () => true,
    buildDescriptor: async () => descriptor(1000),
    createWorkerBackend: async () => worker,
    isStillActive: () => true,
    currentBackend: () => backend,
    swap: (b) => {
      backend = b;
      calls.swapped = b;
    },
    triggerReread: () => {
      calls.reread += 1;
    },
    onUpgraded: () => {
      calls.upgraded += 1;
    },
    ...overrides,
  };
  return { deps, calls, setBackend: (b: VideoBackend | null) => (backend = b) };
}

describe("browser byte-source descriptors", () => {
  it("builds a blob descriptor with the blob's own size", () => {
    const blob = new Blob([new Uint8Array(1234)]);
    const d = buildBlobByteSourceDescriptor(blob);
    expect(d.kind).toBe("blob");
    expect(d.size).toBe(1234);
    if (d.kind === "blob") expect(d.blob).toBe(blob);
  });

  it("builds a url descriptor with headers + explicit size", () => {
    const d = buildUrlByteSourceDescriptor(
      "https://x/v.mp4",
      { Authorization: "Bearer t" },
      987,
    );
    expect(d).toEqual({
      kind: "url",
      url: "https://x/v.mp4",
      headers: { Authorization: "Bearer t" },
      size: 987,
    });
  });
});

describe("runWorkerDecodeUpgrade", () => {
  it("upgrades: swaps in the worker backend, re-reads, closes the original", async () => {
    const { backend: original, state: origState } = fakeOriginal();
    const { backend: worker } = fakeWorkerBackend();
    const { deps, calls } = makeDeps(original, worker);

    const outcome = await runWorkerDecodeUpgrade(original, "/x.mp4", "x.mp4", deps);

    expect(outcome).toBe("upgraded");
    expect(calls.swapped).toBe(worker);
    expect(calls.reread).toBe(1);
    expect(calls.upgraded).toBe(1);
    expect(origState.closed).toBe(true);
  });

  it("unsupported: worker self-test rejects → keeps the on-main backend", async () => {
    const { backend: original, state: origState } = fakeOriginal();
    const { backend: worker } = fakeWorkerBackend();
    const { deps, calls } = makeDeps(original, worker, {
      createWorkerBackend: async () => {
        throw new Error("no WebCodecs in worker");
      },
    });

    const outcome = await runWorkerDecodeUpgrade(original, "/x.mp4", "x.mp4", deps);

    expect(outcome).toBe("unsupported");
    expect(calls.swapped).toBeNull();
    expect(origState.closed).toBe(false);
  });

  it("skips when workers are unavailable", async () => {
    const { backend: original } = fakeOriginal();
    const { backend: worker } = fakeWorkerBackend();
    const { deps } = makeDeps(original, worker, { isAvailable: () => false });
    expect(
      await runWorkerDecodeUpgrade(original, "/x.mp4", "x.mp4", deps),
    ).toBe("skipped");
  });

  it("skips a backend that can't hand off its parse", async () => {
    const original = { close: () => {} } as unknown as VideoBackend;
    const { backend: worker } = fakeWorkerBackend();
    const { deps } = makeDeps(original, worker);
    expect(
      await runWorkerDecodeUpgrade(original, "/x.mp4", "x.mp4", deps),
    ).toBe("skipped");
  });

  it("skips when no byte-source descriptor is available", async () => {
    const { backend: original } = fakeOriginal();
    const { backend: worker } = fakeWorkerBackend();
    const { deps } = makeDeps(original, worker, {
      buildDescriptor: async () => null,
    });
    expect(
      await runWorkerDecodeUpgrade(original, "/x.mp4", "x.mp4", deps),
    ).toBe("skipped");
  });

  it("skips on a file-size mismatch (cached-proxy backend guard)", async () => {
    // Backend parsed a 1000-byte file, but the descriptor is for a 500-byte file
    // (e.g. the backend is actually a swapped-in proxy) → must NOT decode.
    const { backend: original } = fakeOriginal(1000);
    const { backend: worker } = fakeWorkerBackend();
    const { deps, calls } = makeDeps(original, worker, {
      buildDescriptor: async () => descriptor(500),
    });
    expect(
      await runWorkerDecodeUpgrade(original, "/x.mp4", "x.mp4", deps),
    ).toBe("skipped");
    expect(calls.swapped).toBeNull();
  });

  it("supersedes when a proxy already swapped in before create", async () => {
    const { backend: original } = fakeOriginal();
    const { backend: worker } = fakeWorkerBackend();
    const other = { close: () => {} } as unknown as VideoBackend;
    const { deps } = makeDeps(original, worker, {
      currentBackend: () => other, // not the original we started from
    });
    expect(
      await runWorkerDecodeUpgrade(original, "/x.mp4", "x.mp4", deps),
    ).toBe("superseded");
  });

  it("supersedes + closes the worker if the backend changed during create", async () => {
    const { backend: original } = fakeOriginal();
    const { backend: worker, state: workerState } = fakeWorkerBackend();
    const other = { close: () => {} } as unknown as VideoBackend;
    let phase = 0;
    const { deps, calls } = makeDeps(original, worker, {
      // original for the pre-create check, then a different backend afterwards.
      currentBackend: () => (phase++ === 0 ? original : other),
    });
    const outcome = await runWorkerDecodeUpgrade(original, "/x.mp4", "x.mp4", deps);
    expect(outcome).toBe("superseded");
    expect(calls.swapped).toBeNull();
    expect(workerState.closed).toBe(true);
  });
});
