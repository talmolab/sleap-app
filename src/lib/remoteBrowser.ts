/**
 * Pure helpers behind the worker file browser (`RemoteFileBrowser`): paths,
 * file kinds, sorting and filtering. Kept free of React so they're testable
 * on their own.
 */
import type { FileEntry } from "@/lib/sleapConnect";

export type BrowserView = "icons" | "list" | "columns";
export type SortKey = "name" | "kind" | "modified" | "lastOpened" | "size";
export type SortDir = "asc" | "desc";

export interface SortSpec {
  key: SortKey;
  dir: SortDir;
  /** Finder's "Keep folders on top". */
  foldersFirst: boolean;
}

export const DEFAULT_SORT: SortSpec = { key: "name", dir: "asc", foldersFirst: true };

export const SORT_LABELS: Record<SortKey, string> = {
  name: "Name",
  kind: "Kind",
  modified: "Date Modified",
  lastOpened: "Date Last Opened",
  size: "Size",
};

/** `base` + `/name`, without doubling or dropping the slash. */
export function joinPath(base: string, name: string): string {
  const clean = base.endsWith("/") ? base.slice(0, -1) : base;
  return clean === "" ? `/${name}` : `${clean}/${name}`;
}

/** Parent folder of `path` (`/a/b` → `/a`, `/a` → `/`). */
export function parentPath(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}

/** Last path segment. */
export function baseName(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed;
}

/**
 * The mount `path` lives under (longest match), or null if none does. The
 * worker only lists inside its mounts, so a mount root is the highest folder
 * the browser can show: everything above it would list as empty.
 */
export function mountRootFor(path: string, mounts: string[]): string | null {
  let best: string | null = null;
  for (const m of mounts) {
    const root = m.length > 1 ? m.replace(/\/+$/, "") : m;
    const within = path === root || path.startsWith(root === "/" ? "/" : `${root}/`);
    if (within && (best === null || root.length > best.length)) best = root;
  }
  return best;
}

/**
 * Every folder from the mount root down to `path`, root first — the trail
 * the breadcrumbs and Columns view show. With no containing mount, starts
 * at `/`.
 */
export function pathTrail(path: string, mounts: string[]): string[] {
  const root = mountRootFor(path, mounts) ?? "/";
  const rest = path.slice(root === "/" ? 0 : root.length).split("/").filter(Boolean);
  const trail = [root];
  for (const part of rest) trail.push(joinPath(trail[trail.length - 1], part));
  return trail;
}

export type FileKind =
  | "folder"
  | "labels"
  | "video"
  | "image"
  | "config"
  | "model"
  | "archive"
  | "text"
  | "other";

const KIND_BY_EXT: Record<string, FileKind> = {
  slp: "labels",
  mp4: "video",
  avi: "video",
  mov: "video",
  mkv: "video",
  wmv: "video",
  mpg: "video",
  mpeg: "video",
  h5: "other",
  png: "image",
  jpg: "image",
  jpeg: "image",
  tif: "image",
  tiff: "image",
  bmp: "image",
  yaml: "config",
  yml: "config",
  json: "config",
  ckpt: "model",
  onnx: "model",
  pt: "model",
  engine: "model",
  zip: "archive",
  tar: "archive",
  gz: "archive",
  txt: "text",
  log: "text",
  csv: "text",
  md: "text",
};

export const KIND_LABELS: Record<FileKind, string> = {
  folder: "Folder",
  labels: "SLEAP labels",
  video: "Video",
  image: "Image",
  config: "Config",
  model: "Model weights",
  archive: "Archive",
  text: "Text",
  other: "Document",
};

export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function fileKind(entry: Pick<FileEntry, "name" | "isDir">): FileKind {
  if (entry.isDir) return "folder";
  return KIND_BY_EXT[extensionOf(entry.name)] ?? "other";
}

/** "SLEAP labels (.slp)" style label for the footer's type hint. */
export function filterLabel(exts: string[]): string {
  return exts
    .map((ext) => {
      const kind = KIND_BY_EXT[ext.replace(/^\./, "").toLowerCase()];
      return kind ? `${KIND_LABELS[kind]} (${ext})` : ext;
    })
    .join(", ");
}

/** Lower-cased extension list from a picker's `fileFilter`, or null for "any file". */
export function normalizeFilter(fileFilter?: string | string[]): string[] | null {
  if (!fileFilter) return null;
  return (Array.isArray(fileFilter) ? fileFilter : [fileFilter]).map((e) => e.toLowerCase());
}

/** Whether a file passes the picker's filter. Folders always do (you can open them). */
export function matchesFilter(entry: Pick<FileEntry, "name" | "isDir">, exts: string[] | null): boolean {
  if (entry.isDir || !exts) return true;
  const name = entry.name.toLowerCase();
  return exts.some((ext) => name.endsWith(ext));
}

/** Case-insensitive name filter for the search box (current folder only). */
export function matchesSearch(entry: Pick<FileEntry, "name">, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q === "" || entry.name.toLowerCase().includes(q);
}

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * Sorts a folder's entries Finder-style. `lastOpened` maps a full path to
 * when it was last picked in this app; entries never opened sort after the
 * ones that were, whatever the direction. Ties fall back to name.
 */
export function sortEntries(
  entries: FileEntry[],
  sort: SortSpec,
  opts: { dir: string; lastOpened?: Record<string, number> } = { dir: "/" },
): FileEntry[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const byName = (a: FileEntry, b: FileEntry) => nameCollator.compare(a.name, b.name);
  const opened = (e: FileEntry) => opts.lastOpened?.[joinPath(opts.dir, e.name)];

  const primary = (a: FileEntry, b: FileEntry): number => {
    switch (sort.key) {
      case "name":
        return sign * byName(a, b);
      case "kind":
        return sign * KIND_LABELS[fileKind(a)].localeCompare(KIND_LABELS[fileKind(b)]);
      case "size":
        return sign * ((a.isDir ? -1 : (a.size ?? 0)) - (b.isDir ? -1 : (b.size ?? 0)));
      case "modified":
        return sign * ((a.modified ?? 0) - (b.modified ?? 0));
      case "lastOpened": {
        const oa = opened(a);
        const ob = opened(b);
        if (oa == null && ob == null) return 0;
        if (oa == null) return 1;
        if (ob == null) return -1;
        return sign * (oa - ob);
      }
    }
  };

  return [...entries].sort((a, b) => {
    if (sort.foldersFirst && a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return primary(a, b) || byName(a, b);
  });
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** Finder-style date: "Today at 3:04 PM", "Yesterday at …", else "Oct 18, 2026 at …". */
export function formatModified(unixSeconds: number | undefined, now = new Date()): string {
  if (!unixSeconds) return "—";
  const d = new Date(unixSeconds * 1000);
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((day(now) - day(d)) / 86_400_000);
  if (diffDays === 0) return `Today at ${time}`;
  if (diffDays === 1) return `Yesterday at ${time}`;
  const date = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return `${date} at ${time}`;
}
