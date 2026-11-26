/**
 * Fast IN-PLACE label save (desktop/Tauri).
 *
 * Re-save an existing embedded `.pkg.slp` by patching ONLY its small label
 * tables (frames/instances/points/pred_points/negative_frames) + the `/metadata`
 * `json` attribute, NEVER reading or re-copying the multi-GB embedded
 * `video{i}/video` groups. On a network share this is ~100x faster than a full
 * re-save (which round-trips every embedded image byte just to change a few
 * point coordinates). Companion to `saveEmbeddedPkgStreaming.ts` (the full
 * streaming re-save) — this is the fast path the caller tries FIRST for an
 * in-place save of an already-embedded project.
 *
 * DATA SAFETY: unlike the streaming writer, this path writes the user's REAL
 * file directly — there is NO temp-then-rename, because the whole point is to
 * avoid rewriting the file. That is safe ONLY for an edit that is confined to
 * the label tables (+ metadata), which is exactly what the io
 * `checkInPlaceWritable` gate proves before we touch a byte:
 *   - We PROBE the on-disk file (via the read-only range reader) to learn its
 *     label-table layouts and its sidecars (tracks/suggestions/videos/metadata).
 *   - We ask the gate whether the current `labels` differ from the file ONLY in
 *     the label tables. If not (a track/video/metadata/etc. change, or a
 *     Python-written enum-point file h5wasm can't patch), the gate refuses and
 *     we return `{ok:false}` so the caller falls back to a full re-save.
 *   - Only on an OK gate do we open the file for writing and patch it.
 * A gate refusal or a PROBE failure returns `{ok:false}` (nothing was written —
 * safe to fall through). A failure DURING/AFTER the write begins THROWS: an
 * in-place write cannot be rolled back, so the contract is loud detection — the
 * post-write verify reopens the file and asserts the tables read back correctly,
 * and any inconsistency surfaces as an error ("save may be inconsistent — reopen
 * to check") rather than a silent corruption.
 *
 * Requires cross-origin isolation (SharedArrayBuffer) like the streaming writer:
 * both the probe/verify range reader and the write B-seam need it. When it is
 * unavailable we simply return `{ok:false}` (fall through), since we have not
 * written anything.
 */
import {
  buildLabelTableUpdate,
  buildExpectedSidecars,
  buildMetadataJson,
  buildVideoSignatures,
  checkInPlaceWritable,
  onDiskColumnTableFromMeta,
  onDiskTableFromMeta,
  SlpViewOnlyError,
  StreamingH5File,
  StreamingH5Writer,
  type DatasetMetaLike,
  type RangeSink,
  type RangeSource,
  type Labels,
  type Video,
  type LabelTableUpdate,
  type OnDiskTable,
  type OnDiskTables,
  type OnDiskSidecars,
} from "@talmolab/sleap-io.js";
import {
  withNativeWriteHandle,
  writeOpenAppend,
  writeAt,
  readAt,
  truncateFile,
  writeClose,
} from "./nativeWrite";
import { fileSize, readRange } from "./nativeRange";

// Same derivation as loadProject.ts / saveEmbeddedPkgStreaming.ts: h5wasm must be
// served same-origin so the streaming Worker can load it under cross-origin
// isolation (COEP blocks the default cross-origin CDN importScripts).
const H5WASM_URL =
  typeof location !== "undefined" ? `${location.origin}/h5wasm/h5wasm.js` : undefined;

/** The five mutable label tables, in the order the gate/verify iterate them. */
const LABEL_TABLES = [
  "frames",
  "instances",
  "points",
  "pred_points",
  "negative_frames",
] as const;

/** Is cross-origin isolation (SharedArrayBuffer) available? Both the range
 *  reader (probe/verify) and the write B-seam require it. */
