/**
 * Unit tests for the PURE desktop-draft path derivation. The Tauri filesystem +
 * app-data-dir leaves (recordTauriDraftSave / removeTauriDraft / draftsDir) touch
 * the real filesystem and are manual/tauri-pilot-verified — like the browser OPFS
 * leaves — so only the pure joining/derivation is unit-tested here.
 */
import { describe, it, expect } from "../bun-test";
import { joinDraftPath, tauriDraftPathFor, DRAFTS_DIR_NAME } from "@/lib/tauriDraft";

describe("joinDraftPath (pure)", () => {
  it("joins a filename onto a dir with a forward slash", () => {
    expect(joinDraftPath("/home/u/.local/share/app", "f.slp")).toBe(
      "/home/u/.local/share/app/f.slp",
    );
  });

  it("collapses a trailing separator on the dir (posix or windows)", () => {
    expect(joinDraftPath("/a/b/", "f.slp")).toBe("/a/b/f.slp");
    expect(joinDraftPath("C:\\Users\\me\\", "f.slp")).toBe("C:\\Users\\me/f.slp");
  });
});

describe("tauriDraftPathFor (pure)", () => {
  it("builds <dir>/sleap-draft-<slug>-<unique>.slp", () => {
    expect(tauriDraftPathFor("/data/drafts", "train.slp", "abc")).toBe(
      "/data/drafts/sleap-draft-train-abc.slp",
    );
  });

  it("keeps a .pkg segment and sanitizes the project name", () => {
    expect(tauriDraftPathFor("/data/drafts", "my project.pkg.slp", "9f")).toBe(
      "/data/drafts/sleap-draft-my-project.pkg-9f.slp",
    );
  });
});

describe("constants", () => {
  it("uses the sleap-drafts sub-directory", () => {
    expect(DRAFTS_DIR_NAME).toBe("sleap-drafts");
  });
});
