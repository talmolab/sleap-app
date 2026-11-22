/**
 * A draft of a project whose file is still in SLP format 3.0 records that,
 * and recovery sets it again, so the in-place save and local jobs never patch
 * or read that file as it is. Older drafts, and drafts saved after the file
 * was rewritten in the 2.x layout, carry nothing and restore as before.
 */
import { describe, it, expect } from "../bun-test";
import type { Labels } from "@talmolab/sleap-io.js";
import {
  restoreSourceFormat,
  sourceFormatOf,
  sourceFormatRecord,
  type Format3Summary,
} from "@/lib/slpFormatCompat";
import {
  mergeDraftEntry,
  parseManifest,
  type TauriDraftManifestEntry,
} from "@/lib/tauriDraftManifest";

const SUMMARY: Format3Summary = {
  formatId: 3,
  unlabeledPoints: 1,
  unlabeledUserPoints: 1,
  unlabeledPredictedPoints: 0,
  metadataKeys: { instances: [], frames: ["note"], bboxes: [] },
  unknownColumns: [],
  lossless: false,
};

const labelsWith = (sourceFormat: unknown): Labels => ({ videos: [], sourceFormat }) as unknown as Labels;

const entry = (extra: Partial<TauriDraftManifestEntry> = {}): TauriDraftManifestEntry => ({
  draftPath: "/drafts/a.slp",
  projectPath: "/data/x.slp",
  displayName: "x.slp",
  savedAt: 1,
  videoCount: 0,
  videoSignatures: [],
  embedded: false,
  ...extra,
});

describe("the draft record of a format 3.0 project file", () => {
  it("is the file's format and drop summary while the file is still in format 3.0", () => {
    const labels = labelsWith({ formatId: 3, access: "edit", summary: SUMMARY, labelsPath: "/data/x.slp" });
    expect(sourceFormatRecord(labels)).toEqual({ formatId: 3, summary: SUMMARY });
    expect(sourceFormatRecord(labelsWith(null))).toBeUndefined();
  });

  it("is set again on recovery, for editing", () => {
    const recovered = labelsWith(null);
    restoreSourceFormat(recovered, { formatId: 3, summary: SUMMARY }, "/data/x.slp");
    const sf = sourceFormatOf(recovered);
    expect(sf).toEqual({ formatId: 3, access: "edit", summary: SUMMARY, labelsPath: "/data/x.slp" });
    expect(Object.isFrozen(sf)).toBe(true);
  });

  it("an older draft without it restores as before", () => {
    const recovered = labelsWith(null);
    restoreSourceFormat(recovered, undefined, "/data/x.slp");
    expect(sourceFormatOf(recovered)).toBeNull();
  });

  it("survives the desktop manifest's parse", () => {
    const json = JSON.stringify({ version: 1, entries: [entry({ sourceFormat: { formatId: 3, summary: SUMMARY } })] });
    expect(parseManifest(json)[0].sourceFormat).toEqual({ formatId: 3, summary: SUMMARY });
  });

  it("is dropped by the next draft save once the file is in the 2.x layout", () => {
    const prior = entry({ sourceFormat: { formatId: 3, summary: SUMMARY } });
    expect(mergeDraftEntry(prior, entry({ sourceFormat: undefined })).sourceFormat).toBeUndefined();
    expect(mergeDraftEntry(prior, entry({ sourceFormat: { formatId: 3, summary: SUMMARY } })).sourceFormat).toEqual({
      formatId: 3,
      summary: SUMMARY,
    });
  });
});
