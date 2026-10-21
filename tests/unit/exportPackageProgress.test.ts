/**
 * Export Labels Package shows the app's progress overlay while it reads and
 * embeds frame images (tens of seconds for a continuous video), driven by io's
 * `onProgress`, and always clears it — before the Save dialog, and on failure.
 * io's save and the file dialog are mocked; `vi.mock` isn't hoisted here, so the
 * module under test is imported after the mocks are registered.
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";
import { useAppStore } from "@/stores/appStore";

type Progress = (current: number, total: number, message?: string) => void;
let saveImpl: (labels: unknown, opts: { embed?: string; onProgress?: Progress }) => Promise<Uint8Array>;
const overlayDuringSave: Array<{ loading: boolean; message: string; progress: number }> = [];
const toastError = vi.fn();

vi.mock("@talmolab/sleap-io.js", () => ({
  saveSlpToBytes: (labels: unknown, opts: { embed?: string; onProgress?: Progress }) => saveImpl(labels, opts),
  loadSlp: async () => ({ videos: [] }),
}));
vi.mock("@/commands/fileCommands", () => ({
  saveBytesFile: async () => {
    // The overlay must be gone before the native Save dialog opens.
    const s = useAppStore.getState();
    overlayDuringSave.push({ loading: s.isLoading, message: s.loadingMessage, progress: s.loadingProgress });
    return "/out/labels.pkg.slp";
  },
}));
vi.mock("@/lib/notify", () => ({
  toast: { success: vi.fn(), error: toastError, warning: vi.fn(), info: vi.fn() },
}));

const { exportLabelsPackage } = await import("@/commands/exportPackageCommands");

/** Minimal labels: `labelsForLevel("full")` passes them straight through. */
const labels = { videos: [], labeledFrames: [], suggestions: [] } as never;

beforeEach(() => {
  useAppStore.getState().setLoading(false);
  overlayDuringSave.length = 0;
  toastError.mockClear();
});

describe("exportLabelsPackage progress", () => {
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

  it("clears the overlay when embedding fails, and reports the error", async () => {
    saveImpl = async () => {
      throw new Error('Couldn\'t read 1 frame image(s) from "mice.mp4" to embed (frame 2538).');
    };
    await exportLabelsPackage(labels, "labels.slp", "full");

    expect(useAppStore.getState().isLoading).toBe(false);
    expect(toastError).toHaveBeenCalledTimes(1);
  });
});
