/**
 * Thin integration test for the desktop SAVE ROUTING decision in
 * `saveProjectAsSlp` (saveProject.ts), focused on where the new fast in-place
 * label save (`saveLabelsInPlace`) sits in the decision tree:
 *
 *   - In-place save of an already-embedded pkg.slp → try `saveLabelsInPlace`
 *     FIRST; on `{ok:true}` we're done (no full re-save), on `{ok:false}` fall
 *     through to the EXISTING routing (streaming vs in-memory, per
 *     `shouldStreamEmbeddedSave`).
 *   - Save-As / non-embedded → never in-place.
 *
 * All the heavy collaborators (the io writer, the streaming writer, the native
 * file ops, the platform, toasts) are mocked — this asserts the CONTROL FLOW,
 * not the write mechanics (those are covered by the io class's own tests).
 *
 * Mock return values are driven through captured `let`s (reset per test) rather
 * than `.mockResolvedValue` — the bun-test `vi.fn` shim widens the impl to
 * `(...args: never[]) => unknown`, which makes `.mockResolvedValue` / the
 * `.mock.calls[i][j]` element types unusable without casts.
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";
import type { Labels } from "@talmolab/sleap-io.js";

// --- mutable mock outputs (reset in resetAll) --------------------------------
type InPlaceResult = { ok: true } | { ok: false; reason: string };
let inPlaceResult: InPlaceResult = { ok: true };
let inPlaceThrows = false; // simulate a mid-write failure (throw) from saveLabelsInPlace
let fileSizeResult = 1000; // bytes; small by default → in-memory path
let savePath: string | null = "/picked.pkg.slp";

// --- mocks (declared before importing the module under test) -----------------
const saveLabelsInPlaceMock = vi.fn(async () => {
  if (inPlaceThrows) throw new Error("simulated mid-write in-place failure");
  return inPlaceResult;
});
const toastErrorMock = vi.fn();
const saveEmbeddedPkgStreamingMock = vi.fn(async () => {});
const saveSlpToBytesMock = vi.fn(async () => new Uint8Array([1, 2, 3]));
const writeFileMock = vi.fn(async () => {});
const showSaveDialogMock = vi.fn(async () => savePath);
const renameFileMock = vi.fn(async () => {});
const removeFileMock = vi.fn(async () => {});
const fileSizeMock = vi.fn(async () => fileSizeResult);

vi.mock("@talmolab/sleap-io.js", () => ({
  saveSlpToBytes: saveSlpToBytesMock,
}));
vi.mock("@/lib/saveLabelsInPlace", () => ({
  saveLabelsInPlace: saveLabelsInPlaceMock,
}));
vi.mock("@/lib/saveEmbeddedPkgStreaming", () => ({
  saveEmbeddedPkgStreaming: saveEmbeddedPkgStreamingMock,
  tempPathFor: (p: string) => `${p}.sleap-tmp`,
}));
vi.mock("@/lib/nativeRange", () => ({
  fileSize: fileSizeMock,
  readRange: vi.fn(),
}));
vi.mock("@/lib/nativeWrite", () => ({
  renameFile: renameFileMock,
  removeFile: removeFileMock,
}));
vi.mock("@/platform/index", () => ({
  getPlatform: async () => ({
    isTauri: true,
    writeFile: writeFileMock,
    showSaveDialog: showSaveDialogMock,
  }),
}));
// saveProject imports `toast` from @/lib/notify; mock it directly so we get a
// clean handle on toast.error (avoids notify's wrapMethod → sonner indirection).
vi.mock("@/lib/notify", () => ({
  toast: { success: vi.fn(), error: toastErrorMock, info: vi.fn(), warning: vi.fn() },
}));
// Belt-and-suspenders: keep sonner mocked too so any OTHER transitive importer
// never reaches the real toaster (precedent: loadProgress.test.ts).
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { saveProjectAsSlp } from "@/lib/saveProject";
import { useAppStore } from "@/stores/appStore";

const THRESHOLD = 3 * 1024 * 1024 * 1024; // STREAMING_SAVE_THRESHOLD_BYTES

/** Typed access to a mock's Nth-call arg — the `vi.fn` shim erases the impl's
 *  param types, so the `.mock.calls[i][j]` element type needs a cast. */
function callArg(
  m: { mock: { calls: unknown[][] } },
  call: number,
  idx: number
): unknown {
  return m.mock.calls[call][idx];
}

/** Minimal fake Labels — only `.videos[].hasEmbeddedImages` is read by the
 *  router; the labels are otherwise passed straight to the (mocked) writers. */
function fakeLabels(embedded: boolean): Labels {
  return { videos: [{ hasEmbeddedImages: embedded }] } as unknown as Labels;
}

function resetAll() {
  useAppStore.setState(useAppStore.getInitialState());
  inPlaceResult = { ok: true };
  inPlaceThrows = false;
  fileSizeResult = 1000;
  savePath = "/picked.pkg.slp";
  for (const m of [
    saveLabelsInPlaceMock,
    saveEmbeddedPkgStreamingMock,
    saveSlpToBytesMock,
    writeFileMock,
    showSaveDialogMock,
    renameFileMock,
    removeFileMock,
    fileSizeMock,
    toastErrorMock,
  ]) {
    m.mockClear();
  }
}

