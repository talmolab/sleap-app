/**
 * Thin integration test for the DESKTOP (Tauri) branch of the debounced labels
 * auto-save (labelsAutosave.ts). It asserts the CONTROL FLOW + the one design
 * invariant that distinguishes desktop from browser: a desktop draft write is a
 * pure crash-recovery net, so it must NEVER mark the project clean
 * (`hasChanges` stays true — ⌘S owns the disk file). The actual disk write +
 * manifest are covered by tauriDraft/tauriDraftManifest; here `@/lib/tauriDraft`
 * is mocked so we exercise wiring, not I/O.
 *
 * Follows the repo's bun-test mock caveat: mock BEFORE importing the module under
 * test, which is imported dynamically (statically it would bind to the real one).
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";
import type { Labels } from "@talmolab/sleap-io.js";

let draftPathToMint = "/appdata/sleap-drafts/sleap-draft-train-abc.slp";
const newTauriDraftPathMock = vi.fn(async () => draftPathToMint);
const recordTauriDraftSaveMock = vi.fn(async () => {});

// isTauri drives the runtime branch — force the desktop path.
vi.mock("@/lib/platform", () => ({
  isTauri: true,
  isMac: false,
  modKey: "Ctrl",
}));
vi.mock("@/lib/tauriDraft", () => ({
  newTauriDraftPath: newTauriDraftPathMock,
  recordTauriDraftSave: recordTauriDraftSaveMock,
}));
// Defensive: keep any transitive toast importer off the real toaster.
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

const { maybeAutosaveLabelsDraft } = await import("@/lib/labelsAutosave");
const { useAppStore } = await import("@/stores/appStore");

/** Minimal fake Labels — the Tauri autosave only truthy-checks `labels` and
 *  hands it to the (mocked) recorder; `.videos` is read only by the real
 *  recorder, which is mocked out here. */
function fakeLabels(): Labels {
  return { videos: [] } as unknown as Labels;
}

function callArg(
  m: { mock: { calls: unknown[][] } },
  call: number,
  idx: number,
): unknown {
  return m.mock.calls[call][idx];
}

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
  draftPathToMint = "/appdata/sleap-drafts/sleap-draft-train-abc.slp";
  newTauriDraftPathMock.mockClear();
  recordTauriDraftSaveMock.mockClear();
});

describe("maybeAutosaveLabelsDraft — desktop (Tauri) branch", () => {
  it("does nothing when the project is not dirty", async () => {
    useAppStore.setState({
      labels: fakeLabels(),
      hasChanges: false,
      isLoading: false,
      projectPath: null,
      filename: "train.slp",
    });
    await maybeAutosaveLabelsDraft();
    expect(recordTauriDraftSaveMock).not.toHaveBeenCalled();
  });

  it("does nothing while a load/save is in progress", async () => {
    useAppStore.setState({
      labels: fakeLabels(),
      hasChanges: true,
      isLoading: true,
      projectPath: null,
      filename: "train.slp",
    });
    await maybeAutosaveLabelsDraft();
    expect(recordTauriDraftSaveMock).not.toHaveBeenCalled();
  });

  it("saves a draft when dirty WITHOUT marking the project clean", async () => {
    useAppStore.setState({
      labels: fakeLabels(),
      hasChanges: true,
      isLoading: false,
      projectPath: null, // null → skips the source-snapshot stat (no Tauri fs)
      filename: "train.slp",
      labelsDraftPath: null,
    });

    await maybeAutosaveLabelsDraft();

    // Minted a new draft path and recorded the draft.
    expect(newTauriDraftPathMock).toHaveBeenCalledTimes(1);
    expect(recordTauriDraftSaveMock).toHaveBeenCalledTimes(1);
    expect(callArg(recordTauriDraftSaveMock, 0, 1)).toMatchObject({
      draftPath: draftPathToMint,
      projectPath: null,
      displayName: "train.slp",
    });
    // Committed the draft path so continued edits + a later ⌘S target it.
    expect(useAppStore.getState().labelsDraftPath).toBe(draftPathToMint);
    // THE KEY INVARIANT: desktop draft is only a net → still dirty vs disk.
    expect(useAppStore.getState().hasChanges).toBe(true);
  });

  it("reuses an already-minted draft path instead of minting a new one", async () => {
    const existing = "/appdata/sleap-drafts/sleap-draft-existing-xyz.slp";
    useAppStore.setState({
      labels: fakeLabels(),
      hasChanges: true,
      isLoading: false,
      projectPath: null,
      filename: "train.slp",
      labelsDraftPath: existing,
    });

    await maybeAutosaveLabelsDraft();

    expect(newTauriDraftPathMock).not.toHaveBeenCalled();
    expect(callArg(recordTauriDraftSaveMock, 0, 1)).toMatchObject({
      draftPath: existing,
    });
    expect(useAppStore.getState().labelsDraftPath).toBe(existing);
  });
});
