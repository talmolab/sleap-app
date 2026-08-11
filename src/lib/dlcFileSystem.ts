/**
 * Browser/Tauri plumbing for DeepLabCut import.
 *
 * sleap-io.js's DLC reader is synchronous and reads many files inline (a
 * `config.yaml` + one-or-more CSVs + directory listings) through an injected
 * {@link DlcFileSystem}, but browser/Tauri file I/O is async. So we do the async
 * work UP FRONT — recursively enumerate the picked directory and pre-read every
 * small text file (`.csv`/`.yaml`) into a map — then hand the reader a
 * synchronous, map-backed `DlcFileSystem`. Image PIXELS are never pre-read; only
 * their paths are recorded (the reader existence-probes them, and the
 * image-sequence video backend reads bytes lazily on first view).
 *
 * See `docs/plans/2026-07-29-dlc-import-design.md`.
 */

import {
  readDlc,
  readDlcProject,
  isDlcData,
  PATH_VIDEO_MATCHER,
  type DlcFileSystem,
  type Labels,
} from "@talmolab/sleap-io.js";

/** Join POSIX-style path segments, preserving a leading slash. */
export function joinPosix(...parts: string[]): string {
  const first = parts.find((p) => p !== "" && p != null);
  const absolute = first != null && /^[/\\]/.test(first);
  const segs: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    for (const seg of part.split(/[/\\]+/)) if (seg) segs.push(seg);
  }
  const joined = segs.join("/");
  return absolute ? `/${joined}` : joined;
}

/**
 * Build a synchronous {@link DlcFileSystem} over an already-materialized tree.
 *
 * @param textByPath Absolute POSIX path -> UTF-8 content (config.yaml + CSVs).
 * @param extraPaths Paths that exist but are never read as text (frame images).
 * Directories are synthesized from the path prefixes of every entry.
 */
export function createDlcFileSystem(
  textByPath: Map<string, string>,
  extraPaths: Iterable<string> = [],
): DlcFileSystem {
  const files = new Set<string>([...textByPath.keys(), ...extraPaths]);
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i += 1) {
      const d = parts.slice(0, i).join("/");
      if (d !== "") dirs.add(d);
    }
  }
  return {
    exists: (p) => files.has(p) || dirs.has(p),
    isFile: (p) => files.has(p),
    isDirectory: (p) => dirs.has(p),
    readTextFile: (p) => {
      const t = textByPath.get(p);
      if (t === undefined) throw new Error(`ENOENT (dlc mem fs): ${p}`);
      return t;
    },
    readDir: (p) => {
      const prefix = `${p}/`;
      const names = new Set<string>();
      for (const entry of [...files, ...dirs]) {
        if (entry.startsWith(prefix)) {
          const name = entry.slice(prefix.length).split("/")[0];
          if (name) names.add(name);
        }
      }
      return [...names];
    },
  };
}

/** Extensions pre-read as text when enumerating a DLC directory. */
function isTextFile(name: string): boolean {
  const n = name.toLowerCase();
  return n.endsWith(".csv") || n.endsWith(".yaml") || n.endsWith(".yml");
}

/** Every `.csv` under `root` (recursive) whose content sniffs as a DLC CSV. */
export function listAllDlcCsvs(fs: DlcFileSystem, root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of fs.readDir(dir).sort()) {
      const p = joinPosix(dir, name);
      if (fs.isDirectory(p)) walk(p);
      else if (name.toLowerCase().endsWith(".csv") && dlcSniff(fs, p)) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out;
}

/** DLC CSVs exactly one folder deep (a CSV inside each immediate subdir of
 *  `root`) — the "Multiple DeepLabCut datasets from folder..." batch case
 *  (PyQt globs one level of subdirectories for their CSVs). */
export function listSubdirDlcCsvs(fs: DlcFileSystem, root: string): string[] {
  const out: string[] = [];
  for (const sub of fs.readDir(root).sort()) {
    const subDir = joinPosix(root, sub);
    if (!fs.isDirectory(subDir)) continue;
    for (const name of fs.readDir(subDir).sort()) {
      const p = joinPosix(subDir, name);
      if (name.toLowerCase().endsWith(".csv") && fs.isFile(p) && dlcSniff(fs, p)) {
        out.push(p);
      }
    }
  }
  return out;
}

function dlcSniff(fs: DlcFileSystem, p: string): boolean {
  try {
    return isDlcData(fs.readTextFile(p));
  } catch {
    return false;
  }
}

/**
 * Build merged {@link Labels} for a picked DLC directory.
 *
 * - `"single"` with `entryFile` (a file the user picked, e.g. on Tauri): a
 *   `.yaml`/`.yml` → that exact project config; any other file → that exact CSV.
 * - `"single"` without `entryFile` (e.g. a browser folder pick): a DLC project
 *   (`config.yaml` at `root`) → whole project; else a bare dataset folder → its
 *   DLC CSV(s).
 * - `"folder"`: a parent of dataset subdirs → load each `<root>/<subdir>/`'s CSV
 *   and merge into one project (unify skeleton/tracks by name, keep every
 *   distinct video), matching PyQt's `extend_from(unify=True)`.
 */
