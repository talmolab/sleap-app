/**
 * On-disk JSON manifest of desktop (Tauri) labels drafts — the Tauri equivalent
 * of the browser's IndexedDB manifest ({@link import("@/lib/draftManifest")}).
 *
 * The browser records recoverable drafts in IndexedDB (keyed by OPFS path, with a
 * structured-cloneable `FileSystemFileHandle`) — both IndexedDB and file handles
 * are browser-only, so the desktop runtime needs its own store. Here that store is
 * a tiny JSON file next to the drafts on disk (`<appLocalData>/sleap-drafts/
 * draft-manifest.json`). Each entry records everything restore needs to re-open a
 * draft's labels and re-attach its images from the ORIGINAL project file: the
 * draft path, the original project's disk path, a display name, when it was saved,
 * a per-video signature list (for the embedded-pkg backend graft), and a
 * source-identity snapshot (size/mtime) so restore can detect an on-disk
 * divergence before re-linking the original for an in-place ⌘S.
 *
 * This module is the PURE + injectable-fs CORE (unit-tested): the manifest
 * serialize/parse/upsert/remove helpers, the "which draft (if any) should we offer
 * to recover?" decision, and read/write over an injected {@link TauriDraftFs}. The
 * real Tauri filesystem + path wiring lives in {@link import("@/lib/tauriDraft")},
 * which supplies a `TauriDraftFs` backed by `@tauri-apps/plugin-fs` (those leaves
 * are manual/tauri-pilot-verified, like the browser OPFS leaves).
 */

/** Minimal filesystem surface the manifest core needs; injected so it can be
 *  unit-tested with an in-memory fake (happy-dom has no Tauri fs). Mirrors the
 *  subset of `@tauri-apps/plugin-fs` used by the desktop draft store. */
export interface TauriDraftFs {
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readTextFile(path: string): Promise<string>;
  writeTextFile(path: string, contents: string): Promise<void>;
  remove(path: string): Promise<void>;
}

/** One recoverable desktop draft: enough to restore its labels + re-attach the
 *  original project's images. */
export interface TauriDraftManifestEntry {
  /** Absolute disk path of the imageless labels draft `.slp` (also the key). */
  draftPath: string;
  /** The ORIGINAL project's on-disk path (the image source + the ⌘S target), or
   *  null when the project had no disk path yet (never saved). */
  projectPath: string | null;
  /** Human-readable project name for the recover prompt. */
  displayName: string;
  /** Last-saved wall-clock time (ms) — used for newest-first ordering. */
  savedAt: number;
  /** Video count (kept for display/telemetry). */
  videoCount: number;
  /** Per-video identity signatures (see `@/lib/videoGraft` `videoSignature`), in
   *  draft-video order. Restore matches these against the re-opened original so it
   *  grafts the RIGHT embedded images (or leaves a video blank) even if the video
   *  set diverged. */
  videoSignatures: string[];
  /** Whether the project uses embedded images (a pkg.slp). Restore uses it to
   *  decide HOW to re-attach images: embedded → re-open the original + graft its
   *  backends by signature; not embedded → resolve external videos by path. */
  embedded: boolean;
  /** Original file's size (bytes) when the draft was saved — half of the identity
   *  snapshot restore uses to detect an on-disk divergence. Optional. */
  sourceSize?: number;
  /** Original file's mtime (ms epoch) when the draft was saved — the other half of
   *  the identity snapshot. Optional. */
  sourceLastModified?: number;
}

/** Schema version, so a future format change can be detected/migrated. */
export const MANIFEST_VERSION = 1;

interface ManifestFile {
  version: number;
  entries: TauriDraftManifestEntry[];
}

/** Serialize `entries` to the on-disk manifest JSON (pretty-printed for humans). */
export function serializeManifest(entries: TauriDraftManifestEntry[]): string {
  const file: ManifestFile = { version: MANIFEST_VERSION, entries };
  return JSON.stringify(file, null, 2);
}

/**
 * Parse manifest JSON into entries, tolerantly: malformed JSON, a wrong shape, or
 * a missing `entries` array all yield `[]` rather than throwing (a corrupt
 * manifest must never break launch — worst case, a draft isn't offered for
 * recovery). Entries missing the required `draftPath` string are dropped.
 */
