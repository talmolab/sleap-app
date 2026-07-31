import { describe, it, expect } from "bun:test";
import {
  normalizeTauriDrafts,
  normalizeBrowserDrafts,
} from "@/lib/recoverableDrafts";
import type { TauriDraftManifestEntry } from "@/lib/tauriDraftManifest";
import type { DraftManifestEntry } from "@/lib/draftManifest";

function tauriEntry(
  over: Partial<TauriDraftManifestEntry>,
): TauriDraftManifestEntry {
  return {
    draftPath: "/data/sleap-drafts/a.slp",
    projectPath: "/p/a.slp",
    displayName: "a.slp",
    savedAt: 100,
    videoCount: 1,
    videoSignatures: [],
    embedded: false,
    ...over,
  };
}

function browserEntry(over: Partial<DraftManifestEntry>): DraftManifestEntry {
  return {
    draftPath: "opfs://a.slp",
    displayName: "a.slp",
    savedAt: 100,
    videoCount: 1,
    videoSignatures: [],
    embedded: false,
    sourceHandle: null,
    ...over,
  };
}

describe("recoverableDrafts normalization", () => {
  it("normalizes desktop (Tauri) entries to the shared card shape", () => {
    const out = normalizeTauriDrafts([
      tauriEntry({ draftPath: "/d/a.slp", displayName: "a.slp", savedAt: 100 }),
      tauriEntry({ draftPath: "/d/b.slp", displayName: "b.slp", savedAt: 200 }),
    ]);
    expect(out.map((d) => d.key)).toEqual(["/d/a.slp", "/d/b.slp"]);
    expect(out.map((d) => d.displayName)).toEqual(["a.slp", "b.slp"]);
    expect(out.map((d) => d.savedAt)).toEqual([100, 200]);
    // restore/discard are thin closures over the tested per-runtime helpers.
    expect(typeof out[0].restore).toBe("function");
    expect(typeof out[0].discard).toBe("function");
  });

  it("normalizes browser (OPFS) entries to the shared card shape", () => {
    const out = normalizeBrowserDrafts([
      browserEntry({ draftPath: "opfs://x.slp", displayName: "x.slp", savedAt: 300 }),
    ]);
    expect(out[0].key).toBe("opfs://x.slp");
    expect(out[0].displayName).toBe("x.slp");
    expect(out[0].savedAt).toBe(300);
    expect(typeof out[0].restore).toBe("function");
    expect(typeof out[0].discard).toBe("function");
  });

  it("returns an empty list when there are no drafts (either runtime)", () => {
    expect(normalizeTauriDrafts([])).toEqual([]);
    expect(normalizeBrowserDrafts([])).toEqual([]);
  });
});