export async function buildDlcLabels(
  fs: DlcFileSystem,
  root: string,
  mode: "single" | "folder",
  entryFile?: string,
): Promise<Labels> {
  const mergeAll = async (csvs: string[]): Promise<Labels> => {
    const merged = readDlc(csvs[0], { fs });
    for (let i = 1; i < csvs.length; i += 1) {
      await merged.merge(readDlc(csvs[i], { fs }), {
        video: PATH_VIDEO_MATCHER,
        track: "name",
      });
    }
    return merged;
  };

  if (mode === "folder") {
    const csvs = listSubdirDlcCsvs(fs, root);
    if (csvs.length === 0) {
      throw new Error(
        "No DeepLabCut CSV files found one folder deep under the selected folder.",
      );
    }
    return mergeAll(csvs);
  }

  // single with an explicitly picked file: honor exactly what was chosen (a
  // .yaml is the project config — under ANY name; anything else is a lone CSV).
  if (entryFile) {
    return /\.ya?ml$/i.test(entryFile)
      ? readDlcProject(entryFile, { fs })
      : readDlc(entryFile, { fs });
  }

  // single (folder pick): a standard-named config.yaml → whole project, else
  // fall back to the DLC CSV(s) discovered under root.
  const configPath = joinPosix(root, "config.yaml");
  if (fs.exists(configPath) && fs.isFile(configPath)) {
    return readDlcProject(root, { fs });
  }
  const csvs = listAllDlcCsvs(fs, root);
  if (csvs.length === 0) {
    throw new Error(
      "No DeepLabCut CSV or config.yaml found in the selected folder.",
    );
  }
  return csvs.length === 1 ? readDlc(csvs[0], { fs }) : mergeAll(csvs);
}

/**
 * A leaf path under `root` (its `config.yaml` if present) whose dirname is
 * `root` — passed to `resolveExternalVideos` as `projectPath` so its
 * image-sequence auto-locate walks from `root` (an ancestor of every frame).
 */
export function dlcProjectPathHint(fs: DlcFileSystem, root: string): string {
  const configPath = joinPosix(root, "config.yaml");
  return fs.exists(configPath) ? configPath : joinPosix(root, "dataset");
}

// ---------------------------------------------------------------------------
// Directory enumerators (async I/O, per runtime). Each returns a ready
// map-backed DlcFileSystem; the browser one additionally retains File handles
// so image bytes can be read for rendering.
// ---------------------------------------------------------------------------

/** Minimal structural view of a File System Access directory handle. */
interface FsDirLike {
  name: string;
  entries(): AsyncIterableIterator<[string, FsHandleLike]>;
}
interface FsHandleLike {
  kind: "file" | "directory";
  getFile?: () => Promise<File>;
  entries?: () => AsyncIterableIterator<[string, FsHandleLike]>;
}

export interface BrowserDlcTree {
  root: string;
  fs: DlcFileSystem;
  /** Absolute POSIX path -> File, for every enumerated file (image reader). */
  fileByPath: Map<string, File>;
}

/**
 * Recursively enumerate a browser directory handle (File System Access API):
 * pre-read every `.csv`/`.yaml` as text, record all file paths, and retain a
 * `File` per path for later lazy image reads.
 */
export async function enumerateBrowserDlcDir(
  dirHandle: FsDirLike,
): Promise<BrowserDlcTree> {
  const root = dirHandle.name || "dlc";
  const textByPath = new Map<string, string>();
  const fileByPath = new Map<string, File>();

  const walk = async (dir: FsDirLike, prefix: string): Promise<void> => {
    for await (const [name, handle] of dir.entries()) {
      const p = joinPosix(prefix, name);
      if (handle.kind === "directory" && handle.entries) {
        await walk({ name, entries: handle.entries.bind(handle) }, p);
      } else if (handle.kind === "file" && handle.getFile) {
        const file = await handle.getFile();
        fileByPath.set(p, file);
        if (isTextFile(name)) textByPath.set(p, await file.text());
      }
    }
  };

  await walk(dirHandle, root);
  return {
    root,
    fs: createDlcFileSystem(textByPath, fileByPath.keys()),
    fileByPath,
  };
}

export interface TauriDlcTree {
  root: string;
  fs: DlcFileSystem;
}

/**
 * Recursively enumerate a directory on disk via the Tauri fs plugin: pre-read
 * every `.csv`/`.yaml` as text and record all file paths. Image bytes are read
 * later by the native image reader; only paths are recorded here.
 */
export async function enumerateTauriDlcDir(
  rootDir: string,
): Promise<TauriDlcTree> {
  const { readDir, readTextFile } = await import("@tauri-apps/plugin-fs");
  const root = rootDir.replace(/[\\/]+$/, "");
  const textByPath = new Map<string, string>();
  const filePaths: string[] = [];

  const walk = async (dir: string): Promise<void> => {
    const entries = await readDir(dir);
    for (const entry of entries) {
      const p = joinPosix(dir, entry.name);
      if (entry.isDirectory) {
        await walk(p);
      } else if (entry.isFile) {
        filePaths.push(p);
        if (isTextFile(entry.name)) {
          try {
            textByPath.set(p, await readTextFile(p));
          } catch {
            /* unreadable text file — skip (leave path as existing) */
          }
        }
      }
    }
  };

  await walk(root);
  return { root, fs: createDlcFileSystem(textByPath, filePaths) };
}
