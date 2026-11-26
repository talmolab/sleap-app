/**
 * A draft of a project whose file is in SLP format 3.0 records its format,
 * summary, and access mode (`"keep"` for native 3.0 saves, `"edit"` for
 * legacy 2.x downgrade), and recovery restores them. In addition, the
 * imageless draft itself serializes format 3.0 natively so unlabeled nodes
 * and metadata survive crash recovery.
 */
import { describe, it, expect } from "../bun-test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSlp, type Format3Summary, type Labels } from "@talmolab/sleap-io.js";
import {
  isUnlabeledPoint,
  metadataOf,
  restoreSourceFormat,
  sourceFormatRecord,
} from "@/lib/slpFormat";
import { serializeLabelsDraft } from "@/lib/labelsDraft";
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
  unreadTables: [],
  lossless: false,
};

const FIXTURE = join(import.meta.dir, "../fixtures/format3_unlabeled.slp");
const labelsWith = (sourceFormat: unknown): Labels =>
  ({ videos: [], sourceFormat }) as unknown as Labels;

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
  it("records the file's format, drop summary, and access mode while in format 3.0", () => {
    const kept = labelsWith({ formatId: 3, access: "keep", summary: SUMMARY, labelsPath: "/data/x.slp" });
    expect(sourceFormatRecord(kept)).toEqual({ formatId: 3, summary: SUMMARY, access: "keep" });
    const edited = labelsWith({ formatId: 3, access: "edit", summary: SUMMARY, labelsPath: "/data/x.slp" });
    expect(sourceFormatRecord(edited)).toEqual({ formatId: 3, summary: SUMMARY, access: "edit" });
    expect(sourceFormatRecord(labelsWith(null))).toBeUndefined();
  });

  it("restores sourceFormat on recovery, defaulting legacy draft records to native keep", () => {
    const recoveredKeep = labelsWith(null);
    restoreSourceFormat(recoveredKeep, { formatId: 3, summary: SUMMARY }, "/data/x.slp");
    const sfKeep = recoveredKeep.sourceFormat;
    expect(sfKeep).toEqual({ formatId: 3, access: "keep", summary: SUMMARY, labelsPath: "/data/x.slp" });
    expect(Object.isFrozen(sfKeep)).toBe(true);

    const recoveredEdit = labelsWith(null);
    restoreSourceFormat(recoveredEdit, { formatId: 3, summary: SUMMARY, access: "edit" }, "/data/x.slp");
    expect(recoveredEdit.sourceFormat?.access).toBe("edit");
  });

  it("an older draft without it restores as before", () => {
    const recovered = labelsWith(null);
    restoreSourceFormat(recovered, undefined, "/data/x.slp");
    expect(recovered.sourceFormat).toBeNull();
  });

  it("survives the desktop manifest's parse", () => {
    const json = JSON.stringify({
      version: 1,
      entries: [entry({ sourceFormat: { formatId: 3, summary: SUMMARY, access: "keep" } })],
    });
    expect(parseManifest(json)[0].sourceFormat).toEqual({
      formatId: 3,
      summary: SUMMARY,
      access: "keep",
    });
  });

  it("is dropped by the next draft save once the file is in the 2.x layout", () => {
    const prior = entry({ sourceFormat: { formatId: 3, summary: SUMMARY, access: "edit" } });
    expect(mergeDraftEntry(prior, entry({ sourceFormat: undefined })).sourceFormat).toBeUndefined();
    expect(
      mergeDraftEntry(prior, entry({ sourceFormat: { formatId: 3, summary: SUMMARY, access: "keep" } }))
        .sourceFormat,
    ).toEqual({
      formatId: 3,
      summary: SUMMARY,
      access: "keep",
    });
  });

  it("serializeLabelsDraft preserves format 3.0 unlabeled nodes and metadata across reload", async () => {
    const original = await loadSlp(new Uint8Array(readFileSync(FIXTURE)), { openVideos: false });
    expect(original.sourceFormat?.access).toBe("keep");
    const draftBytes = await serializeLabelsDraft(original);
    const reloaded = await loadSlp(draftBytes, { openVideos: false, format3: "keep" });
    expect(reloaded.sourceFormat?.formatId).toBe(3);
    expect(reloaded.sourceFormat?.access).toBe("keep");
    const lf0 = reloaded.labeledFrames.find((f) => f.frameIdx === 0)!;
    expect(metadataOf(lf0)).toEqual({ note: "frame note" });
    const inst0 = lf0.instances[0];
    expect(metadataOf(inst0)).toEqual({ annotator: "someone" });
    expect(isUnlabeledPoint(inst0.points[2])).toBe(true);
  });
});
