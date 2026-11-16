/**
 * Find prediction `.slp` files near the project (desktop only).
 *
 * Looks in the project's folder, its `models/` folder, and each folder inside
 * `models/` (where SLEAP and sleap-nn put a run's predictions next to its
 * checkpoint). The project file itself is skipped. Files bigger than
 * {@link MAX_SCAN_BYTES} are listed but not opened, with the reason, so one
 * huge package can't stall the dialog; Browse… still opens them.
 *
 * Filesystem access is injectable ({@link SlpScanFs}) so the listing logic is
 * unit-tested without Tauri; the default reader lazily imports
 * `@tauri-apps/plugin-fs`.
 */

import { normalizePath } from "./core";

export interface SlpScanFs {
  readDir(path: string): Promise<{ name: string; isDirectory: boolean }[]>;
  /** Size in bytes and last-modified time (ms), each null when it can't be read. */
  stat(path: string): Promise<{ size: number | null; mtime: number | null }>;
}

/** Files bigger than this are listed with a reason instead of opened by the scan. */
export const MAX_SCAN_BYTES = 1024 * 1024 * 1024;

export interface ScannedSlp {
  path: string;
  size: number | null;
  /** Last-modified time in ms (cache key for the dialog's checks), when known. */
  mtime: number | null;
}

function sep(p: string): "\\" | "/" {
  return p.includes("\\") && !p.includes("/") ? "\\" : "/";
}

function join(dir: string, name: string): string {
  const s = sep(dir);
  return dir.endsWith(s) ? dir + name : dir + s + name;
}

function parent(p: string): string {
  const s = sep(p);
  const i = p.lastIndexOf(s);
  return i <= 0 ? p : p.slice(0, i);
}

async function defaultFs(): Promise<SlpScanFs> {
  const fs = await import("@tauri-apps/plugin-fs");
  return {
    async readDir(path) {
      const entries = await fs.readDir(path);
      return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory }));
    },
    async stat(path) {
      try {
        const st = await fs.stat(path);
        return { size: st.size, mtime: st.mtime ? st.mtime.getTime() : null };
      } catch {
        return { size: null, mtime: null };
      }
    },
  };
}

/**
 * Every `.slp` file in the project folder, `models/`, and `models/<run>/`,
 * except the project file. Folders that don't exist or can't be read are
 * skipped. Sorted by path.
 */
export async function scanPredictionFiles(projectPath: string | null, fs?: SlpScanFs): Promise<ScannedSlp[]> {
  if (!projectPath) return [];
  const io = fs ?? (await defaultFs());
  const dir = parent(projectPath);
  const modelsDir = join(dir, "models");
  const self = normalizePath(projectPath);

  const list = async (d: string) => {
    try {
      return await io.readDir(d);
    } catch {
      return [];
    }
  };

  const folders = [dir, modelsDir];
  for (const e of await list(modelsDir)) {
    if (e.isDirectory) folders.push(join(modelsDir, e.name));
  }

  const seen = new Set<string>();
  const out: ScannedSlp[] = [];
  for (const d of folders) {
    for (const e of await list(d)) {
      if (e.isDirectory || !e.name.toLowerCase().endsWith(".slp")) continue;
      const path = join(d, e.name);
      const key = normalizePath(path);
      if (key === self || seen.has(key)) continue;
      seen.add(key);
      out.push({ path, ...(await io.stat(path)) });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}
