/**
 * saveEmbeddedPkgStreaming's new-embed path (Export Labels Package from an
 * mp4 project): with no already-embedded images there is no source file, so
 * the stage file is opened on its own (`openWrite`) and io's
 * `appendEncodedVideos` streams the frames into it; the encoded videos are
 * verified like copied ones, and a cancelled export leaves no file behind.
 * io's writer/reader and the native file commands are mocked.
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";

class ExportCancelled extends Error {}

const calls: string[] = [];
const files = new Map<string, number>(); // path -> size
let appendImpl: (opts: { onProgress?: (c: number, t: number) => unknown }) => Promise<void>;
let plan: {
  sourcePath: string;
  entries: Array<{ videoIndex: number; frameNumbers: number[] }>;
  encodeEntries: Array<{ videoIndex: number; frameNumbers: number[] }>;
};
let framesOnDisk: Record<string, number>;

vi.mock("@talmolab/sleap-io.js", () => ({
  ExportCancelled,
  saveSlpStructureToBytes: async () => new Uint8Array(10),
  buildSerializableEmbedPlan: async (_l: unknown, _e: unknown, source: string, opts: object) => {
    calls.push(`plan(${JSON.stringify(source)},${JSON.stringify(opts)})`);
    return plan;
  },
  appendEncodedVideos: async (
    _writer: unknown,
    _labels: unknown,
    entries: unknown[],
    opts: { onProgress?: (c: number, t: number) => unknown; frameReader?: unknown }
  ) => {
    calls.push(`appendEncodedVideos(${entries.length})`);
    if (opts.frameReader) calls.push("frameReader");
    await appendImpl(opts);
  },
  StreamingH5Writer: class {
    async openWrite(_sink: unknown, path: string) {
      calls.push(`openWrite(${path.split("/").pop()})`);
    }
    async openAppend() {
      calls.push("openAppend");
    }
    async appendEmbeddedVideos() {
      calls.push("appendEmbeddedVideos");
      return { success: true };
    }
    async close() {
      calls.push("writer.close");
    }
  },
  StreamingH5File: class {
    async openRange() {}
    async getDatasetMeta(path: string) {
      return { shape: [framesOnDisk[path] ?? 0] };
    }
    async close() {}
  },
}));
vi.mock("@/lib/nativeWrite", () => ({
  withNativeWriteHandle: <T,>(work: () => Promise<T>) => work(),
  writeOpen: async (p: string) => void files.set(p, 0),
  writeOpenAppend: async () => {},
  writeAt: async () => {},
  readAt: async () => new Uint8Array(0),
  truncateFile: async () => {},
  writeClose: async () => {},
  renameFile: async (from: string, to: string) => {
    calls.push("rename");
    files.set(to, files.get(from) ?? 0);
    files.delete(from);
  },
  copyFile: async (from: string, to: string) => {
    calls.push("copy");
    files.set(to, files.get(from) ?? 0);
  },
  removeFile: async (p: string) => {
    calls.push(`remove(${p.split("/").pop()})`);
    files.delete(p);
  },
}));
vi.mock("@/lib/nativeRange", () => ({
  fileSize: async () => 10,
  readRange: async () => new Uint8Array(0),
}));
vi.mock("@tauri-apps/api/path", () => ({
  appCacheDir: async () => "/cache",
  appLocalDataDir: async () => "/local",
  join: async (...parts: string[]) => parts.join("/"),
}));

const { saveEmbeddedPkgStreaming } = await import("@/lib/saveEmbeddedPkgStreaming");

const labels = {} as never;

beforeEach(() => {
  calls.length = 0;
  files.clear();
  (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = true;
  plan = { sourcePath: "", entries: [], encodeEntries: [{ videoIndex: 0, frameNumbers: [0, 5, 9] }] };
  framesOnDisk = { "video0/frame_numbers": 3 };
  appendImpl = async () => {};
});

describe("saveEmbeddedPkgStreaming — new embed (no source file)", () => {
  it("opens the stage file alone, streams the frames in, verifies them, and publishes", async () => {
    const progress: number[] = [];
    appendImpl = async (opts) => {
      for (let i = 1; i <= 3; i++) opts.onProgress?.(i, 3);
    };
    await saveEmbeddedPkgStreaming(labels, "/out/x.pkg.slp", null, {
      embed: "user",
      onProgress: (c) => void progress.push(c),
    });

    expect(calls[0]).toBe('plan("",{"allowEncode":true})');
    expect(calls).toContain("appendEncodedVideos(1)");
    expect(calls).not.toContain("openAppend");
    expect(calls.find((c) => c.startsWith("openWrite"))).toBeDefined();
    expect(progress).toEqual([1, 2, 3]);
    // Published only after the frames went in: bulk copy, then atomic rename.
    expect(calls.indexOf("appendEncodedVideos(1)")).toBeLessThan(calls.indexOf("copy"));
    expect(calls.indexOf("copy")).toBeLessThan(calls.indexOf("rename"));
    expect(files.has("/out/x.pkg.slp")).toBe(true);
  });

  it("hands a frame reader (desktop: ffmpeg) through to io", async () => {
    await saveEmbeddedPkgStreaming(labels, "/out/x.pkg.slp", null, {
      embed: "user",
      frameReader: async () => null,
    });
    expect(calls).toContain("frameReader");
  });

  it("refuses to publish when the file holds fewer frames than planned", async () => {
    framesOnDisk = { "video0/frame_numbers": 2 };
    await expect(
      saveEmbeddedPkgStreaming(labels, "/out/x.pkg.slp", null, { embed: "user" })
    ).rejects.toThrow("expected 3");
    expect(calls).not.toContain("rename");
    expect(files.has("/out/x.pkg.slp")).toBe(false);
  });

  it("removes the partial file and writes nothing when cancelled", async () => {
    appendImpl = async () => {
      throw new ExportCancelled();
    };
    await expect(
      saveEmbeddedPkgStreaming(labels, "/out/x.pkg.slp", null, { embed: "user" })
    ).rejects.toBeInstanceOf(ExportCancelled);
    expect(calls).toContain("writer.close");
    expect(calls).not.toContain("rename");
    expect([...files.keys()]).toEqual([]);
  });

  it("needs the source file to copy already-embedded images", async () => {
    plan = { sourcePath: "", entries: [{ videoIndex: 0, frameNumbers: [1] }], encodeEntries: [] };
    await expect(
      saveEmbeddedPkgStreaming(labels, "/out/x.pkg.slp", null, { embed: "user" })
    ).rejects.toThrow("needs the source file");
  });
});
