/**
 * Browser Export Labels Package through OPFS (`exportNewPkgOpfs`): the
 * structure seeds an OPFS file, the writer's worker appends the frames
 * (io `appendEncodedVideos`), and the finished file is streamed into the
 * picked file. io's writer and the browser's OPFS are faked.
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";

class ExportCancelled extends Error {}

const calls: string[] = [];
let appendImpl: (opts: { onProgress?: (c: number, t: number) => unknown }) => Promise<void>;
let encodeEntries: unknown[];

vi.mock("@talmolab/sleap-io.js", () => ({
  saveSlpStructureToBytes: async (_l: unknown, opts: { embed: unknown }) => {
    calls.push(`structure(${JSON.stringify(opts.embed)})`);
    return new Uint8Array([1, 2, 3]);
  },
  buildSerializableEmbedPlan: async (_l: unknown, embed: unknown, _s: string, opts: object) => {
    calls.push(`plan(${JSON.stringify(embed)},${JSON.stringify(opts)})`);
    return { sourcePath: "", entries: [], encodeEntries };
  },
  appendEncodedVideos: async (
    _w: unknown,
    _l: unknown,
    entries: unknown[],
    opts: { onProgress?: (c: number, t: number) => unknown }
  ) => {
    calls.push(`append(${entries.length})`);
    await appendImpl(opts);
  },
  StreamingH5Writer: class {
    async openWriteOpfs(path: string, size: number) {
      calls.push(`openWriteOpfs(${size})`);
      expect(opfsFiles.get(path)).toEqual(new Uint8Array([1, 2, 3]));
    }
    async close() {
      calls.push("writer.close");
    }
  },
}));

/** The picked file's writable, as far as the export uses it. */
interface FakeWritable {
  write(b: Uint8Array): Promise<void>;
  close(): Promise<void>;
}

/**
 * A File-like whose stream() pipes its bytes into the (fake) writable; the
 * test DOM has no WritableStream that bun's native pipeTo accepts.
 */
function fakeFile(bytes: Uint8Array) {
  return {
    size: bytes.length,
    stream: () => ({
      pipeTo: async (w: FakeWritable) => {
        await w.write(bytes);
        await w.close();
      },
    }),
  };
}

/** Fake OPFS root: files by name. */
const opfsFiles = new Map<string, Uint8Array>();
const root = {
  getFileHandle: async (name: string, opts?: { create?: boolean }) => {
    if (!opfsFiles.has(name)) {
      if (!opts?.create) throw new DOMException("missing", "NotFoundError");
      opfsFiles.set(name, new Uint8Array(0));
    }
    return {
      createWritable: async () => ({
        write: async (b: Uint8Array) => void opfsFiles.set(name, new Uint8Array(b)),
        close: async () => {},
      }),
      getFile: async () => fakeFile(opfsFiles.get(name)!),
    };
  },
  removeEntry: async (name: string) => {
    calls.push("removeStaging");
    opfsFiles.delete(name);
  },
};
Object.defineProperty(globalThis.navigator, "storage", {
  value: { getDirectory: async () => root },
  configurable: true,
});

/** The picked destination: what it holds, and whether it was removed. */
function destHandle(initial = new Uint8Array(0)) {
  const dest = {
    name: "out.pkg.slp",
    bytes: initial,
    removed: false,
    getFile: async () => fakeFile(dest.bytes),
    remove: async () => void (dest.removed = true),
    createWritable: async (): Promise<FakeWritable> => {
      const chunks: Uint8Array[] = [];
      return {
        write: async (c) => void chunks.push(c),
        close: async () => {
          dest.bytes = new Uint8Array(chunks.flatMap((c) => [...c]));
          calls.push("published");
        },
      };
    },
  };
  return dest;
}

const { exportNewPkgOpfs } = await import("@/lib/saveEmbeddedPkgOpfs");
const labels = {} as never;

beforeEach(() => {
  calls.length = 0;
  opfsFiles.clear();
  encodeEntries = [{ videoIndex: 0, frameNumbers: [0, 5] }];
  appendImpl = async () => {};
});

describe("exportNewPkgOpfs", () => {
  it("seeds the structure, appends the frames in the worker, then streams it into the picked file", async () => {
    const progress: number[] = [];
    appendImpl = async (opts) => {
      for (let i = 1; i <= 2; i++) opts.onProgress?.(i, 2);
    };
    const dest = destHandle();
    const name = await exportNewPkgOpfs(labels, dest as never, {
      embed: "user",
      onProgress: (c) => void progress.push(c),
    });

    expect(name).toBe("out.pkg.slp");
    expect(calls).toEqual([
      'structure("user")',
      'plan("user",{"allowEncode":true})',
      "openWriteOpfs(3)",
      "append(1)",
      "writer.close",
      "published",
      "removeStaging",
    ]);
    expect(progress).toEqual([1, 2]);
    expect(dest.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(opfsFiles.size).toBe(0);
  });

  it("publishes the structure alone when no video has frames to embed", async () => {
    encodeEntries = [];
    const dest = destHandle();
    await exportNewPkgOpfs(labels, dest as never, { embed: "user" });
    expect(calls).not.toContain("openWriteOpfs(3)");
    expect(dest.bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("on cancel, removes the staging file and the empty picked file, and writes nothing", async () => {
    appendImpl = async () => {
      throw new ExportCancelled();
    };
    const dest = destHandle();
    await expect(
      exportNewPkgOpfs(labels, dest as never, { embed: "user" })
    ).rejects.toBeInstanceOf(ExportCancelled);
    expect(calls).toContain("writer.close");
    expect(calls).not.toContain("published");
    expect(opfsFiles.size).toBe(0);
    expect(dest.removed).toBe(true);
  });

  it("never removes a picked file that already had content", async () => {
    appendImpl = async () => {
      throw new Error("disk full");
    };
    const dest = destHandle(new Uint8Array([9]));
    await expect(exportNewPkgOpfs(labels, dest as never, { embed: "user" })).rejects.toThrow(
      "disk full"
    );
    expect(dest.removed).toBe(false);
    expect(dest.bytes).toEqual(new Uint8Array([9]));
  });
});
