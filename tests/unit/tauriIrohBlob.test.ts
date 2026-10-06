import { describe, it, expect } from "../bun-test";
import { createTauriIrohBlobRangeSource, type TauriBlobIpc } from "@/lib/protocolV1/tauriIrohBlob";
import { BLOB_HASH_MISMATCH, WorkerProtocolError } from "@/lib/protocolV1/errors";

const CHUNK_SIZE = 4;
const BLOB_BYTES = new TextEncoder().encode("0123456789abcdefghij"); // 20 bytes, 5 chunks of 4

async function realSha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function realChunkHashes(bytes: Uint8Array, chunkSize: number): Promise<string[]> {
  const hashes: string[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    hashes.push(await realSha256Hex(bytes.subarray(i, i + chunkSize)));
  }
  return hashes;
}

interface RecordedInvoke {
  cmd: string;
  args?: Record<string, unknown>;
}

/** A fake worker: serves the open response once, then returns exactly the
 * requested aligned window's bytes out of BLOB_BYTES for every read. */
function makeFakeIpc(overrides: {
  chunkHashes?: string[];
  onReadRange?: (offset: number, length: number) => Uint8Array;
} = {}) {
  const calls: RecordedInvoke[] = [];
  const ipc: TauriBlobIpc = {
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd.endsWith("iroh_blob_open")) {
        return {
          size: BLOB_BYTES.length,
          chunkSize: CHUNK_SIZE,
          chunkHashes: overrides.chunkHashes ?? (await realChunkHashes(BLOB_BYTES, CHUNK_SIZE)),
        };
      }
      if (cmd.endsWith("iroh_blob_read_range")) {
        const offset = args!.offset as number;
        const length = args!.length as number;
        if (overrides.onReadRange) return overrides.onReadRange(offset, length);
        return BLOB_BYTES.subarray(offset, Math.min(offset + length, BLOB_BYTES.length));
      }
      if (cmd.endsWith("iroh_blob_close")) return undefined;
      throw new Error(`unexpected invoke: ${cmd}`);
    },
  };
  return { ipc, calls };
}

describe("createTauriIrohBlobRangeSource", () => {
  it("does not open a stream until the first readRange call", async () => {
    const { ipc, calls } = makeFakeIpc();
    createTauriIrohBlobRangeSource("abc123", BLOB_BYTES.length, async () => ipc);

    expect(calls.length).toBe(0);
  });

  it("opens lazily on first read and reuses the same session for later reads", async () => {
    const { ipc, calls } = makeFakeIpc();
    const { source } = createTauriIrohBlobRangeSource("abc123", BLOB_BYTES.length, async () => ipc);

    await source.readRange(0, 4);
    await source.readRange(4, 4);
    await source.readRange(8, 4);

    const opens = calls.filter((c) => c.cmd.endsWith("iroh_blob_open"));
    expect(opens.length).toBe(1);
    const reads = calls.filter((c) => c.cmd.endsWith("iroh_blob_read_range"));
    expect(reads.length).toBe(3);
  });

  it("returns exactly the requested bytes for a read entirely inside one chunk", async () => {
    const { ipc } = makeFakeIpc();
    const { source } = createTauriIrohBlobRangeSource("abc123", BLOB_BYTES.length, async () => ipc);

    const bytes = await source.readRange(0, 4);

    expect(new TextDecoder().decode(bytes)).toBe("0123");
  });

  it("aligns a read spanning two chunks to the chunk boundary on the wire, but returns only what was asked for", async () => {
    const { ipc, calls } = makeFakeIpc();
    const { source } = createTauriIrohBlobRangeSource("abc123", BLOB_BYTES.length, async () => ipc);

    // Chunk 1 = bytes [4,8), chunk 2 = bytes [8,12) — this spans both.
    const bytes = await source.readRange(6, 4);

    expect(new TextDecoder().decode(bytes)).toBe("6789");
    const read = calls.find((c) => c.cmd.endsWith("iroh_blob_read_range"));
    expect(read?.args).toEqual({ offset: 4, length: 8 }); // aligned to chunks [1,2]
  });

  it("aligns a read starting mid-chunk to the enclosing chunk on the wire", async () => {
    const { ipc, calls } = makeFakeIpc();
    const { source } = createTauriIrohBlobRangeSource("abc123", BLOB_BYTES.length, async () => ipc);

    // Offset 2 is mid-chunk-0; length 1 stays within chunk 0.
    const bytes = await source.readRange(2, 1);

    expect(new TextDecoder().decode(bytes)).toBe("2");
    const read = calls.find((c) => c.cmd.endsWith("iroh_blob_read_range"));
    expect(read?.args).toEqual({ offset: 0, length: 4 }); // aligned to chunk [0]
  });

  it("throws BLOB_HASH_MISMATCH when the returned bytes don't match the registered chunk hash", async () => {
    const { ipc } = makeFakeIpc({ chunkHashes: ["0000000000000000000000000000000000000000000000000000000000000000".slice(0, 64)] });
    const { source } = createTauriIrohBlobRangeSource("abc123", BLOB_BYTES.length, async () => ipc);

    let error: unknown;
    try {
      await source.readRange(0, 4);
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(WorkerProtocolError);
    expect((error as WorkerProtocolError).code).toBe(BLOB_HASH_MISMATCH);
  });

  it("dispose() is a no-op if readRange was never called", async () => {
    const { ipc, calls } = makeFakeIpc();
    const { dispose } = createTauriIrohBlobRangeSource("abc123", BLOB_BYTES.length, async () => ipc);

    await dispose();

    expect(calls.length).toBe(0);
  });

  it("dispose() closes the stream once it was actually opened", async () => {
    const { ipc, calls } = makeFakeIpc();
    const { source, dispose } = createTauriIrohBlobRangeSource("abc123", BLOB_BYTES.length, async () => ipc);

    await source.readRange(0, 4);
    await dispose();

    expect(calls.filter((c) => c.cmd.endsWith("iroh_blob_close")).length).toBe(1);
  });
});