function hasCrossOriginIsolation(): boolean {
  return (
    typeof SharedArrayBuffer !== "undefined" &&
    !!(globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated
  );
}

/** A raw HDF5 string value (dataset element or attribute) can arrive as a plain
 *  string, a `Uint8Array`/`ArrayBuffer` (fixed-length `|S<n>`), or a
 *  `{ value }` wrapper (worker-serialized). Decode to a JS string, or undefined.
 *  Mirrors io `attrToString`. */
function decodeH5String(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  if (typeof raw === "string") return raw;
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
  if (raw instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(raw));
  if (typeof raw === "object" && "value" in raw) {
    return decodeH5String((raw as { value: unknown }).value);
  }
  return undefined;
}

/** Normalize an on-disk JSON string to compare byte-exactly against a freshly
 *  serialized one: strip the trailing NULs a fixed-length HDF5 string carries,
 *  and surrounding whitespace (JSON.stringify output has none, so this only ever
 *  removes storage padding). Mirrors io `trimHdf5String`. */
function normJsonString(s: string): string {
  return s.trim().replace(/\0+$/, "");
}

/** Coerce a streaming-reader dataset `.value` (array, typed array, or lone
 *  scalar) into a plain `string[]` of trimmed JSON strings — the on-disk form of
 *  `tracks_json` / `suggestions_json` / `videos_json`. */
function toJsonStringArray(value: unknown): string[] {
  let items: unknown[];
  if (Array.isArray(value)) items = value;
  else if (ArrayBuffer.isView(value)) items = Array.from(value as unknown as ArrayLike<unknown>);
  else if (typeof value === "string") items = [value]; // lone scalar (single element)
  else return [];
  const out: string[] = [];
  for (const item of items) {
    const s = decodeH5String(item);
    if (s !== undefined) out.push(normJsonString(s));
  }
  return out;
}

/** Read a root-level JSON-string dataset (e.g. `tracks_json`) via the range
 *  reader, or `null` when the dataset is absent (matches io's null-means-absent
 *  sidecar convention; the gate treats null as an empty array). */
async function readJsonStringDataset(
  reader: StreamingH5File,
  name: string
): Promise<string[] | null> {
  if (!reader.keys().includes(name)) return null;
  const { value } = await reader.getDatasetValue(name);
  return toJsonStringArray(value);
}

/**
 * Reconstruct per-video signatures for the on-disk `videos_json`, matching what
 * io `buildVideoSignatures(labels.videos)` produces for the live videos when the
 * video set is UNCHANGED (so the gate's confinement check passes for a pure pose
 * edit). Each signature is `{filename, shape, embedded}`:
 *  - embedded ⟺ the stored `filename` is "." (io `read.ts` sets `embedded=true`
 *    and rewrites the live `video.filename` to the labels path in that case), so
 *    an embedded video's signature filename is `destPath` — the same value the
 *    live embedded `video.filename` carries for an in-place save over the open
 *    file.
 *  - shape comes straight from `backend.shape`; the app's embed writer records
 *    the live backend shape there and stamps NO divergent `frames` attr, so the
 *    reloaded `video.shape` equals it exactly.
 * NON-embedded (external) videos use the raw stored path, which the live side
 * may have RESOLVED against the labels dir — a benign mismatch that only routes
 * the save to the (always-correct) full re-save. Python-written files never
 * reach the video check: their enum points refuse at the gate first.
 */
function buildOnDiskVideoSignatures(
  videosJson: string[] | null,
  destPath: string
): string[] | null {
  if (!videosJson) return null;
  const videoLikes: Video[] = [];
  for (const entry of videosJson) {
    let parsed: { filename?: unknown; backend?: { filename?: unknown; shape?: unknown } };
    try {
      parsed = JSON.parse(entry);
    } catch {
      return null; // unparseable → cannot prove the video set is unchanged → refuse
    }
    const backend = parsed.backend ?? {};
    const rawName =
      typeof backend.filename === "string"
        ? backend.filename
        : typeof parsed.filename === "string"
          ? parsed.filename
          : "";
    const embedded = rawName === ".";
    const filename = embedded ? destPath : rawName;
    const shape = Array.isArray(backend.shape) ? (backend.shape as number[]) : null;
    // buildVideoSignatures only reads .filename / .shape / .hasEmbeddedImages.
    videoLikes.push({
      filename,
      shape,
      hasEmbeddedImages: embedded,
    } as unknown as Video);
  }
  return buildVideoSignatures(videoLikes);
}

/** What the probe learned about the on-disk file (all read read-only). */
interface OnDiskProbe {
  tables: OnDiskTables;
  sidecars: OnDiskSidecars;
  /** File size (bytes) at probe time — reused to seed the write handle instead
   *  of a second `fileSize` call (that second call is the only differential
   *  failure vs the full-write path). */
  size: number;
}

/**
 * Probe an SLP format 3.0 column-group table (`/{name}/{col}` + optional
 * `/{name}/metadata/{key}/{values,present}`) via the read-only range reader
 * and turn it into the `OnDiskTable` (`layout: "columns"`) the gate expects.
 * Returns `undefined` when `{name}` has no column datasets (not a column table).
 */
async function probeColumnTable(
  reader: StreamingH5File,
  name: (typeof LABEL_TABLES)[number],
): Promise<OnDiskTable | undefined> {
  if (typeof reader.getKeys !== "function") return undefined;
  let children: string[];
  try {
    children = await reader.getKeys(name);
  } catch {
    return undefined;
  }
  const columns: Record<string, DatasetMetaLike> = {};
  for (const child of children) {
    if (child === "metadata") continue;
    try {
      const colMeta = await reader.getDatasetMeta(`${name}/${child}`);
      if (Array.isArray(colMeta.shape)) {
        columns[child] = {
          shape: colMeta.shape,
          metadata: colMeta.metadata as DatasetMetaLike["metadata"],
        };
      }
    } catch {
      /* subgroup or unreadable child — skip */
    }
  }
  if (Object.keys(columns).length === 0) return undefined;

  let tableMetadata:
    | Record<string, { values: DatasetMetaLike; kindAttr?: unknown; present: boolean }>
    | undefined;
  if (name === "instances" || name === "frames") {
    tableMetadata = {};
    if (children.includes("metadata")) {
      const metaKeys: string[] = await reader.getKeys(`${name}/metadata`).catch(() => []);
      for (const key of metaKeys) {
        const keyChildren: string[] = await reader.getKeys(`${name}/metadata/${key}`).catch(() => []);
        if (!keyChildren.includes("values")) continue;
        try {
          const valuesMeta = await reader.getDatasetMeta(`${name}/metadata/${key}/values`);
          if (!Array.isArray(valuesMeta.shape)) continue;
          let kindAttr: unknown;
          try {
            const attrs = await reader.getAttrs(`${name}/metadata/${key}/values`);
            kindAttr = decodeH5String(attrs["kind"]);
          } catch {
            kindAttr = undefined;
          }
          tableMetadata[key] = {
            values: {
              shape: valuesMeta.shape,
              metadata: valuesMeta.metadata as DatasetMetaLike["metadata"],
            },
            kindAttr,
            present: keyChildren.includes("present"),
          };
        } catch {
          /* unreadable metadata entry — skip */
        }
      }
    }
  }
  return onDiskColumnTableFromMeta(columns, tableMetadata);
}

/**
 * PROBE the existing file at `path` via the read-only range reader: read the
 * label tables' on-disk layouts (2.x datasets or format 3.0 column groups) and
 * the sidecars (tracks/suggestions/videos signatures + `/metadata` json) the
 * gate needs. Read-only — never opens a write handle.
 */
async function probeOnDisk(path: string): Promise<OnDiskProbe> {
  const size = await fileSize(path);
  const source: RangeSource = { size, readRange: (o, l) => readRange(path, o, l) };
  const reader = new StreamingH5File();
  await reader.openRange(source, { h5wasmUrl: H5WASM_URL });
  try {
    // Label-table layouts. Absent tables are omitted (⇒ the gate skips their
    // resizability check; the writer creates a resizable one on demand).
    const tables: OnDiskTables = {};
    const keyOf: Record<string, keyof OnDiskTables> = {
      frames: "frames",
      instances: "instances",
      points: "points",
      pred_points: "predPoints",
      negative_frames: "negativeFrames",
    };
    for (const name of LABEL_TABLES) {
      if (!reader.keys().includes(name)) continue;
      const meta = await reader.getDatasetMeta(name);
      // getDatasetMeta types `metadata` as Record<string, unknown>; narrow it to
      // the layout shape onDiskTableFromMeta reads (chunks ⇒ resizable,
      // compound_type.members ⇒ compound layout / enum detection).
      let table: OnDiskTable | undefined = onDiskTableFromMeta({
        shape: meta.shape,
        metadata: meta.metadata as DatasetMetaLike["metadata"],
      });
      // When `name` is an HDF5 Group (no dataset shape), probe it as a format
      // 3.0 column table (`/{name}/{col}` + optional `/{name}/metadata`).
      if (!table) {
        table = await probeColumnTable(reader, name);
      }
      if (!table) {
        throw new Error(`/${name} is not a table this in-place save can patch`);
      }
      tables[keyOf[name]] = table;
    }

    // Sidecars: tracks/suggestions JSON string arrays, video signatures, and the
    // /metadata json attribute.
    const tracksJson = await readJsonStringDataset(reader, "tracks_json");
    const suggestionsJson = await readJsonStringDataset(reader, "suggestions_json");
    const videosJson = await readJsonStringDataset(reader, "videos_json");

    let metadataJson: string | null = null;
    try {
      const attrs = await reader.getAttrs("metadata");
      const s = decodeH5String(attrs["json"]);
      metadataJson = s !== undefined ? normJsonString(s) : null;
    } catch {
      metadataJson = null; // missing/corrupt metadata group — treated as changed
    }

    const sidecars: OnDiskSidecars = {
      tracksJson,
      suggestionsJson,
      metadataJson,
      videos: buildOnDiskVideoSignatures(videosJson, path),
    };
    return { tables, sidecars, size };
  } finally {
    await reader.close().catch(() => {});
  }
}

/** Extract the first two numeric values of a streaming-reader dataset row value,
 *  across the layouts `getDatasetValue` can return (nested rows, flat/typed
 *  array, or a compound `{col: array}` object). Returns null if it can't be
 *  interpreted (the value spot-check then skips rather than false-failing). */
function firstTwoNumbers(value: unknown, xField: string, yField: string): [number, number] | null {
  const asNum = (v: unknown): number | null => {
    const n = typeof v === "bigint" ? Number(v) : typeof v === "number" ? v : NaN;
    return Number.isFinite(n) ? n : null;
  };
  // Compound columns: { x: [...], y: [...] }
  if (value && typeof value === "object" && !Array.isArray(value) && !ArrayBuffer.isView(value)) {
    const obj = value as Record<string, unknown>;
    const xs = obj[xField];
    const ys = obj[yField];
    if (Array.isArray(xs) && Array.isArray(ys)) {
      const a = asNum(xs[0]);
      const b = asNum(ys[0]);
      return a != null && b != null ? [a, b] : null;
    }
    return null;
  }
  // Nested rows: [[x, y, ...], ...]
  if (Array.isArray(value) && Array.isArray(value[0])) {
    const a = asNum((value[0] as unknown[])[0]);
    const b = asNum((value[0] as unknown[])[1]);
    return a != null && b != null ? [a, b] : null;
  }
  // Flat (typed) array of the single sliced row: [x, y, ...]
  if (Array.isArray(value) || ArrayBuffer.isView(value)) {
    const arr = value as ArrayLike<unknown>;
    const a = asNum(arr[0]);
    const b = asNum(arr[1]);
    return a != null && b != null ? [a, b] : null;
  }
  return null;
}

/** Extract the first finite number from a 1-D column slice value. */
function firstNumber(value: unknown): number | null {
  const raw =
    Array.isArray(value) || ArrayBuffer.isView(value)
      ? (value as ArrayLike<unknown>)[0]
      : value;
  const n = typeof raw === "bigint" ? Number(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * POST-WRITE VERIFY: reopen the just-written file via the READ-ONLY range reader
 * (a path fully independent of the writer) and assert it is internally
 * consistent with `update`:
 *  - the file opens and every patched label table reads back with the EXACTLY
 *    expected row count; and
 *  - the sidecars we did NOT rewrite (tracks/suggestions/videos) are unchanged
 *    from what we probed pre-write.
 * Best-effort bonus: spot-check that `points` row 0 reads back the value we
 * wrote. THROWS on any mismatch — an in-place write cannot be rolled back, so a
 * failed verify must surface loudly ("save may be inconsistent — reopen to
 * check") instead of being masked.
 */
async function verifyInPlace(
  path: string,
  update: LabelTableUpdate,
  preWrite: OnDiskSidecars
): Promise<void> {
  const size = await fileSize(path);
  const source: RangeSource = { size, readRange: (o, l) => readRange(path, o, l) };
  const reader = new StreamingH5File();
  await reader.openRange(source, { h5wasmUrl: H5WASM_URL });
  try {
    const isV3 = update.layout === "v3";
    // 1. Row counts of every patched table match the update.
    const expectedRows: Array<[string, string[], number]> = [
      ["frames", update.frames.fields, update.frames.rows.length],
      ["instances", update.instances.fields, update.instances.rows.length],
      ["points", update.points.fields, update.points.rows.length],
      ["pred_points", update.predPoints.fields, update.predPoints.rows.length],
    ];
    if (update.negativeFrames) {
      expectedRows.push([
        "negative_frames",
        update.negativeFrames.fields,
        update.negativeFrames.rows.length,
      ]);
    }
    for (const [name, fields, want] of expectedRows) {
      const present = reader.keys().includes(name);
      // An empty table the writer intentionally never created is fine (want 0).
      if (!present) {
        if (want !== 0) {
          throw new Error(
            `in-place verify: table "${name}" is missing after write (expected ${want} rows) — save may be inconsistent, reopen to check`
          );
        }
        continue;
      }
      const metaPath = isV3 && fields[0] ? `${name}/${fields[0]}` : name;
      const meta = await reader.getDatasetMeta(metaPath);
      const got = meta.shape[0] ?? 0;
      if (got !== want) {
        throw new Error(
          `in-place verify: table "${name}" has ${got} rows, expected ${want} — save may be inconsistent, reopen to check`
        );
      }
    }

    // 2. Sidecars we did NOT rewrite must be byte-identical to the probe.
    const post: OnDiskSidecars = {
      tracksJson: await readJsonStringDataset(reader, "tracks_json"),
      suggestionsJson: await readJsonStringDataset(reader, "suggestions_json"),
      metadataJson: null, // metadata MAY have been intentionally rewritten; not checked here
      videos: buildOnDiskVideoSignatures(
        await readJsonStringDataset(reader, "videos_json"),
        path
      ),
    };
    const sameArray = (a: string[] | null, b: string[] | null): boolean => {
      const aa = a ?? [];
      const bb = b ?? [];
      if (aa.length !== bb.length) return false;
      return aa.every((v, i) => v === bb[i]);
    };
    if (!sameArray(post.tracksJson, preWrite.tracksJson)) {
      throw new Error(
        "in-place verify: tracks_json changed after write — save may be inconsistent, reopen to check"
      );
    }
    if (!sameArray(post.suggestionsJson, preWrite.suggestionsJson)) {
      throw new Error(
        "in-place verify: suggestions_json changed after write — save may be inconsistent, reopen to check"
      );
    }
    if (!sameArray(post.videos, preWrite.videos)) {
      throw new Error(
        "in-place verify: videos_json changed after write — save may be inconsistent, reopen to check"
      );
    }

    // 3. Best-effort value spot-check: points row 0 reads back what we wrote.
    // Never false-fails — skips (logs) if the value shape can't be interpreted.
    const wantRow0 = update.points.rows[0];
    if (
      wantRow0 &&
      Number.isFinite(wantRow0[0]) &&
      Number.isFinite(wantRow0[1]) &&
      reader.keys().includes("points")
    ) {
      try {
        let got: [number, number] | null = null;
        if (isV3) {
          const [xRes, yRes] = await Promise.all([
            reader.getDatasetValue(`points/${update.points.fields[0]}`, [[0, 1]]),
            reader.getDatasetValue(`points/${update.points.fields[1]}`, [[0, 1]]),
          ]);
          const gx = firstNumber(xRes.value);
          const gy = firstNumber(yRes.value);
          got = gx != null && gy != null ? [gx, gy] : null;
        } else {
          const meta = await reader.getDatasetMeta("points");
          const md = meta.metadata as { compound_type?: { members?: unknown[] } } | undefined;
          const compound = !!md?.compound_type?.members;
          const cols = update.points.fields.length;
          const slice: Array<[number, number] | []> = compound
            ? [[0, 1]]
            : [[0, 1], [0, cols]];
          const { value } = await reader.getDatasetValue("points", slice);
          got = firstTwoNumbers(value, update.points.fields[0], update.points.fields[1]);
        }
        if (got) {
          const close = (a: number, b: number) => Math.abs(a - b) <= 1e-3;
          if (!close(got[0], wantRow0[0]) || !close(got[1], wantRow0[1])) {
            throw new Error(
              `in-place verify: points[0] read back [${got[0]}, ${got[1]}], expected [${wantRow0[0]}, ${wantRow0[1]}] — save may be inconsistent, reopen to check`
            );
          }
        } else {
          console.log(
            "[saveLabelsInPlace] verify: could not interpret points value for spot-check; relying on row-count + sidecar verify"
          );
        }
      } catch (err) {
        // Only re-throw a real mismatch (message tagged above); a read/shape
        // hiccup in the OPTIONAL spot-check must not mask a successful save.
        if (err instanceof Error && /save may be inconsistent/.test(err.message)) throw err;
        console.log("[saveLabelsInPlace] verify: value spot-check skipped:", err);
      }
    }
  } finally {
    await reader.close().catch(() => {});
  }
}

/**
 * Try to save `labels` over the existing embedded `.pkg.slp` at `destPath` by
 * patching only its label tables in place (see the module header).
 *
 * @returns `{ok:true}` when the in-place save succeeded AND verified;
 *   `{ok:false, reason}` when it is not applicable (gate refused, cross-origin
 *   isolation unavailable, or the probe could not read the file) — the caller
 *   should fall back to a full re-save. THROWS if a failure occurs once the
 *   in-place write has begun (the file may be inconsistent and cannot be rolled
 *   back — surface it loudly).
 */
export async function saveLabelsInPlace(
  labels: Labels,
  destPath: string
): Promise<{ ok: true } | { ok: false; reason: string }> {
  // Labels opened View only are never written. Throw rather than return
  // {ok:false}, which would send the caller on to a full re-save.
  const sourceFormat = labels.sourceFormat ?? null;
  const formatName = (id: number) => (Number.isInteger(id) ? id.toFixed(1) : String(id));
  if (sourceFormat?.access === "view") {
    if (typeof SlpViewOnlyError === "function") {
      throw new SlpViewOnlyError(sourceFormat);
    }
    const err = new Error(
      `${destPath} is open View only (SLP format ${formatName(sourceFormat.formatId)}); nothing was written.`
    );
    err.name = "SlpViewOnlyError";
    throw err;
  }
  // Labels opened explicitly for 2.x conversion (`access === "edit"`) cannot
  // patch a format 3.0 file in place; route to full re-save in the 2.x layout.
  // Labels opened natively (`access === "keep"`) proceed into the format 3.0
  // column-in-place probe/gate/write path below.
  if (sourceFormat?.access === "edit") {
    return {
      ok: false,
      reason: `opened from SLP format ${formatName(sourceFormat.formatId)} for 2.x conversion — full re-save in the 2.x layout`,
    };
  }
  if (!hasCrossOriginIsolation()) {
    return {
      ok: false,
      reason: "cross-origin isolation unavailable (SharedArrayBuffer) — full re-save",
    };
  }

  // 1. PROBE the on-disk file (read-only). A probe failure means we can't prove
  // the edit is confined, so refuse (nothing written — safe to fall through).
  let probe: OnDiskProbe;
  try {
    probe = await probeOnDisk(destPath);
  } catch (err) {
    return {
      ok: false,
      reason: `probe of ${destPath} failed (${err instanceof Error ? err.message : String(err)})`,
    };
  }

  // 2+3. Build the update + expected sidecars, then GATE. This whole region runs
  // BEFORE any byte is written, so a failure here must return {ok:false} (safe
  // fall-through to a full re-save) — NOT throw. Throws are reserved strictly for
  // the write region below (once the file may have been modified), per the module
  // header's contract. buildLabelTableUpdate carries the /metadata json ONLY when
  // it actually changed, so a value-only pose edit leaves the attr untouched (and
  // the gate's metadata check passes either way).
  let update: LabelTableUpdate;
  let metadataChanged: boolean;
  try {
    const newMetadataJson = buildMetadataJson(labels);
    metadataChanged = probe.sidecars.metadataJson !== newMetadataJson;
    update = buildLabelTableUpdate(
      labels,
      metadataChanged ? { metadataJson: newMetadataJson } : {}
    );
    const expected = buildExpectedSidecars(labels);
    const gate = checkInPlaceWritable(update, probe.tables, {
      onDisk: probe.sidecars,
      expected,
    });
    if (!gate.ok) {
      console.log(`[saveLabelsInPlace] not in-place-writable: ${gate.reason}`);
      return gate;
    }
  } catch (err) {
    return {
      ok: false,
      reason: `in-place pre-write gate failed (${err instanceof Error ? err.message : String(err)})`,
    };
  }

  // 4. WRITE IN PLACE. From here on the user's real file is being modified, so
  // any failure after the first write THROWS (no silent fall-through — see the
  // module header). For format 3.0 column updates, sleap-io.js validates every
  // column and string metadata value BEFORE writing any byte and reports
  // pre-write refusals with "in-place save: ... - re-save the whole file instead",
  // which safely falls back to a full re-save. Reuse the size the probe already
  // measured rather than a second fileSize() round-trip.
  const destSize = probe.size;
  let preWriteRefusal: string | null = null;
  // Exclusive use of the app's one native write handle (an export may hold it).
  await withNativeWriteHandle(async () => {
    await writeOpenAppend(destPath); // open existing WITHOUT truncating
    const destSink: RangeSink = {
      writeAt: (o, b) => writeAt(o, b),
      readAt: (o, l) => readAt(o, l),
      truncate: (l) => truncateFile(l),
      close: () => writeClose(),
    };
    const writer = new StreamingH5Writer();
    try {
      await writer.openWrite(destSink, destPath, destSize, H5WASM_URL);
      const res = await writer.updateLabelsInPlace(update);
      if (res.success !== true) {
        if (
          update.layout === "v3" &&
          typeof res.error === "string" &&
          /^in-place save: .*re-save the whole file instead$/i.test(res.error)
        ) {
          preWriteRefusal = res.error;
          return;
        }
        throw new Error(
          `saveLabelsInPlace: updateLabelsInPlace failed: ${res.error ?? JSON.stringify(res)}`
        );
      }
    } finally {
      // Belt-and-suspenders close, mirroring the streaming writer: close the
      // worker first (flushes h5wasm through the bridge), then the native handle.
      await writer.close().catch(() => {});
      await writeClose().catch(() => {});
    }
  });
  if (preWriteRefusal) {
    console.log(`[saveLabelsInPlace] not in-place-writable: ${preWriteRefusal}`);
    return { ok: false, reason: preWriteRefusal };
  }
  console.log(
    `[saveLabelsInPlace] patched label tables in place -> ${destPath}` +
      (metadataChanged ? " (+ /metadata)" : "")
  );

  // 5. POST-WRITE VERIFY (required backstop; throws loud on any inconsistency).
  await verifyInPlace(destPath, update, probe.sidecars);
  console.log(`[saveLabelsInPlace] verify OK -> ${destPath}`);
  return { ok: true };
}
