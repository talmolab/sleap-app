/**
 * Finder-style browser for a worker's filesystem — the picker behind the
 * Training/Inference panels, the launcher wizard, "Locate on worker…" and
 * video path resolution, and (`mode="browse"`) the Connect window's
 * look-only Browse files.
 *
 * The worker only lists inside its configured mounts (`fs.list`), and only
 * reports name, type, size and modified time per entry. "Date Last Opened"
 * and Recents are this app's own record of what was picked; Favorites are
 * pinned folders. All of that, plus the one view/sort used everywhere and
 * the window size, lives in `remoteBrowserStore`.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ArrowUpDown,
  BrainCircuit,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Columns3,
  File,
  FileArchive,
  FileCog,
  FileImage,
  FileText,
  FileVideoCamera,
  Folder,
  HardDrive,
  LayoutGrid,
  List,
  Loader2,
  Search,
  Star,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useConnectStore } from "@/stores/connectStore";
import { useRemoteBrowserStore, type RecentItem } from "@/stores/remoteBrowserStore";
import type { FileEntry } from "@/lib/sleapConnect";
import { cn } from "@/lib/utils";
import {
  KIND_LABELS,
  SORT_LABELS,
  baseName,
  fileKind,
  filterLabel,
  formatModified,
  formatSize,
  joinPath,
  matchesFilter,
  matchesSearch,
  mountRootFor,
  normalizeFilter,
  parentPath,
  pathTrail,
  sortEntries,
  type BrowserView,
  type FileKind,
  type SortKey,
} from "@/lib/remoteBrowser";

export { mountRootFor };

interface RemoteFileBrowserProps {
  open: boolean;
  onClose: () => void;
  /** Called with the picked worker path. Unused in `browse` mode. */
  onSelect?: (path: string) => void;
  /** The worker's mount paths — the sidebar's Locations, and the browsable roots. */
  mounts?: string[];
  /** Display labels for mounts, keyed by mount path (e.g. from `fs.mounts`). */
  mountLabels?: Record<string, string>;
  /**
   * `directory` picks a folder, `file` a file; `browse` is look-only (the
   * Connect window's Browse files), with Close instead of Open.
   */
  mode?: "directory" | "file" | "browse";
  /**
   * File extension filter(s) (e.g. ".slp" or [".slp", ".mp4"]), `file` mode
   * only, case-insensitive. Other files still show, greyed out and
   * unselectable, like a Mac Open dialog.
   */
  fileFilter?: string | string[];
  /**
   * Browse this worker specifically (`browseRemoteDirOn`) instead of the
   * selected worker (`browseRemoteDir`) — the launcher wizard (PR5b) can
   * target a worker before it's the one selected in the Connect window.
   */
  workerId?: string;
}

/** Remembered settings' key for the no-`workerId` (selected-worker) case. */
const SELECTED_WORKER_KEY = "";

const DEFAULT_SIZE = { width: 900, height: 600 };

/** Last browsed folder per worker key, for this session — a wizard for one worker shouldn't resume another's position. */
const lastBrowsedPaths = new Map<string, string>();

const KIND_ICONS: Record<FileKind, LucideIcon> = {
  folder: Folder,
  labels: File,
  video: FileVideoCamera,
  image: FileImage,
  config: FileCog,
  model: BrainCircuit,
  archive: FileArchive,
  text: FileText,
  other: File,
};

interface Listing {
  entries: FileEntry[];
  loading: boolean;
  error: string | null;
  /** More entries left on the worker — loaded a batch at a time (`BATCH`). */
  hasMore: boolean;
}

/** Entries fetched per batch; big folders load more on scroll. */
const BATCH = 100;
const DEFAULT_COLUMN_WIDTH = 224;

function KindIcon({ entry, className }: { entry: Pick<FileEntry, "name" | "isDir">; className?: string }) {
  const kind = fileKind(entry);
  const Icon = KIND_ICONS[kind];
  return (
    <Icon
      className={cn(
        "shrink-0",
        kind === "folder" ? "text-primary fill-primary/20" : kind === "labels" ? "text-primary" : "text-muted-foreground",
        className,
      )}
    />
  );
}

