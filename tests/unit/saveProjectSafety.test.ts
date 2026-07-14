/**
 * Safety-guard tests for the embed-preserving save flow (#213, PR #214 add-ons).
 *
 * These cover the two save-aborting early returns and the atomic in-place write
 * that this PR layers ON TOP of tom's `planEmbedPreservingSave` logic. They are
 * pure orchestration tests: the real HDF5 encode/decode never runs — a real
 * `.pkg.slp` is never opened or written (device verification is gated on the
 * user's explicit approval, which hasn't been given).
 *
 * Mock strategy (bun `mock.module` via the `vi` shim; see tests/bun-test.ts):
 *   - `@talmolab/sleap-io.js` → keep every real export (so tom's
 *     `planEmbedPreservingSave` and its `SuggestionFrame` stay real) but swap
 *     `saveSlpToBytes` / `loadSlp` for fakes we can drive.
 *   - `@/platform/index` → a fake Tauri platform whose `writeFile` / `rename`
 *     are spies (so we can assert whether disk was touched).
 *   - `@/lib/notify` → quiet, assertable toasts.
 *
 * `useAppStore` is the REAL singleton (shared with the module-under-test), so we
 * drive `isRangeLoaded` / `projectPath` / `hasChanges` through it directly.
 *
 * Per the shim caveat, the module-under-test is imported DYNAMICALLY inside each
 * test, AFTER the mocks are registered.
 */

import { describe, it, expect, beforeEach, vi } from "../bun-test";
import { useAppStore } from "@/stores/appStore";
import type { Labels } from "@talmolab/sleap-io.js";
import * as realSleapIo from "@talmolab/sleap-io.js";

// Snapshot the REAL sleap-io exports now, before any mock is registered, so the
// per-test mock can re-export everything real (SuggestionFrame, Labels, …) and
// override only the two functions we need to control.
const REAL_IO = { ...realSleapIo };

