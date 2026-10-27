/**
 * Export Labels Package shows the app's progress overlay (with Cancel) while it
 * reads and embeds frame images (tens of seconds for a continuous video),
 * driven by io's `onProgress`, and always clears it — before the Save dialog,
 * on failure, and on cancel. On desktop it asks where to save FIRST and streams
 * the package to that file (as PyQt SLEAP); elsewhere it builds the package in
 * memory and saves it afterwards. io's save, the streaming writer, the platform
 * and the file dialog are mocked; `vi.mock` isn't hoisted here, so the module
 * under test is imported after the mocks are registered.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "../bun-test";
import { useAppStore } from "@/stores/appStore";

type Progress = (current: number, total: number, message?: string) => unknown;
type SaveOpts = { embed?: string; onProgress?: Progress };

class ExportCancelled extends Error {}

let saveImpl: (labels: unknown, opts: SaveOpts) => Promise<Uint8Array>;
let streamImpl: (labels: unknown, dest: string, source: unknown, opts: SaveOpts) => Promise<void>;
let dialogResult: string | null;
const platform = { isTauri: false };
const order: string[] = [];
const prepared: unknown[][] = [];
const overlayDuringSave: Array<{ loading: boolean; message: string; progress: number }> = [];
const toastError = vi.fn();
const toastSuccess = vi.fn();
const toastInfo = vi.fn();

vi.mock("@talmolab/sleap-io.js", () => ({
  ExportCancelled,
  saveSlpToBytes: (labels: unknown, opts: SaveOpts) => {
    order.push("saveSlpToBytes");
    return saveImpl(labels, opts);
  },
  loadSlp: async () => ({ videos: [] }),
}));
vi.mock("@/lib/saveEmbeddedPkgStreaming", () => ({
  saveEmbeddedPkgStreaming: (labels: unknown, dest: string, source: unknown, opts: SaveOpts) => {
    order.push("stream");
    return streamImpl(labels, dest, source, opts);
  },
}));
vi.mock("@/platform/index", () => ({
  getPlatform: async () => ({
    isTauri: platform.isTauri,
    showSaveDialog: async () => {
      order.push("dialog");
      // Nothing is running yet: no overlay behind the native dialog.
      expect(useAppStore.getState().isLoading).toBe(false);
      return dialogResult;
    },
  }),
}));
vi.mock("@/commands/fileCommands", () => ({
  saveBytesFile: async () => {
    order.push("saveBytesFile");
    // The overlay must be gone before the native Save dialog opens.
    const s = useAppStore.getState();
    overlayDuringSave.push({ loading: s.isLoading, message: s.loadingMessage, progress: s.loadingProgress });
    return "/out/labels.pkg.slp";
  },
}));
vi.mock("@/lib/resolveVideos", () => ({
  prepareVideosForFrameReads: async (videos: unknown[]) => {
    order.push("prepare");
    prepared.push(videos);
  },
}));
vi.mock("@/lib/notify", () => ({
  toast: { success: toastSuccess, error: toastError, warning: vi.fn(), info: toastInfo },
}));

const { exportLabelsPackage } = await import("@/commands/exportPackageCommands");

/** Minimal labels: `labelsForLevel("full")` passes them straight through. */
const labels = { videos: [], labeledFrames: [], suggestions: [] } as never;

