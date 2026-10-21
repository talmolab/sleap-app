/**
 * The worker file browser's remembered settings (`RemoteFileBrowser`): one
 * view + sort for every folder and worker, the window's size, and per-worker
 * Favorites and Recents. Recents double as "Date Last Opened" — the worker
 * has no idea what this app opened.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_SORT, type BrowserView, type SortSpec } from "@/lib/remoteBrowser";

export interface RecentItem {
  path: string;
  isDir: boolean;
  /** `Date.now()` when it was last picked. */
  openedAt: number;
}

export const MAX_RECENTS = 10;

interface RemoteBrowserState {
  view: BrowserView;
  sort: SortSpec;
  /** Last dragged-to window size, px; null = the default size. */
  size: { width: number; height: number } | null;
  /** Columns view: the last width a column was dragged to — new columns open at it. Null = default. */
  columnWidth: number | null;
  /** Pinned folders, per worker key. */
  favorites: Record<string, string[]>;
  /** Newest first, per worker key, at most `MAX_RECENTS`. */
  recents: Record<string, RecentItem[]>;

  setView: (view: BrowserView) => void;
  setSort: (sort: SortSpec) => void;
  setSize: (size: { width: number; height: number }) => void;
  setColumnWidth: (width: number) => void;
  toggleFavorite: (workerKey: string, path: string) => void;
  removeFavorite: (workerKey: string, path: string) => void;
  addRecent: (workerKey: string, path: string, isDir: boolean) => void;
}

export const useRemoteBrowserStore = create<RemoteBrowserState>()(
  persist(
    (set) => ({
      view: "list",
      sort: DEFAULT_SORT,
      size: null,
      columnWidth: null,
      favorites: {},
      recents: {},

      setView: (view) => set({ view }),
      setSort: (sort) => set({ sort }),
      setSize: (size) => set({ size }),
      setColumnWidth: (columnWidth) => set({ columnWidth }),
      toggleFavorite: (workerKey, path) =>
        set((s) => {
          const current = s.favorites[workerKey] ?? [];
          const next = current.includes(path) ? current.filter((p) => p !== path) : [...current, path];
          return { favorites: { ...s.favorites, [workerKey]: next } };
        }),
      removeFavorite: (workerKey, path) =>
        set((s) => ({
          favorites: { ...s.favorites, [workerKey]: (s.favorites[workerKey] ?? []).filter((p) => p !== path) },
        })),
      addRecent: (workerKey, path, isDir) =>
        set((s) => {
          const rest = (s.recents[workerKey] ?? []).filter((r) => r.path !== path);
          const next = [{ path, isDir, openedAt: Date.now() }, ...rest].slice(0, MAX_RECENTS);
          return { recents: { ...s.recents, [workerKey]: next } };
        }),
    }),
    { name: "sleap-app-remote-browser", version: 1 },
  ),
);