// Quiet, assertable toasts (saveProject imports `toast` from @/lib/notify).
vi.mock("@/lib/notify", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

/** A backend-bearing embedded video whose embedded frames are [1,2,3]. */
function makeEmbeddedVideo() {
  return { hasEmbeddedImages: true, backend: {}, embeddedFrameIndices: [1, 2, 3] };
}

/**
 * A minimal fake Labels for an embedded (pkg.slp) project. Every embedded frame
 * is also a labeled frame with user instances, so tom's plan marks nothing as
 * unreadable and adds no temporary suggestions (no real SuggestionFrame is
 * constructed) — keeping these tests focused on the new guards.
 */
function makeEmbeddedLabels() {
  const video = makeEmbeddedVideo();
  const labeledFrames = video.embeddedFrameIndices.map((frameIdx) => ({
    video,
    frameIdx,
    hasUserInstances: true,
  }));
  return {
    labels: { videos: [video], suggestions: [], labeledFrames } as unknown as Labels,
    video,
  };
}

/** Register a fake platform + sleap-io mock; return the spies for assertions. */
function mockDeps(opts: {
  isTauri?: boolean;
  saveBytes?: Uint8Array;
  reloadedEmbeddedIndices?: number[];
}) {
  const writeFile = vi.fn(async (_path: string, _data: Uint8Array) => {});
  const rename = vi.fn(async (_oldPath: string, _newPath: string) => {});
  const saveSlpToBytes = vi.fn(
    async () => opts.saveBytes ?? new Uint8Array([1, 2, 3, 4])
  );
  const loadSlp = vi.fn(async () => ({
    videos: [{ embeddedFrameIndices: opts.reloadedEmbeddedIndices ?? [1, 2, 3] }],
  }));

  vi.mock("@/platform/index", () => ({
    getPlatform: vi.fn(async () => ({
      isTauri: opts.isTauri ?? true,
      readFile: vi.fn(),
      writeFile,
      rename,
      showOpenDialog: vi.fn(async () => null),
      showSaveDialog: vi.fn(async () => null),
      exists: vi.fn(async () => false),
    })),
  }));
  vi.mock("@talmolab/sleap-io.js", () => ({
    ...REAL_IO,
    saveSlpToBytes,
    loadSlp,
  }));

  return { writeFile, rename, saveSlpToBytes, loadSlp };
}

async function toastMock() {
  const { toast } = await import("@/lib/notify");
  return toast as unknown as {
    success: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

describe("saveProjectAsSlp — safety guards (#213)", () => {
  beforeEach(async () => {
    resetStore();
    const toast = await toastMock();
    toast.success.mockClear();
    toast.error.mockClear();
  });

  it("size-guard: refuses to re-save a range-loaded embedded project (no encode, no write)", async () => {
    const { labels } = makeEmbeddedLabels();
    const store = useAppStore.getState();
    store.set("isRangeLoaded", true);
    store.set("projectPath", "/data/huge.pkg.slp");

    const { saveSlpToBytes, writeFile, rename } = mockDeps({ isTauri: true });
    const toast = await toastMock();

    const { saveProjectAsSlp } = await import("@/lib/saveProject");
    await saveProjectAsSlp(labels);

    // Refused BEFORE building bytes or touching disk.
    expect(saveSlpToBytes).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
    // hasChanges is never cleared on an aborted save.
    expect(useAppStore.getState().hasChanges).toBe(false);
    expect(useAppStore.getState().isLoading).toBe(false);
  });

  it("post-save verify: aborts before writing when the output would drop embedded frames", async () => {
    const { labels } = makeEmbeddedLabels();
    const store = useAppStore.getState();
    store.set("isRangeLoaded", false);
    store.set("projectPath", "/data/proj.pkg.slp");
    store.set("hasChanges", true);

    // in=3 embedded frames, but the reloaded output only has 2 → data loss.
    const { saveSlpToBytes, loadSlp, writeFile, rename } = mockDeps({
      isTauri: true,
      reloadedEmbeddedIndices: [1, 2],
    });
    const toast = await toastMock();

    const { saveProjectAsSlp } = await import("@/lib/saveProject");
    await saveProjectAsSlp(labels);

    // Encoding + verification ran, but the write was refused.
    expect(saveSlpToBytes).toHaveBeenCalled();
    expect(loadSlp).toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
    // clearChanges() is never reached, so hasChanges stays true.
    expect(useAppStore.getState().hasChanges).toBe(true);
  });

  it("happy path: verified save writes to a temp file then atomically renames over the original", async () => {
    const { labels } = makeEmbeddedLabels();
    const store = useAppStore.getState();
    store.set("isRangeLoaded", false);
    store.set("projectPath", "/data/proj.pkg.slp");
    store.set("hasChanges", true);

    // Reloaded output keeps all 3 embedded frames → verification passes.
    const { saveSlpToBytes, loadSlp, writeFile, rename } = mockDeps({
      isTauri: true,
      reloadedEmbeddedIndices: [1, 2, 3],
    });
    const toast = await toastMock();

    const { saveProjectAsSlp } = await import("@/lib/saveProject");
    await saveProjectAsSlp(labels);

    expect(saveSlpToBytes).toHaveBeenCalled();
    expect(loadSlp).toHaveBeenCalled();
    // Atomic replace: temp write THEN rename over the original path. (The shim's
    // vi.fn erases mock arg types, so String() the captured args — matching the
    // pattern in skeletonPanelLoadSave.test.ts.)
    const tmpPath = "/data/proj.pkg.slp.saving.tmp";
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(String(writeFile.mock.calls[0][0])).toBe(tmpPath);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(String(rename.mock.calls[0][0])).toBe(tmpPath);
    expect(String(rename.mock.calls[0][1])).toBe("/data/proj.pkg.slp");
    // Success path: changes cleared, no error toast.
    expect(useAppStore.getState().hasChanges).toBe(false);
    expect(toast.success).toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