export function RemoteFileBrowser({
  open,
  onClose,
  onSelect,
  mounts = [],
  mountLabels,
  mode = "directory",
  fileFilter,
  workerId,
}: RemoteFileBrowserProps) {
  const browseRemoteDir = useConnectStore((s) => s.browseRemoteDir);
  const browseRemoteDirOn = useConnectStore((s) => s.browseRemoteDirOn);
  const workerKey = workerId ?? SELECTED_WORKER_KEY;

  const view = useRemoteBrowserStore((s) => s.view);
  const sort = useRemoteBrowserStore((s) => s.sort);
  const savedSize = useRemoteBrowserStore((s) => s.size);
  const favorites = useRemoteBrowserStore((s) => s.favorites[workerKey]);
  const recents = useRemoteBrowserStore((s) => s.recents[workerKey]);
  const { setView, setSort, setSize, setColumnWidth, toggleFavorite, removeFavorite, addRecent } = useRemoteBrowserStore.getState();

  const exts = mode === "file" ? normalizeFilter(fileFilter) : null;
  const pickable = (e: FileEntry) => {
    if (mode === "browse") return true;
    if (e.isDir) return true; // folders open; in directory mode they're also the pick
    return mode === "file" && matchesFilter(e, exts);
  };

  // Start where this worker was last browsed (if still inside a mount), else
  // the first mount. With no mounts there's nothing to browse.
  const initialPath = (): string | null => {
    const remembered = lastBrowsedPaths.get(workerKey);
    if (remembered && (mounts.length === 0 || mountRootFor(remembered, mounts) !== null)) return remembered;
    return mounts[0] ?? null;
  };

  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [back, setBack] = useState<string[]>([]);
  const [forward, setForward] = useState<string[]>([]);
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [goto, setGoto] = useState<string | null>(null);
  const [gotoError, setGotoError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const loadingPaths = useRef(new Set<string>());
  const listingsRef = useRef(listings);
  listingsRef.current = listings;

  // Fresh state on every open.
  useEffect(() => {
    if (!open) return;
    setCurrentPath(initialPath());
    setBack([]);
    setForward([]);
    setListings({});
    loadingPaths.current.clear();
    setSelected(null);
    setQuery("");
    setGoto(null);
    setGotoError(null);
    setNotice(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Fetches the next batch of `path` (the first, if nothing's loaded yet).
  const load = useCallback(
    (path: string) => {
      if (loadingPaths.current.has(path)) return;
      loadingPaths.current.add(path);
      const prev = listingsRef.current[path];
      const offset = prev?.entries.length ?? 0;
      setListings((l) => ({
        ...l,
        [path]: { entries: l[path]?.entries ?? [], loading: true, error: null, hasMore: l[path]?.hasMore ?? true },
      }));
      void (async () => {
        try {
          const batch = workerId
            ? await browseRemoteDirOn(workerId, path, offset, BATCH)
            : await browseRemoteDir(path, offset, BATCH);
          setListings((l) => ({
            ...l,
            [path]: { entries: [...(l[path]?.entries ?? []), ...batch], loading: false, error: null, hasMore: batch.length >= BATCH },
          }));
        } catch (err) {
          setListings((l) => ({
            ...l,
            [path]: {
              entries: [],
              loading: false,
              error: err instanceof Error ? err.message : "Couldn't open this folder",
              hasMore: false,
            },
          }));
        } finally {
          loadingPaths.current.delete(path);
        }
      })();
    },
    [workerId, browseRemoteDir, browseRemoteDirOn],
  );

  // Columns view shows every folder from the mount root down; the others
  // only the current one.
  const trail = useMemo(() => (currentPath ? pathTrail(currentPath, mounts) : []), [currentPath, mounts]);
  const visibleFolders = view === "columns" ? trail : currentPath ? [currentPath] : [];
  useEffect(() => {
    if (!open) return;
    for (const p of visibleFolders) if (!listings[p]) load(p);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, visibleFolders.join("\n")]);

  // Batches arrive in the worker's own order (folders first, A→Z), so the
  // default sort is right on a partial folder. Any other sort, or a search,
  // needs the whole folder, so keep loading it in the background.
  const needsWholeFolder = query.trim() !== "" || sort.key !== "name" || sort.dir !== "asc" || !sort.foldersFirst;
  const currentListing = currentPath ? listings[currentPath] : undefined;
  useEffect(() => {
    if (open && needsWholeFolder && currentPath && currentListing?.hasMore && !currentListing.loading && !currentListing.error) {
      load(currentPath);
    }
  }, [open, needsWholeFolder, currentPath, currentListing, load]);

  // A folder that can't be opened (deleted, renamed, or a stale Recent /
  // remembered path / typed path) falls back to its nearest openable parent.
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const broken = visibleFolders.find((p) => listings[p]?.error);
    if (!broken || mountRootFor(broken, mounts) === broken) return;
    // Keep the first (deepest) folder's name when the fallback walks up more than one level.
    setNotice((n) => n ?? `“${baseName(broken)}” couldn’t be opened — showing the nearest folder that could.`);
    setCurrentPath(parentPath(broken));
    setSelected(null);
    lastBrowsedPaths.set(workerKey, parentPath(broken));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, listings, visibleFolders.join("\n")]);

  const columnWidth = useRemoteBrowserStore((s) => s.columnWidth) ?? DEFAULT_COLUMN_WIDTH;
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>({});

  const lastOpened = useMemo(
    () => Object.fromEntries((recents ?? []).map((r) => [r.path, r.openedAt])),
    [recents],
  );
  const sortedIn = (dir: string, entries: FileEntry[]) => sortEntries(entries, sort, { dir, lastOpened });

  if (!open) return null;

  const navigateTo = (path: string, opts: { select?: string | null; history?: boolean } = {}) => {
    if (mounts.length > 0 && mountRootFor(path, mounts) === null) return;
    if (path === currentPath) {
      setSelected(opts.select ?? null);
      return;
    }
    if (opts.history !== false && currentPath) {
      setBack((b) => [...b, currentPath]);
      setForward([]);
    }
    setCurrentPath(path);
    setSelected(opts.select ?? null);
    setQuery("");
    setNotice(null);
    // Re-list a folder that failed before, in case it's back.
    setListings((l) => {
      if (!l[path]?.error) return l;
      const next = { ...l };
      delete next[path];
      return next;
    });
    lastBrowsedPaths.set(workerKey, path);
  };

  const goBack = () => {
    const prev = back[back.length - 1];
    if (!prev || !currentPath) return;
    setBack((b) => b.slice(0, -1));
    setForward((f) => [currentPath, ...f]);
    navigateTo(prev, { history: false });
  };
  const goForward = () => {
    const next = forward[0];
    if (!next || !currentPath) return;
    setForward((f) => f.slice(1));
    setBack((b) => [...b, currentPath]);
    navigateTo(next, { history: false });
  };
  const atRoot = !currentPath || mountRootFor(currentPath, mounts) === currentPath;
  const goUp = () => {
    if (currentPath && !atRoot) navigateTo(parentPath(currentPath), { select: currentPath });
  };

  const current = currentPath ? listings[currentPath] : undefined;
  const currentEntries = currentPath && current ? sortedIn(currentPath, current.entries).filter((e) => matchesSearch(e, query)) : [];
  const entryAt = (path: string | null) => {
    if (!path) return undefined;
    return listings[parentPath(path)]?.entries.find((e) => e.name === baseName(path));
  };
  const selectedEntry = entryAt(selected);

  // What Open/Choose would return.
  const pickPath = (() => {
    if (mode === "browse") return null;
    if (mode === "directory") return selectedEntry?.isDir ? selected : currentPath;
    return selectedEntry && !selectedEntry.isDir && pickable(selectedEntry) ? selected : null;
  })();

  const confirm = (path = pickPath) => {
    if (!path || mode === "browse") return;
    addRecent(workerKey, path, mode === "directory");
    onSelect?.(path);
    onClose();
  };

  const activate = (dir: string, entry: FileEntry) => {
    const path = joinPath(dir, entry.name);
    if (entry.isDir) navigateTo(path);
    else if (pickable(entry) && mode === "file") confirm(path);
  };

  const clickEntry = (dir: string, entry: FileEntry) => {
    if (!pickable(entry)) return;
    const path = joinPath(dir, entry.name);
    // Columns view: a folder opens as the next column right away, like Finder.
    if (view === "columns" && entry.isDir) navigateTo(path, { select: path });
    else if (view === "columns" && dir !== currentPath) navigateTo(dir, { select: path });
    else setSelected(path);
  };

  const openRecent = (r: RecentItem) => {
    if (r.isDir) navigateTo(r.path);
    else navigateTo(parentPath(r.path), { select: r.path });
  };

  const submitGoto = () => {
    const raw = (goto ?? "").trim();
    if (!raw) return setGoto(null);
    const path = raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
    if (mounts.length > 0 && mountRootFor(path, mounts) === null) {
      setGotoError("That folder isn't inside one of this worker's shared folders.");
      return;
    }
    setGoto(null);
    setGotoError(null);
    navigateTo(path);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const typing = target.tagName === "INPUT";
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "f") {
      e.preventDefault();
      searchRef.current?.focus();
    } else if (mod && e.shiftKey && e.key.toLowerCase() === "g") {
      e.preventDefault();
      setGoto(currentPath ?? "");
    } else if (mod && e.key === "ArrowUp") {
      e.preventDefault();
      goUp();
    } else if (mod && e.key === "[") {
      e.preventDefault();
      goBack();
    } else if (mod && e.key === "]") {
      e.preventDefault();
      goForward();
    } else if (!typing && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      if (!currentPath) return;
      const items = currentEntries.filter(pickable);
      if (items.length === 0) return;
      e.preventDefault();
      if (view === "columns" && e.key === "ArrowLeft") return goUp();
      if (view === "columns" && e.key === "ArrowRight") {
        if (selectedEntry?.isDir && selected) navigateTo(selected);
        return;
      }
      const cols = view === "icons" ? Math.max(1, Math.floor((contentRef.current?.clientWidth ?? 600) / 112)) : 1;
      const step = { ArrowDown: cols, ArrowUp: -cols, ArrowRight: 1, ArrowLeft: -1 }[e.key];
      if (view === "list" && (e.key === "ArrowLeft" || e.key === "ArrowRight")) return;
      const i = items.findIndex((x) => joinPath(currentPath, x.name) === selected);
      const next = items[Math.min(items.length - 1, Math.max(0, i < 0 ? 0 : i + step))];
      if (view === "columns" && next.isDir) navigateTo(currentPath, { select: joinPath(currentPath, next.name) });
      else setSelected(joinPath(currentPath, next.name));
    } else if (!typing && e.key === "Enter" && currentPath) {
      e.preventDefault();
      if (selectedEntry?.isDir && selected) navigateTo(selected);
      else confirm();
    }
  };

  const isFavorite = !!currentPath && (favorites ?? []).includes(currentPath);
  const size = savedSize ?? DEFAULT_SIZE;
  const noMounts = mounts.length === 0;

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        onKeyDown={onKeyDown}
        // Fixed size whatever the folder holds; drag-resizable, and the size
        // is remembered. inset-0 + m-auto centers it without the default
        // translate, so the resize handle tracks the pointer.
        style={{ width: size.width, height: size.height }}
        className="inset-0 m-auto translate-x-0 translate-y-0 min-w-[560px] min-h-[380px] max-w-[96vw] sm:max-w-[96vw] max-h-[92vh] resize overflow-hidden p-0 gap-0 flex flex-col"
        onPointerUp={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          if (Math.abs(r.width - size.width) > 2 || Math.abs(r.height - size.height) > 2) {
            setSize({ width: Math.round(r.width), height: Math.round(r.height) });
          }
        }}
      >
        <DialogTitle className="sr-only">Browse Worker Files</DialogTitle>
        <DialogDescription className="sr-only">
          {mode === "browse" ? "Files on this worker" : "Choose a file or folder on the worker"}
        </DialogDescription>

        {/* Toolbar */}
        <div className="flex items-center gap-1.5 px-2.5 py-2 border-b border-border shrink-0">
          <Button variant="ghost" size="icon-xs" aria-label="Back" disabled={back.length === 0} onClick={goBack}>
            <ChevronLeft />
          </Button>
          <Button variant="ghost" size="icon-xs" aria-label="Forward" disabled={forward.length === 0} onClick={goForward}>
            <ChevronRight />
          </Button>

          <div className="flex-1 min-w-0">
            {goto !== null ? (
              <div className="relative">
                <input
                  autoFocus
                  onFocus={(e) => e.currentTarget.select()}
                  aria-label="Go to folder"
                  value={goto}
                  onChange={(e) => {
                    setGoto(e.target.value);
                    setGotoError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitGoto();
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setGoto(null);
                      setGotoError(null);
                    }
                  }}
                  onBlur={() => !gotoError && setGoto(null)}
                  placeholder="/path/on/worker"
                  className="w-full h-7 rounded-md border border-ring bg-background px-2 font-mono text-xs outline-none"
                />
                {gotoError && (
                  <p className="absolute left-0 top-8 z-10 rounded border border-red-500/30 bg-popover px-2 py-1 text-[11px] text-red-400 shadow">
                    {gotoError}
                  </p>
                )}
              </div>
            ) : (
              <div
                className="flex items-center gap-0.5 h-7 px-1 rounded-md hover:bg-accent/40 cursor-text overflow-hidden text-xs"
                title="Click, or press ⌘⇧G, to go to a folder"
                onClick={(e) => {
                  if (e.target === e.currentTarget) setGoto(currentPath ?? "");
                }}
              >
                {trail.map((p, i) => {
                  const last = i === trail.length - 1;
                  return (
                    <span key={p} className="flex items-center gap-0.5 min-w-0 shrink">
                      {i > 0 && <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />}
                      <button
                        type="button"
                        className={cn(
                          "truncate rounded px-1 py-0.5",
                          last ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-accent",
                        )}
                        onClick={() => !last && navigateTo(p)}
                      >
                        {i === 0 ? (mountLabels?.[p] ?? p) : baseName(p)}
                      </button>
                    </span>
                  );
                })}
                <span className="flex-1 self-stretch" onClick={() => setGoto(currentPath ?? "")} />
              </div>
            )}
          </div>

          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={isFavorite ? "Remove from Favorites" : "Add to Favorites"}
            title={isFavorite ? "Remove from Favorites" : "Add to Favorites"}
            disabled={!currentPath}
            onClick={() => currentPath && toggleFavorite(workerKey, currentPath)}
          >
            <Star className={cn(isFavorite && "fill-yellow-400 text-yellow-400")} />
          </Button>

          <div className="flex items-center rounded-md border border-border p-0.5" role="group" aria-label="View">
            {(
              [
                ["icons", LayoutGrid, "as Icons"],
                ["list", List, "as List"],
                ["columns", Columns3, "as Columns"],
              ] as [BrowserView, LucideIcon, string][]
            ).map(([v, Icon, label]) => (
              <button
                key={v}
                type="button"
                aria-label={`View ${label}`}
                aria-pressed={view === v}
                title={`View ${label}`}
                onClick={() => setView(v)}
                className={cn(
                  "h-6 w-7 inline-flex items-center justify-center rounded-sm",
                  view === v ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            ))}
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon-xs" aria-label="Sort by" title="Sort by">
                <ArrowUpDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[11rem]">
              {(Object.keys(SORT_LABELS) as SortKey[]).map((key) => (
                <DropdownMenuItem key={key} onSelect={() => setSort({ ...sort, key })} className="text-xs">
                  <Check className={cn("h-3.5 w-3.5", sort.key !== key && "invisible")} />
                  {SORT_LABELS[key]}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setSort({ ...sort, dir: "asc" })} className="text-xs">
                <Check className={cn("h-3.5 w-3.5", sort.dir !== "asc" && "invisible")} />
                Ascending
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setSort({ ...sort, dir: "desc" })} className="text-xs">
                <Check className={cn("h-3.5 w-3.5", sort.dir !== "desc" && "invisible")} />
                Descending
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={sort.foldersFirst}
                onCheckedChange={(c) => setSort({ ...sort, foldersFirst: c === true })}
                className="text-xs"
              >
                Keep folders on top
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <div className="relative w-44 shrink-0">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              ref={searchRef}
              aria-label="Search this folder"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape" && query) {
                  e.stopPropagation();
                  setQuery("");
                }
              }}
              placeholder="Search this folder"
              className="w-full h-7 rounded-md border border-border bg-background pl-7 pr-6 text-xs outline-none focus:border-ring"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setQuery("")}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Sidebar */}
          <nav className="w-48 shrink-0 overflow-y-auto border-r border-border bg-muted/20 px-2 py-2 text-xs space-y-3" aria-label="Sidebar">
            {(favorites ?? []).length > 0 && (
              <SidebarSection title="Favorites">
                {(favorites ?? []).map((p) => (
                  <SidebarItem
                    key={p}
                    icon={<Star className="h-3.5 w-3.5 text-yellow-400" />}
                    label={baseName(p)}
                    title={p}
                    active={currentPath === p}
                    onClick={() => navigateTo(p)}
                    onRemove={() => removeFavorite(workerKey, p)}
                  />
                ))}
              </SidebarSection>
            )}
            {(recents ?? []).length > 0 && (
              <SidebarSection title="Recents">
                {(recents ?? []).map((r) => (
                  <SidebarItem
                    key={r.path}
                    icon={r.isDir ? <Clock className="h-3.5 w-3.5 text-muted-foreground" /> : <KindIcon entry={{ name: r.path, isDir: false }} className="h-3.5 w-3.5" />}
                    label={baseName(r.path)}
                    title={r.path}
                    active={r.isDir ? currentPath === r.path : selected === r.path}
                    onClick={() => openRecent(r)}
                  />
                ))}
              </SidebarSection>
            )}
            <SidebarSection title="Locations">
              {noMounts && <p className="px-2 text-muted-foreground">No shared folders</p>}
              {mounts.map((m) => (
                <SidebarItem
                  key={m}
                  icon={<HardDrive className="h-3.5 w-3.5 text-muted-foreground" />}
                  label={mountLabels?.[m] ?? m}
                  title={m}
                  active={!!currentPath && mountRootFor(currentPath, mounts) === m.replace(/\/+$/, "") && currentPath === m}
                  onClick={() => navigateTo(m)}
                />
              ))}
            </SidebarSection>
          </nav>

          {/* Content */}
          <div ref={contentRef} className="flex-1 min-w-0 flex flex-col">
            {notice && (
              <div className="flex items-center gap-2 border-b border-border bg-yellow-500/10 px-3 py-1.5 text-[11px] text-yellow-200">
                <span className="flex-1">{notice}</span>
                <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)} className="text-muted-foreground hover:text-foreground">
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            {noMounts ? (
              <EmptyState>This worker isn&apos;t sharing any folders. On the worker, run sleap-rtc add-folder &lt;folder&gt; to browse.</EmptyState>
            ) : view === "columns" ? (
              <div className="flex flex-1 min-h-0 overflow-x-auto">
                {trail.map((dir, i) => {
                  const listing = listings[dir];
                  const isLast = i === trail.length - 1;
                  const entries = listing ? sortedIn(dir, listing.entries).filter((e) => !isLast || matchesSearch(e, query)) : [];
                  const openChild = trail[i + 1];
                  return (
                    <div
                      key={dir}
                      className="relative shrink-0 border-r border-border overflow-y-auto py-1"
                      style={{ width: columnWidths[dir] ?? columnWidth }}
                      aria-label={baseName(dir)}
                    >
                      <ColumnResizer
                        width={columnWidths[dir] ?? columnWidth}
                        onResize={(w) => setColumnWidths((c) => ({ ...c, [dir]: w }))}
                        onDone={(w) => {
                          // Pin the other open columns at their current width before the
                          // dragged width becomes the default for columns opened later.
                          setColumnWidths((c) => ({
                            ...Object.fromEntries(trail.map((d) => [d, c[d] ?? columnWidth])),
                            ...c,
                            [dir]: w,
                          }));
                          setColumnWidth(w);
                        }}
                      />
                      <FolderBody listing={listing} empty={entries.length === 0} query={isLast ? query : ""} onMore={() => load(dir)}>
                        {entries.map((e) => {
                          const path = joinPath(dir, e.name);
                          return (
                            <EntryRow
                              key={e.name}
                              entry={e}
                              enabled={pickable(e)}
                              selected={path === selected || path === openChild}
                              dimSelected={path === openChild && path !== selected}
                              onClick={() => clickEntry(dir, e)}
                              onDoubleClick={() => activate(dir, e)}
                              trailing={e.isDir ? <ChevronRight className="h-3 w-3 text-muted-foreground" /> : null}
                            />
                          );
                        })}
                      </FolderBody>
                    </div>
                  );
                })}
                {selectedEntry && !selectedEntry.isDir && selected && (
                  <div className="w-64 shrink-0 p-4 flex flex-col items-center gap-2 text-center text-xs">
                    <KindIcon entry={selectedEntry} className="h-16 w-16 mt-4" />
                    <p className="font-medium break-all">{selectedEntry.name}</p>
                    <p className="text-muted-foreground">
                      {KIND_LABELS[fileKind(selectedEntry)]}
                      {selectedEntry.size != null && ` · ${formatSize(selectedEntry.size)}`}
                    </p>
                    <p className="text-muted-foreground">Modified {formatModified(selectedEntry.modified)}</p>
                  </div>
                )}
              </div>
            ) : view === "icons" ? (
              <div className="flex-1 overflow-y-auto p-3">
                <FolderBody listing={current} empty={currentEntries.length === 0} query={query} onMore={() => currentPath && load(currentPath)}>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2">
                    {currentEntries.map((e) => {
                      const path = joinPath(currentPath!, e.name);
                      const enabled = pickable(e);
                      return (
                        <button
                          key={e.name}
                          type="button"
                          title={e.name}
                          aria-disabled={!enabled}
                          onClick={() => clickEntry(currentPath!, e)}
                          onDoubleClick={() => activate(currentPath!, e)}
                          className={cn(
                            "flex flex-col items-center gap-1 rounded-md p-2 text-[11px] outline-none",
                            !enabled && "opacity-40 cursor-default",
                            path === selected ? "bg-primary/15 ring-1 ring-primary/40" : enabled && "hover:bg-accent/50",
                          )}
                        >
                          <KindIcon entry={e} className="h-10 w-10" />
                          <MiddleTruncate text={e.name} className="max-w-full justify-center leading-tight" />
                        </button>
                      );
                    })}
                  </div>
                </FolderBody>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto">
                <div className="sticky top-0 z-[1] grid grid-cols-[minmax(0,1fr)_10.5rem_5.5rem_7rem] gap-2 border-b border-border bg-background px-3 py-1 text-[11px] text-muted-foreground">
                  {(
                    [
                      ["name", "Name"],
                      ["modified", "Date Modified"],
                      ["size", "Size"],
                      ["kind", "Kind"],
                    ] as [SortKey, string][]
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      className={cn("text-left hover:text-foreground", sort.key === key && "text-foreground font-medium")}
                      onClick={() =>
                        setSort(sort.key === key ? { ...sort, dir: sort.dir === "asc" ? "desc" : "asc" } : { ...sort, key, dir: "asc" })
                      }
                    >
                      {label}
                      {sort.key === key && (sort.dir === "asc" ? " ▲" : " ▼")}
                    </button>
                  ))}
                </div>
                <FolderBody listing={current} empty={currentEntries.length === 0} query={query} onMore={() => currentPath && load(currentPath)}>
                  <div className="px-1 py-1">
                    {currentEntries.map((e) => {
                      const path = joinPath(currentPath!, e.name);
                      return (
                        <EntryRow
                          key={e.name}
                          entry={e}
                          enabled={pickable(e)}
                          selected={path === selected}
                          onClick={() => clickEntry(currentPath!, e)}
                          onDoubleClick={() => activate(currentPath!, e)}
                          columns={
                            <>
                              <span className="text-muted-foreground truncate">{formatModified(e.modified)}</span>
                              <span className="text-muted-foreground font-mono">{e.isDir ? "—" : e.size != null ? formatSize(e.size) : ""}</span>
                              <span className="text-muted-foreground truncate">{KIND_LABELS[fileKind(e)]}</span>
                            </>
                          }
                        />
                      );
                    })}
                  </div>
                </FolderBody>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center gap-3 px-3 py-2 border-t border-border shrink-0 text-[11px]">
          <div className="min-w-0 flex-1">
            <p className="font-mono truncate" title={selected ?? currentPath ?? undefined}>
              {selected ?? currentPath ?? ""}
            </p>
            {exts && <p className="text-muted-foreground">Shows {filterLabel(exts)}</p>}
          </div>
          {mode === "browse" ? (
            <Button size="sm" onClick={onClose}>
              Close
            </Button>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => confirm()} disabled={!pickPath}>
                {mode === "directory" ? "Choose Folder" : "Open"}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SidebarSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
      <div className="space-y-px">{children}</div>
    </div>
  );
}