describe("saveProjectAsSlp — in-place routing", () => {
  beforeEach(resetAll);

  it("in-place embedded save tries saveLabelsInPlace FIRST and stops on {ok:true}", async () => {
    useAppStore.setState({ projectPath: "/proj.pkg.slp" });
    inPlaceResult = { ok: true };

    await saveProjectAsSlp(fakeLabels(true), "proj.pkg.slp");

    expect(saveLabelsInPlaceMock).toHaveBeenCalledTimes(1);
    expect(callArg(saveLabelsInPlaceMock, 0, 1)).toBe("/proj.pkg.slp");
    // Fast path won → NO full re-save of any kind.
    expect(saveEmbeddedPkgStreamingMock).not.toHaveBeenCalled();
    expect(saveSlpToBytesMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
  });

  it("falls through to the IN-MEMORY full re-save when in-place returns {ok:false} (small file)", async () => {
    useAppStore.setState({ projectPath: "/proj.pkg.slp" });
    inPlaceResult = { ok: false, reason: "tracks changed" };
    fileSizeResult = 1000; // below threshold → in-memory

    await saveProjectAsSlp(fakeLabels(true), "proj.pkg.slp");

    expect(saveLabelsInPlaceMock).toHaveBeenCalledTimes(1);
    expect(saveEmbeddedPkgStreamingMock).not.toHaveBeenCalled();
    // In-memory embedded path: serialize + atomic write-temp-then-rename.
    expect(saveSlpToBytesMock).toHaveBeenCalledTimes(1);
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(renameFileMock).toHaveBeenCalledTimes(1);
    expect(callArg(renameFileMock, 0, 1)).toBe("/proj.pkg.slp"); // renamed over the original
  });

  it("falls through to the STREAMING full re-save when in-place returns {ok:false} (large file)", async () => {
    useAppStore.setState({ projectPath: "/big.pkg.slp" });
    inPlaceResult = { ok: false, reason: "video added" };
    fileSizeResult = THRESHOLD + 1; // above threshold → streaming

    await saveProjectAsSlp(fakeLabels(true), "big.pkg.slp");

    expect(saveLabelsInPlaceMock).toHaveBeenCalledTimes(1);
    expect(saveEmbeddedPkgStreamingMock).toHaveBeenCalledTimes(1);
    expect(callArg(saveEmbeddedPkgStreamingMock, 0, 1)).toBe("/big.pkg.slp"); // dest
    expect(callArg(saveEmbeddedPkgStreamingMock, 0, 2)).toBe("/big.pkg.slp"); // source
    expect(saveSlpToBytesMock).not.toHaveBeenCalled();
  });

  it("never tries in-place for a Save-As (forceDialog) — that path is always a full write", async () => {
    useAppStore.setState({ projectPath: "/proj.pkg.slp" });
    savePath = "/newname.pkg.slp";

    await saveProjectAsSlp(fakeLabels(true), "proj.pkg.slp", /* forceDialog */ true);

    expect(saveLabelsInPlaceMock).not.toHaveBeenCalled();
    expect(showSaveDialogMock).toHaveBeenCalledTimes(1);
    // Small file + embedded → in-memory atomic write to the picked path.
    expect(saveSlpToBytesMock).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().projectPath).toBe("/newname.pkg.slp");
  });

  it("does NOT full-rewrite (surfaces the error) when in-place THROWS mid-write", async () => {
    // SAFETY-CRITICAL regression: saveLabelsInPlace throws ONLY once the in-place
    // write has begun (the real file may already be partially modified and can't
    // be rolled back). The router must let that propagate to the error toast — it
    // must NOT catch it and silently full-rewrite over a possibly-inconsistent
    // file. Guards against a future refactor wrapping the call in try/catch.
    useAppStore.setState({ projectPath: "/proj.pkg.slp" });
    inPlaceThrows = true;

    await saveProjectAsSlp(fakeLabels(true), "proj.pkg.slp");

    expect(saveLabelsInPlaceMock).toHaveBeenCalledTimes(1);
    // No full re-save of any kind after a mid-write in-place throw.
    expect(saveEmbeddedPkgStreamingMock).not.toHaveBeenCalled();
    expect(saveSlpToBytesMock).not.toHaveBeenCalled();
    expect(writeFileMock).not.toHaveBeenCalled();
    expect(renameFileMock).not.toHaveBeenCalled();
    // The failure is surfaced to the user, not swallowed.
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
  });

  it("never tries in-place for a NON-embedded in-place save", async () => {
    useAppStore.setState({ projectPath: "/plain.slp" });

    await saveProjectAsSlp(fakeLabels(false), "plain.slp");

    expect(saveLabelsInPlaceMock).not.toHaveBeenCalled();
    // Non-embedded in-place: direct write (no atomic temp+rename needed).
    expect(saveSlpToBytesMock).toHaveBeenCalledTimes(1);
    expect(writeFileMock).toHaveBeenCalledTimes(1);
    expect(callArg(writeFileMock, 0, 0)).toBe("/plain.slp");
    expect(renameFileMock).not.toHaveBeenCalled();
  });
});
