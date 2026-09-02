/**
 * Discover trained sleap-nn models on disk for the overlay picker (#283).
 *
 * On open, the "Set Overlay Models" dialog scans the folder next to the loaded
 * project (and its `models/` subfolder) for trained model dirs — a dir with both
 * a `training_config.yaml` and a `best.ckpt` — and classifies each by head type
 * via {@link detectModelHead}. The Browse… escape hatch classifies a single
 * user-picked dir the same way.
 *
 * Filesystem access is injectable ({@link ScanFs}) so the assembly logic is
 * unit-testable without the Tauri runtime; the default reader lazily imports
 * `@tauri-apps/plugin-fs` (desktop-only — the overlay is desktop-only anyway).
 */

import { detectModelHead } from "@/lib/models/detectModel";
import type { ModelCatalogEntry } from "@/lib/models/overlayModelSelectionCore";

/** Minimal filesystem surface the scan needs (injectable for tests). */
export interface ScanFs {
  readDir(path: string): Promise<{ name: string; isDirectory: boolean }[]>;
  readTextFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
}

/** Result of classifying one directory (used by Browse…). `head` is null when the
 *  dir has no readable `training_config.yaml`; `trained` is whether `best.ckpt` exists. */
export interface ClassifiedModelDir {
  path: string;
  runName: string;
  head: string | null;
  trained: boolean;
}

const CONFIG_FILE = "training_config.yaml";
const CKPT_FILE = "best.ckpt";

/** The separator this path uses (Windows backslash only when there's no forward slash). */
function sep(p: string): "\\" | "/" {
  return p.includes("\\") && !p.includes("/") ? "\\" : "/";
}

/** Join `name` onto `dir` using `dir`'s own separator. */
export function joinPath(dir: string, name: string): string {
  const s = sep(dir);
  return dir.endsWith(s) ? dir + name : dir + s + name;
}

/** The parent directory of `p` (both separators). */
export function dirName(p: string): string {
  const s = sep(p);
  const i = p.lastIndexOf(s);
  return i <= 0 ? p : p.slice(0, i);
}

/** The last path segment of `p` (both separators). */
export function baseName(p: string): string {
  const s = sep(p);
  const i = p.lastIndexOf(s);
  return i < 0 ? p : p.slice(i + 1);
}

/** Where to look for models: the project's folder and its `models/` subfolder. */
export function overlayScanRoots(projectPath: string | null): string[] {
  if (!projectPath) return [];
  const dir = dirName(projectPath);
  return [dir, joinPath(dir, "models")];
}

/** Default {@link ScanFs} backed by the Tauri fs plugin (desktop-only at runtime). */
async function defaultFs(): Promise<ScanFs> {
  const { readDir, readTextFile, exists } = await import("@tauri-apps/plugin-fs");
  return {
    async readDir(path) {
      const entries = await readDir(path);
      return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory }));
    },
    readTextFile: (path) => readTextFile(path),
    exists: (path) => exists(path),
  };
}

/** Classify one directory as a (possibly untrained / non-model) model dir. */
export async function classifyModelDir(path: string, fs?: ScanFs): Promise<ClassifiedModelDir> {
  const io = fs ?? (await defaultFs());
  const cfgPath = joinPath(path, CONFIG_FILE);
  const base: ClassifiedModelDir = { path, runName: baseName(path), head: null, trained: false };
  if (!(await io.exists(cfgPath))) return base;
  let head: string | null = null;
  try {
    head = detectModelHead(await io.readTextFile(cfgPath));
  } catch {
    head = null;
  }
  const trained = await io.exists(joinPath(path, CKPT_FILE));
  return { ...base, head, trained };
}

/**
 * Scan `roots` for trained model dirs, returning one {@link ModelCatalogEntry}
 * per dir that has a `training_config.yaml`, a `best.ckpt`, and a detectable
 * head. Deduped by path; roots that can't be listed are skipped.
 */
export async function scanModelCatalog(
  roots: string[],
  fs?: ScanFs,
): Promise<ModelCatalogEntry[]> {
  const io = fs ?? (await defaultFs());
  const out: ModelCatalogEntry[] = [];
  const seen = new Set<string>();

  for (const root of roots) {
    let entries: { name: string; isDirectory: boolean }[];
    try {
      entries = await io.readDir(root);
    } catch {
      continue; // root missing / unreadable — skip
    }
    for (const entry of entries) {
      if (!entry.isDirectory) continue;
      const path = joinPath(root, entry.name);
      if (seen.has(path)) continue;
      const cfgPath = joinPath(path, CONFIG_FILE);
      if (!(await io.exists(cfgPath))) continue;
      if (!(await io.exists(joinPath(path, CKPT_FILE)))) continue; // untrained
      let head: string | null;
      try {
        head = detectModelHead(await io.readTextFile(cfgPath));
      } catch {
        head = null;
      }
      if (!head) continue;
      seen.add(path);
      out.push({ path, runName: entry.name, head });
    }
  }
  return out;
}