function SidebarItem({
  icon,
  label,
  title,
  active,
  onClick,
  onRemove,
}: {
  icon: ReactNode;
  label: string;
  title: string;
  active: boolean;
  onClick: () => void;
  onRemove?: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex items-center gap-1.5 rounded-md px-2 py-1 cursor-pointer",
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
      title={title}
      onClick={onClick}
    >
      {icon}
      <MiddleTruncate text={label} className="flex-1" />
      {onRemove && (
        <button
          type="button"
          aria-label={`Remove ${label} from Favorites`}
          className="invisible group-hover:visible text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

function EntryRow({
  entry,
  enabled,
  selected,
  dimSelected,
  onClick,
  onDoubleClick,
  columns,
  trailing,
}: {
  entry: FileEntry;
  enabled: boolean;
  selected: boolean;
  /** Columns view: the open folder in a non-active column. */
  dimSelected?: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  columns?: ReactNode;
  trailing?: ReactNode;
}) {
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-disabled={!enabled}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={cn(
        "items-center gap-2 rounded px-2 py-1 text-xs",
        columns ? "grid grid-cols-[minmax(0,1fr)_10.5rem_5.5rem_7rem]" : "flex",
        !enabled ? "opacity-40 cursor-default" : "cursor-pointer",
        selected ? (dimSelected ? "bg-accent" : "bg-primary/15 text-foreground") : enabled && "hover:bg-accent/50",
      )}
    >
      <span className="flex items-center gap-2 min-w-0 flex-1">
        <KindIcon entry={entry} className="h-4 w-4" />
        <MiddleTruncate text={entry.name} />
      </span>
      {columns}
      {trailing}
    </div>
  );
}

function FolderBody({
  listing,
  empty,
  query,
  onMore,
  children,
}: {
  listing: Listing | undefined;
  empty: boolean;
  query: string;
  /** Load the next batch — fired when the end of the list scrolls into view. */
  onMore: () => void;
  children: ReactNode;
}) {
  if (!listing || (listing.loading && listing.entries.length === 0)) {
    return (
      <EmptyState>
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </EmptyState>
    );
  }
  if (listing.error) {
    return (
      <div className="m-3 rounded-md border border-red-500/20 bg-red-500/8 p-2 text-[11px] text-red-400 select-text">{listing.error}</div>
    );
  }
  if (empty && !listing.hasMore) {
    return <EmptyState>{query.trim() ? `No items match “${query.trim()}”` : "This folder is empty"}</EmptyState>;
  }
  return (
    <>
      {children}
      {listing.hasMore && <LoadMore count={listing.entries.length} loading={listing.loading} onVisible={onMore} />}
    </>
  );
}

/** The end-of-list marker: asks for the next batch as soon as it scrolls into view. */
function LoadMore({ count, loading, onVisible }: { count: number; loading: boolean; onVisible: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const onVisibleRef = useRef(onVisible);
  onVisibleRef.current = onVisible;
  useEffect(() => {
    const el = ref.current;
    if (!el || loading || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((items) => {
      if (items.some((i) => i.isIntersecting)) onVisibleRef.current();
    });
    io.observe(el);
    return () => io.disconnect();
  }, [loading, count]);
  return (
    <div ref={ref} className="flex items-center justify-center gap-2 py-2 text-[11px] text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin" />
      Loading more… ({count.toLocaleString()} so far)
    </div>
  );
}

/**
 * A name shortened in the middle when it doesn't fit — "fly_session_lo…_v003.slp",
 * like Finder — so the end (usually the version and extension) stays visible.
 * Pure CSS: the head truncates with an ellipsis, the tail never shrinks.
 */
function MiddleTruncate({ text, className }: { text: string; className?: string }) {
  // Short names always fit; keep them one text node.
  if (text.length <= 24) {
    return (
      <span className={cn("flex min-w-0", className)} title={text}>
        <span className="truncate">{text}</span>
      </span>
    );
  }
  const tail = text.slice(-12);
  return (
    <span className={cn("flex min-w-0", className)} title={text}>
      <span className="sr-only">{text}</span>
      <span className="truncate" aria-hidden>
        {text.slice(0, -12)}
      </span>
      <span className="shrink-0 whitespace-pre" aria-hidden>
        {tail}
      </span>
    </span>
  );
}

/** Drag handle on a column's right edge (Columns view). */
function ColumnResizer({ width, onResize, onDone }: { width: number; onResize: (w: number) => void; onDone: (w: number) => void }) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize column"
      className="absolute right-0 top-0 bottom-0 z-[2] w-1.5 cursor-col-resize hover:bg-primary/40"
      onPointerDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        let last = width;
        const move = (ev: PointerEvent) => {
          last = Math.min(600, Math.max(140, width + ev.clientX - startX));
          onResize(last);
        };
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
          onDone(last);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
    />
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return <div className="flex flex-1 h-full items-center justify-center gap-2 p-6 text-center text-xs text-muted-foreground">{children}</div>;
}
