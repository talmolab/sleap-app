/**
 * No-SAB in-place confinement gate for the browser OPFS fast-save (working-copy
 * model).
 *
 * The desktop's `saveLabelsInPlace` proves an edit is confined to the label
 * tables by PROBING the on-disk file with the range reader (`StreamingH5File.
 * openRange`), which bridges async reads to h5wasm's sync device via a
 * SharedArrayBuffer — unavailable on GitHub Pages.
 *
 * We don't need that probe here: in the working-copy model WE seed the OPFS
 * working copy from a full `saveSlp…` write, so we already KNOW its on-disk
 * structure. We snapshot it once at seed time ({@link captureInPlaceBaseline})
 * and diff the current labels against that snapshot on each save
 * ({@link checkInPlaceWritableNoSab}) — reusing io's PURE gate
 * (`checkInPlaceWritable`) with no file read and no SharedArrayBuffer.
 *
 * Seed format is known: the app's writers create the label tables via
 * `createMatrixDataset(resizable=true)` → **flat, chunked (resizable),
 * non-enum**. So the gate's table-layout checks (enum refusal, resize-on-
 * contiguous refusal) always pass for our own working copy; a pose/point/track-
 * membership edit stays in-place, while a track/suggestion/video/metadata
 * structural change is refused → the caller re-seeds with a full save. The io
 * writer's post-resize assertion + the working copy being disposable are the
 * backstops if the seed format ever drifts.
 */
import {
  buildLabelTableUpdate,
  buildExpectedSidecars,
  buildMetadataJson,
  checkInPlaceWritable,
  type Labels,
  type LabelTableUpdate,
  type OnDiskTables,
  type OnDiskSidecars,
} from "@talmolab/sleap-io.js";

/**
 * The working copy's on-disk structure as WE wrote it — the no-SAB stand-in for
 * the desktop's file probe. Captured at seed time; advanced after each in-place
 * save so the next gate compares against the current on-disk state.
 */
export interface InPlaceBaseline {
  tables: OnDiskTables;
  sidecars: OnDiskSidecars;
}

/** In-place gate outcome. On `ok`, carries the update to write + whether the
 *  `/metadata` json changed (so the caller can patch that attr too). */
export type InPlaceGateResult =
  | { ok: true; update: LabelTableUpdate; metadataChanged: boolean }
  | { ok: false; reason: string };

/** The five label tables in `OnDiskTables`, paired with their `LabelTableUpdate`
 *  field, so the baseline reflects exactly the tables the update touches. */
const TABLE_KEYS = [
  ["frames", "frames"],
  ["instances", "instances"],
  ["points", "points"],
  ["predPoints", "predPoints"],
  ["negativeFrames", "negativeFrames"],
] as const;

/**
 * Snapshot the working copy's on-disk structure from the labels it was seeded
 * with. The file was written by a full `saveSlp…`, so its on-disk sidecars equal
 * `buildExpectedSidecars(labels)` exactly, and its label tables are flat +
 * chunked (resizable) — the format `createMatrixDataset(resizable=true)` writes.
 */
export function captureInPlaceBaseline(labels: Labels): InPlaceBaseline {
  const seed = buildLabelTableUpdate(labels);
  const tables: OnDiskTables = {};
  for (const [diskKey, updateKey] of TABLE_KEYS) {
    const t = seed[updateKey];
    if (!t) continue; // absent (e.g. no negative_frames) → gate creates on demand
    tables[diskKey] = {
      rows: t.rows.length,
      cols: t.fields.length,
      layout: "flat",
      chunked: true,
    };
  }
  return { tables, sidecars: buildExpectedSidecars(labels) };
}

/**
 * No-SAB in-place gate: decide whether `labels` can be saved into the working
 * copy by patching only the label tables, given the `baseline` captured at seed.
 * Reuses io's pure `checkInPlaceWritable` — no file read, no SharedArrayBuffer.
 * On `ok`, returns the `LabelTableUpdate` to write (and whether `/metadata`
 * changed). On refusal, the caller re-seeds with a full save.
 */
export function checkInPlaceWritableNoSab(
  labels: Labels,
  baseline: InPlaceBaseline,
): InPlaceGateResult {
  const newMetadataJson = buildMetadataJson(labels);
  const metadataChanged = baseline.sidecars.metadataJson !== newMetadataJson;
  const update = buildLabelTableUpdate(
    labels,
    metadataChanged ? { metadataJson: newMetadataJson } : undefined,
  );
  const expected = buildExpectedSidecars(labels);
  const gate = checkInPlaceWritable(update, baseline.tables, {
    onDisk: baseline.sidecars,
    expected,
  });
  if (!gate.ok) return gate;
  return { ok: true, update, metadataChanged };
}

/**
 * After a successful in-place patch the working copy now matches `labels` (the
 * patched label tables + any carried `/metadata`; the other sidecars were proven
 * unchanged by the gate). Re-capturing from `labels` keeps the baseline
 * authoritative for the next save.
 */
export function advanceBaselineAfterInPlaceSave(
  _baseline: InPlaceBaseline,
  labels: Labels,
): InPlaceBaseline {
  return captureInPlaceBaseline(labels);
}
