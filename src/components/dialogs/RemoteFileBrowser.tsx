import { useState, useEffect } from "react";
import { Folder, File, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConnectStore } from "@/stores/connectStore";
import type { FileEntry } from "@/lib/sleapConnect";

interface RemoteFileBrowserProps {
  open: boolean;
  onClose: () => void;
  onSelect: (path: string) => void;
  /** All available mount paths on the worker. Browser starts at the mount picker. */
  mounts?: string[];
  /** If "directory", only directories can be selected. If "file", only files. */
  mode?: "directory" | "file";
  /**
   * File extension filter(s) (e.g., ".slp" or [".slp", ".mp4"]) — only applies
   * when mode is "file". Matching is case-insensitive. If omitted, all files show.
   */
  fileFilter?: string | string[];
}

/** Sentinel path representing the mount picker view */
const MOUNT_PICKER = "//mounts";

export function RemoteFileBrowser({
  open,
  onClose,
  onSelect,
  mounts = [],
  mode = "directory",
  fileFilter,
}: RemoteFileBrowserProps) {
  const browseRemoteDir = useConnectStore((s) => s.browseRemoteDir);
  // Initial view: mount picker if multiple mounts, else first mount, else root
  const initialPath =
    mounts.length > 1 ? MOUNT_PICKER : mounts[0] || "/";
  const [currentPath, setCurrentPath] = useState(initialPath);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<string | null>(null);
  const [openCount, setOpenCount] = useState(0);

  // Reset to initial path each time the dialog opens
  useEffect(() => {
    if (open) {
      setCurrentPath(initialPath);
      setEntries([]);
      setSelectedEntry(null);
      setError(null);
      setOpenCount((c) => c + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Load directory contents when path changes or dialog re-opens
  useEffect(() => {
    if (!open) return;

    // Mount picker view: show mounts as virtual folder entries (no fs call)
    if (currentPath === MOUNT_PICKER) {
      const mountEntries: FileEntry[] = mounts.map((m) => ({
        name: m,
        isDir: true,
      }));
      setEntries(mountEntries);
      setLoading(false);
      setError(null);
      setSelectedEntry(null);
      return;
    }

    let cancelled = false;
    const loadDir = async () => {
      setLoading(true);
      setError(null);
      setSelectedEntry(null);
      try {
        const result = await browseRemoteDir(currentPath);
        if (!cancelled) {
          // Sort: directories first, then alphabetical
          const sorted = [...result].sort((a, b) => {
            if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
          setEntries(sorted);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : "Failed to browse directory",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    loadDir();
    return () => {
      cancelled = true;
    };
  }, [openCount, currentPath, browseRemoteDir, mounts]);

  if (!open) return null;

  const isMountPicker = currentPath === MOUNT_PICKER;
  const pathParts = isMountPicker
    ? []
    : currentPath.split("/").filter(Boolean);

  const joinPath = (base: string, name: string) => {
    const cleanBase = base.endsWith("/") ? base.slice(0, -1) : base;
    return cleanBase === "" ? `/${name}` : `${cleanBase}/${name}`;
  };

  const navigateTo = (path: string) => {
    setCurrentPath(path);
  };

  const handleDoubleClick = (entry: FileEntry) => {
    if (!entry.isDir) return;
    // From mount picker, the entry name is the full mount path
    if (isMountPicker) {
      navigateTo(entry.name);
    } else {
      navigateTo(joinPath(currentPath, entry.name));
    }
  };

  const handleSelect = () => {
    if (isMountPicker) {
      // Mount picker: clicking "Select" with a mount selected navigates into it
      if (selectedEntry) navigateTo(selectedEntry);
      return;
    }
    if (mode === "directory") {
      // Select current directory or selected subdirectory
      if (selectedEntry) {
        const entry = entries.find((e) => e.name === selectedEntry);
        if (entry?.isDir) {
          onSelect(joinPath(currentPath, entry.name));
        }
      } else {
        onSelect(currentPath);
      }
    } else {
      // Select a file
      if (selectedEntry) {
        onSelect(joinPath(currentPath, selectedEntry));
      }
    }
    onClose();
  };

  const canSelect = isMountPicker
    ? selectedEntry != null
    : mode === "directory"
      ? true // Can always select current directory
      : selectedEntry != null &&
        !entries.find((e) => e.name === selectedEntry)?.isDir;

  const filterExts = fileFilter
    ? (Array.isArray(fileFilter) ? fileFilter : [fileFilter]).map((ext) =>
        ext.toLowerCase(),
      )
    : null;
  const filteredEntries = filterExts
    ? entries.filter((e) => {
        if (e.isDir) return true;
        const name = e.name.toLowerCase();
        return filterExts.some((ext) => name.endsWith(ext));
      })
    : entries;

  return (
    <div
      className="fixed inset-0 bg-black/70 flex items-center justify-center z-50"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-card border border-border rounded-lg w-[480px] max-h-[500px] flex flex-col shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-sm font-medium">Browse Worker Filesystem</h3>
          <Button variant="ghost" size="xs" onClick={onClose}>
            &times;
          </Button>
        </div>

        {/* Breadcrumb */}
        <div className="flex items-center gap-1 px-3 py-2 text-[11px] font-mono text-muted-foreground border-b border-border">
          {mounts.length > 1 && (
            <>
              <span
                className={`cursor-pointer ${
                  isMountPicker ? "text-foreground" : "hover:text-primary"
                }`}
                onClick={() => !isMountPicker && navigateTo(MOUNT_PICKER)}
              >
                Mounts
              </span>
              {!isMountPicker && <span className="text-border mx-0.5">/</span>}
            </>
          )}
          {!isMountPicker && (
            <>
              <span
                className="cursor-pointer hover:text-primary"
                onClick={() => navigateTo("/")}
              >
                /
              </span>
              {pathParts.map((part, i) => {
                const path = "/" + pathParts.slice(0, i + 1).join("/");
                const isLast = i === pathParts.length - 1;
                return (
                  <span key={path}>
                    <span
                      className={`cursor-pointer ${isLast ? "text-foreground" : "hover:text-primary"}`}
                      onClick={() => !isLast && navigateTo(path)}
                    >
                      {part}
                    </span>
                    {!isLast && <span className="text-border mx-0.5">/</span>}
                  </span>
                );
              })}
            </>
          )}
        </div>

        {/* File list */}
        <div className="flex-1 overflow-y-auto p-2">
          {loading && (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Loading...
            </div>
          )}
          {error && (
            <div className="bg-red-500/8 border border-red-500/20 rounded-md p-2 text-[11px] text-red-400">
              {error}
            </div>
          )}
          {!loading && !error && filteredEntries.length === 0 && (
            <p className="text-[11px] text-muted-foreground py-4 text-center">
              {isMountPicker ? "No mounts available on this worker" : "Empty directory"}
            </p>
          )}
          {!loading &&
            !error &&
            filteredEntries.map((entry) => (
              <div
                key={entry.name}
                className={`flex items-center gap-2 px-2.5 py-1.5 rounded cursor-pointer text-xs ${
                  selectedEntry === entry.name
                    ? "bg-primary/10 text-primary"
                    : "hover:bg-accent/50"
                }`}
                onClick={() => setSelectedEntry(entry.name)}
                onDoubleClick={() => handleDoubleClick(entry)}
              >
                {entry.isDir ? (
                  <Folder className="h-4 w-4 text-primary flex-shrink-0" />
                ) : (
                  <File className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                )}
                <span className="flex-1 truncate">{entry.name}</span>
                {entry.size != null && !entry.isDir && (
                  <span className="text-[10px] text-muted-foreground font-mono">
                    {formatSize(entry.size)}
                  </span>
                )}
                {entry.isDir && (
                  <span className="text-[10px] text-muted-foreground">
                    &rsaquo;
                  </span>
                )}
              </div>
            ))}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-4 py-2 border-t border-border">
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSelect} disabled={!canSelect}>
            {isMountPicker
              ? "Open Mount"
              : mode === "directory"
                ? "Select Folder"
                : "Select File"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
