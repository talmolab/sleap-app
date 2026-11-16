/**
 * The chunked zip writer the training job package uses to put a large
 * `.pkg.slp` into a `.zip` without holding it all in memory.
 */
import { describe, it, expect } from "../bun-test";
import { unzipSync, strFromU8 } from "fflate";
import { bytesSource, textSource, writeZip, ZipCancelled } from "@/lib/streamingZip";

async function zipToBytes(...args: Parameters<typeof writeZip>): Promise<{ bytes: Uint8Array; pieces: number }> {
  const parts: Uint8Array[] = [];
  await writeZip(args[0], async (c) => void parts.push(c.slice()), args[2]);
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    bytes.set(p, o);
    o += p.byteLength;
  }
  return { bytes, pieces: parts.length };
}

describe("writeZip", () => {
  // Every file must come back out of the zip byte-for-byte.
  it("round-trips text and binary files", async () => {
    const big = new Uint8Array(100_000).map((_, i) => (i * 31) % 251);
    const { bytes } = await zipToBytes([bytesSource("data.pkg.slp", big), textSource("train-script.sh", "#!/bin/bash\n"), textSource("empty.txt", "")], async () => {}, { chunkSize: 4096 });
    const out = unzipSync(bytes);
    expect(Object.keys(out).sort()).toEqual(["data.pkg.slp", "empty.txt", "train-script.sh"]);
    expect(out["data.pkg.slp"]).toEqual(big);
    expect(strFromU8(out["train-script.sh"])).toBe("#!/bin/bash\n");
    expect(out["empty.txt"].byteLength).toBe(0);
  });

  // A large file must be read and written in pieces, not all at once.
  it("reads the source in chunks", async () => {
    const reads: number[] = [];
    const size = 50_000;
    const src = {
      name: "x.bin",
      size,
      read: async (offset: number, length: number) => {
        reads.push(length);
        return new Uint8Array(Math.min(length, size - offset));
      },
    };
    const { pieces } = await zipToBytes([src], async () => {}, { chunkSize: 10_000 });
    expect(reads).toEqual([10_000, 10_000, 10_000, 10_000, 10_000]);
    expect(pieces).toBeGreaterThan(5);
  });

  // Cancel in the progress overlay must stop the zip.
  it("stops when progress asks it to", async () => {
    const src = bytesSource("x.bin", new Uint8Array(30_000));
    await expect(
      zipToBytes([src], async () => {}, { chunkSize: 10_000, onProgress: (done) => done < 10_000 }),
    ).rejects.toBeInstanceOf(ZipCancelled);
  });

  // A file that is shorter than it said must fail loudly, not write a broken zip.
  it("fails if a source ends early", async () => {
    const src = { name: "x.bin", size: 100, read: async () => new Uint8Array(0) };
    await expect(zipToBytes([src], async () => {})).rejects.toThrow("ended early");
  });
});