export function parseManifest(json: string): TauriDraftManifestEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const entries = (parsed as ManifestFile | null)?.entries;
  if (!Array.isArray(entries)) return [];
  return entries.filter(
    (e): e is TauriDraftManifestEntry =>
      !!e && typeof (e as TauriDraftManifestEntry).draftPath === "string",
  );
}

/** Insert or replace the entry with a matching `draftPath` (keyed like the
 *  browser IndexedDB store). Pure — returns a new array. */
export function upsertManifestEntry(
  entries: TauriDraftManifestEntry[],
  entry: TauriDraftManifestEntry,
): TauriDraftManifestEntry[] {
  const rest = entries.filter((e) => e.draftPath !== entry.draftPath);
  return [...rest, entry];
}

/**
 * Merge a re-save's `next` entry onto the `prior` entry for the same draft,
 * PRESERVING durable fields the re-save didn't (re-)supply. Pure.
 *
 * `projectPath` in particular must survive a transient null: a resume while the
 * source volume was unmounted nulls `store.projectPath` (the `stat`/`exists`
 * probes fail), so the next autosave passes `projectPath: null`. Blindly writing
 * that would ERASE the original pkg's location and permanently orphan an embedded
 * draft from its images (the draft only ever refers to the container for embedded
 * frames). So a null path falls back to the prior one; only a real new path (a
 * genuine Save-As) overrides, and a never-saved project stays null. The
 * source-identity snapshot (`sourceSize`/`sourceLastModified`) is preserved the
 * same way (an autosave only captures it when minting).
 */
export function mergeDraftEntry(
  prior: TauriDraftManifestEntry | undefined,
  next: TauriDraftManifestEntry,
): TauriDraftManifestEntry {
  return {
    ...next,
    projectPath: next.projectPath ?? prior?.projectPath ?? null,
    sourceSize: next.sourceSize ?? prior?.sourceSize,
    sourceLastModified: next.sourceLastModified ?? prior?.sourceLastModified,
  };
}

/** Remove the entry with `draftPath` (e.g. after a real disk save or discard).
 *  Pure — returns a new array. */
export function removeManifestEntry(
  entries: TauriDraftManifestEntry[],
  draftPath: string,
): TauriDraftManifestEntry[] {
  return entries.filter((e) => e.draftPath !== draftPath);
}

/** Entries newest-saved first (does not mutate the input). */
export function sortEntriesNewestFirst(
  entries: TauriDraftManifestEntry[],
): TauriDraftManifestEntry[] {
  return [...entries].sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * Decide whether — and which — draft to offer for crash recovery on launch.
 *
 * A successful ⌘S / discard CLEARS both the draft file and its manifest entry, so
 * any entry whose draft file STILL EXISTS at launch means work was unsaved when
 * the app last stopped (a crash or an unsaved quit). Returns the NEWEST such entry
 * (the most recent unsaved session), or null if none of the recorded drafts still
 * exist on disk. Pure: existence is supplied via `draftExists` so the decision is
 * unit-testable without a real filesystem.
 */
export function pickRestorableDraft(
  entries: TauriDraftManifestEntry[],
  draftExists: (draftPath: string) => boolean,
): TauriDraftManifestEntry | null {
  for (const entry of sortEntriesNewestFirst(entries)) {
    if (draftExists(entry.draftPath)) return entry;
  }
  return null;
}

/**
 * Read + parse the manifest via an injected fs. A missing manifest file (or any
 * read/parse failure) yields `[]` — recovery is best-effort and must never throw
 * at launch.
 */
export async function readManifestWithFs(
  fs: TauriDraftFs,
  manifestPath: string,
): Promise<TauriDraftManifestEntry[]> {
  try {
    if (!(await fs.exists(manifestPath))) return [];
    return parseManifest(await fs.readTextFile(manifestPath));
  } catch {
    return [];
  }
}

/**
 * Write the manifest via an injected fs, creating `dirPath` first if absent. The
 * dir + manifest live together under the drafts directory.
 */
export async function writeManifestWithFs(
  fs: TauriDraftFs,
  dirPath: string,
  manifestPath: string,
  entries: TauriDraftManifestEntry[],
): Promise<void> {
  if (!(await fs.exists(dirPath))) await fs.mkdir(dirPath, { recursive: true });
  await fs.writeTextFile(manifestPath, serializeManifest(entries));
}