/** A desktop window that can stream (worker + SharedArrayBuffer). */
function onDesktop() {
  platform.isTauri = true;
  (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated = true;
}

beforeEach(() => {
  useAppStore.getState().setLoading(false);
  platform.isTauri = false;
  dialogResult = "/data/out.pkg.slp";
  overlayDuringSave.length = 0;
  order.length = 0;
  prepared.length = 0;
  toastError.mockClear();
  toastSuccess.mockClear();
  toastInfo.mockClear();
});
afterEach(() => {
  delete (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
});

describe("exportLabelsPackage progress (in memory: browser, or already-embedded videos)", () => {
  it("shows embedding progress from io, then clears it before the Save dialog", async () => {
    const seen: Array<{ message: string; progress: number }> = [];
    saveImpl = async (_l, opts) => {
      expect(useAppStore.getState().isLoading).toBe(true);
      for (let i = 1; i <= 4; i++) {
        opts.onProgress?.(i, 4, "Embedding frames");
        const s = useAppStore.getState();
        seen.push({ message: s.loadingMessage, progress: s.loadingProgress });
      }
      return new Uint8Array([1]);
    };
    await exportLabelsPackage(labels, "labels.slp", "full");

    expect(seen.at(-1)).toEqual({ message: "Embedding frames (4/4)", progress: 100 });
    expect(seen[1]).toEqual({ message: "Embedding frames (2/4)", progress: 50 });
    expect(overlayDuringSave).toEqual([{ loading: false, message: "", progress: 0 }]);
    expect(useAppStore.getState().isLoading).toBe(false);
  });

  it("opens and readies the embedded videos for off-main reads before embedding", async () => {
    const video = { filename: "/data/mice.mp4" };
    const withVideo = {
      videos: [video, { filename: "/data/unused.mp4" }],
      labeledFrames: [{ video, frameIdx: 0, isUserLabeled: true }],
      suggestions: [],
    } as never;
    saveImpl = async () => {
      // The overlay is already up while videos are prepared and read.
      expect(useAppStore.getState().isLoading).toBe(true);
      return new Uint8Array([1]);
    };
    await exportLabelsPackage(withVideo, "labels.slp", "full");

    expect(order).toEqual(["prepare", "saveSlpToBytes", "saveBytesFile"]);
    expect(prepared).toEqual([[video]]);
  });

  it("clears the overlay when embedding fails, and reports the error", async () => {
    saveImpl = async () => {
      throw new Error('Couldn\'t read 1 frame image(s) from "mice.mp4" to embed (frame 2538).');
    };
    await exportLabelsPackage(labels, "labels.slp", "full");

    expect(useAppStore.getState().isLoading).toBe(false);
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("Cancel makes io's onProgress return false; nothing is saved and no error shows", async () => {
    saveImpl = async (_l, opts) => {
      expect(opts.onProgress?.(1, 3)).toBe(true);
      const cancel = useAppStore.getState().loadingCancel;
      expect(cancel).not.toBeNull();
      cancel!();
      if (opts.onProgress?.(2, 3) === false) throw new ExportCancelled();
      return new Uint8Array([1]);
    };
    await exportLabelsPackage(labels, "labels.slp", "full");

    expect(order).not.toContain("saveBytesFile");
    expect(toastError).not.toHaveBeenCalled();
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().isLoading).toBe(false);
    expect(useAppStore.getState().loadingCancel).toBeNull();
  });
});

describe("exportLabelsPackage on desktop (streamed straight to the chosen file)", () => {
  /** Fake labels; `extract` (the user/training levels' frame subset) is a no-op. */
  const fakeLabels = (v: object) => {
    const l = {
      videos: [v],
      labeledFrames: [{ video: v, frameIdx: 0, isUserLabeled: true }],
      suggestions: [],
      extract: () => l,
    };
    return l as never;
  };
  const video = { filename: "/data/mice.mp4", backend: {}, hasEmbeddedImages: false };
  const mp4Labels = fakeLabels(video);

  it("asks where to save first, then streams the package there with progress", async () => {
    onDesktop();
    const seen: { args?: { dest: string; source: unknown; embed?: string } } = {};
    streamImpl = async (_l, dest, source, opts) => {
      expect(useAppStore.getState().isLoading).toBe(true);
      opts.onProgress?.(1, 2);
      expect(useAppStore.getState().loadingMessage).toBe("Embedding frames (1/2)");
      seen.args = { dest, source, embed: opts.embed };
    };
    await exportLabelsPackage(mp4Labels, "labels.slp", "training");

    expect(order).toEqual(["dialog", "prepare", "stream"]);
    expect(seen.args).toEqual({ dest: "/data/out.pkg.slp", source: null, embed: "user+suggestions" });
    expect(useAppStore.getState().isLoading).toBe(false);
    const [title, opts] = toastSuccess.mock.calls[0] as unknown as [
      string,
      { description: string; action?: { label: string } },
    ];
    expect(title).toBe("Labels package exported");
    expect(opts.description).toBe("/data/out.pkg.slp");
    expect(opts.action?.label).toBe("Show in folder");
  });

  it("does nothing when the Save dialog is cancelled", async () => {
    onDesktop();
    dialogResult = null;
    await exportLabelsPackage(mp4Labels, "labels.slp", "user");
    expect(order).toEqual(["dialog"]);
    expect(useAppStore.getState().isLoading).toBe(false);
  });

  it("reports a cancelled stream as cancelled, not as a failure", async () => {
    onDesktop();
    streamImpl = async () => {
      useAppStore.getState().loadingCancel!();
      throw new ExportCancelled();
    };
    await exportLabelsPackage(mp4Labels, "labels.slp", "user");
    expect(toastInfo).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("builds an already-embedded project's package in memory (its images copy from its own file)", async () => {
    onDesktop();
    const pkgLabels = fakeLabels({ filename: "/data/p.pkg.slp", backend: {}, hasEmbeddedImages: true });
    saveImpl = async () => new Uint8Array([1]);
    await exportLabelsPackage(pkgLabels, "p.pkg.slp", "user");
    expect(order).toEqual(["prepare", "saveSlpToBytes", "saveBytesFile"]);
  });
});
