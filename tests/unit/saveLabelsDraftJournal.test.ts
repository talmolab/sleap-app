/**
 * Browser ⌘S on a large embedded pkg rewrites the OPFS labels draft (the
 * incremental autosave's base). The delta journal beside it must be emptied
 * too: its records predate the new base, and replaying them over it on
 * recovery would revert the newest edits. The OPFS/IndexedDB leaves are
 * mocked; this asserts the save flow, not the storage mechanics.
 */
import { describe, it, expect, vi } from "../bun-test";
import type { Labels } from "@talmolab/sleap-io.js";

const order: string[] = [];
const recordDraftSaveMock = vi.fn(async () => {
  order.push("recordDraftSave");
});
const truncateMock = vi.fn(async () => {
  order.push("truncate");
});
const journalPaths: string[] = [];

vi.mock("@/platform/index", () => ({
  getPlatform: async () => ({ isTauri: false }),
}));
vi.mock("@/lib/saveRouting", () => ({
  decideBrowserSaveAction: () => "save-labels-draft",
  shouldStreamEmbeddedSave: () => false,
}));
vi.mock("@/lib/saveEmbeddedPkgOpfs", () => ({
  saveEmbeddedPkgOpfs: vi.fn(),
  isOpfsSaveSupported: () => true,
  pickSlpSaveDestination: vi.fn(),
}));
vi.mock("@/lib/draftManifest", () => ({
  recordDraftSave: recordDraftSaveMock,
  deleteDraftEntry: vi.fn(async () => {}),
}));
vi.mock("@/lib/labelsDraft", () => ({
  newDraftPath: () => "sleap-draft-proj-1.slp",
  removeLabelsDraft: vi.fn(async () => {}),
  makeOpfsJournalStore: (path: string) => {
    journalPaths.push(path);
    return { truncate: truncateMock };
  },
}));
vi.mock("@/lib/notify", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import { saveProjectAsSlp } from "@/lib/saveProject";
import { useAppStore } from "@/stores/appStore";

describe("saveProjectAsSlp — browser labels-draft save", () => {
  it("empties the draft's autosave journal after rewriting the draft", async () => {
    useAppStore.setState(useAppStore.getInitialState());
    const labels = { videos: [{ hasEmbeddedImages: true }] } as unknown as Labels;

    await saveProjectAsSlp(labels, "proj.pkg.slp");

    expect(order).toEqual(["recordDraftSave", "truncate"]);
    expect(journalPaths).toEqual(["sleap-draft-proj-1.slp"]);
    expect(useAppStore.getState().labelsDraftPath).toBe("sleap-draft-proj-1.slp");
  });
});
