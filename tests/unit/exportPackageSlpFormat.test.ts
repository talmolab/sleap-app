/**
 * Verifies that `exportLabelsPackage` forwards `slpVersion` and `unlabeledAs`
 * to all three write paths (in-memory, desktop streaming, and Chromium OPFS)
 * and restores the open project's `_slpLayout` even at `level: "full"`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "../bun-test";

type Opts = Record<string, unknown>;
class ExportCancelled extends Error {}

const calls: Array<{ path: string; opts: Opts }> = [];
const platform = { isTauri: false };
const opfs = { supported: false };

vi.mock("@talmolab/sleap-io.js", () => ({
  ExportCancelled,
  saveSlpToBytes: async (labels: { _slpLayout?: string | null }, opts: Opts) => {
    calls.push({ path: "memory", opts });
    // Mirror real sleap-io.js mutating `_slpLayout` during writes.
    if (opts.slpVersion === "v2" || opts.slpVersion === "v3") {
      labels._slpLayout = opts.slpVersion;
    }
    return new Uint8Array([1]);
  },
  loadSlp: async () => ({ videos: [] }),
  readSlpStreaming: async () => ({ videos: [] }),
}));

vi.mock("@/lib/saveEmbeddedPkgStreaming", () => ({
  saveEmbeddedPkgStreaming: async (_l: unknown, _dest: string, _src: unknown, opts: Opts) => {
    calls.push({ path: "stream", opts });
  },
}));

vi.mock("@/lib/saveEmbeddedPkgOpfs", () => ({
  isOpfsSaveSupported: () => opfs.supported,
  pickSlpSaveDestination: async () => ({ name: "out.pkg.slp" }),
  exportNewPkgOpfs: async (_l: unknown, _dest: unknown, opts: Opts) => {
    calls.push({ path: "opfs", opts });
    return "out.pkg.slp";
  },
}));

vi.mock("@/lib/transcode/extractFrames", () => ({
  createTauriExtractFramesDeps: () => ({}),
  createFfmpegFrameReader: async () => null,
}));

vi.mock("@/platform/index", () => ({
  isTauri: false,
  getPlatform: async () => ({
    isTauri: platform.isTauri,
    showSaveDialog: async () => "/data/out.pkg.slp",
    writeFile: async () => {},
  }),
}));

vi.mock("@/commands/fileCommands", () => ({
  saveBytesFile: async () => "/out/labels.pkg.slp",
}));

vi.mock("@/lib/resolveVideos", () => ({ prepareVideosForFrameReads: async () => {} }));
vi.mock("@/lib/notify", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

const { exportLabelsPackage, ExportFullPackageCommand } = await import(
  "@/commands/exportPackageCommands"
);

function makeLabels() {
  const video = { filename: "/data/mice.mp4", backend: {}, hasEmbeddedImages: false };
  const l: Record<string, unknown> = {
    _slpLayout: "v3",
    videos: [video],
    labeledFrames: [{ video, frameIdx: 0, isUserLabeled: true }],
    suggestions: [],
  };
  l.extract = () => l;
  return l as never;
}

beforeEach(() => {
  calls.length = 0;
  platform.isTauri = false;
  opfs.supported = false;
});

afterEach(() => {
  delete (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
});

describe("exportLabelsPackage SLP format forwarding", () => {
  it("forwards slpVersion & unlabeledAs in-memory and restores _slpLayout on level='full'", async () => {
    const labels = makeLabels();
    await ExportFullPackageCommand.execute(
      { state: { labels, filename: "mice.slp" } } as never,
      { slpVersion: "v2", unlabeledAs: "absent" },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("memory");
    expect(calls[0].opts.slpVersion).toBe("v2");
    expect(calls[0].opts.unlabeledAs).toBe("absent");
    // Open project's remembered layout stays v3!
    expect((labels as { _slpLayout?: string })._slpLayout).toBe("v3");
  });

  it("forwards slpVersion & unlabeledAs to desktop streaming writer", async () => {
    platform.isTauri = true;
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = true;
    await exportLabelsPackage(makeLabels(), "mice.slp", "training", {
      slpVersion: "v2",
      unlabeledAs: "error",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("stream");
    expect(calls[0].opts.slpVersion).toBe("v2");
    expect(calls[0].opts.unlabeledAs).toBe("error");
  });

  it("forwards slpVersion & unlabeledAs to Chromium OPFS writer", async () => {
    opfs.supported = true;
    await exportLabelsPackage(makeLabels(), "mice.slp", "user", {
      slpVersion: "v3",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("opfs");
    expect(calls[0].opts.slpVersion).toBe("v3");
    expect(calls[0].opts.unlabeledAs).toBeUndefined();
  });
});
