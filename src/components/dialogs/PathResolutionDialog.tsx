/**
 * Path Resolution Dialog
 *
 * Shows all files that need path resolution before remote job submission.
 * Displays a table with filename, status (resolved/missing), and worker path.
 * Provides Browse buttons for unresolved paths, an "Auto-detect in folder"
 * feature, and cascade-fill when a prefix difference is detected.
 */

import { useState, useEffect } from "react";
import { Check, X, FolderSearch } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RemoteFileBrowser } from "@/components/dialogs/RemoteFileBrowser";
import { useConnectStore } from "@/stores/connectStore";
import type { ResolvedPath } from "@/lib/pathMappings";
import { detectPrefixDiff } from "@/lib/pathMappings";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PathResolutionDialogProps {
  open: boolean;
  paths: ResolvedPath[];
  onSubmit: (resolvedPaths: Array<{ local: string; worker: string }>) => void;
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function basename(path: string): string {
  return path.split("/").pop() || path;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PathResolutionDialog({
  open,
  paths: initialPaths,
  onSubmit,
  onCancel,
}: PathResolutionDialogProps) {
  const [paths, setPaths] = useState<ResolvedPath[]>(initialPaths);
  const [browsingIndex, setBrowsingIndex] = useState<number | null>(null);
  const [folderBrowseMode, setFolderBrowseMode] = useState(false);

  // Get worker mounts from the connect store
  const workers = useConnectStore((s) => s.workers);
  const selectedWorkerId = useConnectStore((s) => s.selectedWorkerId);
  const selectedWorker = workers.find((w) => w.peerId === selectedWorkerId);
  const workerMounts = selectedWorker?.mounts ?? [];

  // Reset state when dialog opens with new paths
  useEffect(() => {
    if (open) {
      setPaths(initialPaths);
      setBrowsingIndex(null);
      setFolderBrowseMode(false);
    }
  }, [open, initialPaths]);

  // Count resolved paths
  const resolvedCount = paths.filter((p) => p.worker !== null).length;
  const allResolved = resolvedCount === paths.length;

  /**
   * Apply cascade-fill: when a path is resolved, detect prefix difference
   * and apply it to other unresolved paths that share the same local prefix.
   */
  function applyCascadeFill(
    updatedPaths: ResolvedPath[],
    resolvedIndex: number,
  ): ResolvedPath[] {
    const resolved = updatedPaths[resolvedIndex];
    if (!resolved.worker) return updatedPaths;

    const mapping = detectPrefixDiff(resolved.local, resolved.worker);
    if (!mapping) return updatedPaths;

    return updatedPaths.map((p, i) => {
      if (i === resolvedIndex) return p;
      if (p.worker !== null) return p;

      // Check if this path shares the same local prefix
      const normalizedPrefix = mapping.local.replace(/\/+$/, "");
      if (p.local.startsWith(normalizedPrefix)) {
        const suffix = p.local.slice(normalizedPrefix.length);
        const workerPath = mapping.worker.replace(/\/+$/, "") + suffix;
        return { ...p, worker: workerPath, status: "resolved" as const };
      }
      return p;
    });
  }

  /** Handle a file selected via the RemoteFileBrowser for a specific row. */
  function handleFileSelect(path: string) {
    if (browsingIndex === null) return;

    const updated = paths.map((p, i) =>
      i === browsingIndex ? { ...p, worker: path, status: "resolved" as const } : p,
    );

    const cascaded = applyCascadeFill(updated, browsingIndex);
    setPaths(cascaded);
    setBrowsingIndex(null);
  }

  /** Handle folder selected for auto-detect mode. */
  function handleFolderSelect(folder: string) {
    const normalizedFolder = folder.replace(/\/+$/, "");
    const updated = paths.map((p) => {
      if (p.worker !== null) return p;
      const filename = basename(p.local);
      return {
        ...p,
        worker: `${normalizedFolder}/${filename}`,
        status: "resolved" as const,
      };
    });
    setPaths(updated);
    setFolderBrowseMode(false);
  }

  /** Handle manual entry confirmed (Enter key or blur). */
  function handleManualEntry(index: number, value: string) {
    if (!value.trim()) return;

    const updated = paths.map((p, i) =>
      i === index ? { ...p, worker: value.trim(), status: "resolved" as const } : p,
    );

    const cascaded = applyCascadeFill(updated, index);
    setPaths(cascaded);
  }

  /** Handle submit. */
  function handleSubmit() {
    const result = paths.map((p) => ({
      local: p.local,
      worker: p.worker!,
    }));
    onSubmit(result);
  }

  const isBrowsing = browsingIndex !== null || folderBrowseMode;

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onCancel(); }}>
      <DialogContent className="w-[50vw] max-w-none max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Path Resolution</DialogTitle>
          <DialogDescription>
            Resolve file paths for the remote worker before submitting.
          </DialogDescription>
        </DialogHeader>

        {/* Path table */}
        <div className="border rounded-md overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50">
              <tr>
                <th className="text-left px-3 py-2 font-medium">File</th>
                <th className="text-center px-3 py-2 font-medium w-16">Status</th>
                <th className="text-left px-3 py-2 font-medium">Worker Path</th>
              </tr>
            </thead>
            <tbody>
              {paths.map((p, index) => (
                <tr key={p.local} className="border-t">
                  <td className="px-3 py-2 max-w-[160px]">
                    <div className="overflow-x-auto whitespace-nowrap text-xs font-mono scrollbar-thin" title={p.local}>
                      {basename(p.local)}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-center">
                    {p.worker !== null ? (
                      <Check className="inline-block h-4 w-4 text-green-500" />
                    ) : (
                      <X className="inline-block h-4 w-4 text-red-500" />
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {p.worker !== null ? (
                      <div
                        className="text-muted-foreground overflow-x-auto whitespace-nowrap max-w-[550px] text-xs font-mono scrollbar-thin select-text"
                        title={p.worker}
                      >
                        {p.worker}
                      </div>
                    ) : (
                      <div className="flex gap-1">
                        <Input
                          className="h-7 text-xs"
                          placeholder="Worker path..."
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              handleManualEntry(
                                index,
                                (e.target as HTMLInputElement).value,
                              );
                            }
                          }}
                          onBlur={(e) => {
                            if (e.target.value.trim()) {
                              handleManualEntry(index, e.target.value);
                            }
                          }}
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2 text-xs shrink-0"
                          onClick={() => {
                            setFolderBrowseMode(false);
                            setBrowsingIndex(index);
                          }}
                        >
                          Browse
                        </Button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Auto-detect button */}
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="text-xs"
            onClick={() => {
              setBrowsingIndex(null);
              setFolderBrowseMode(true);
            }}
            disabled={allResolved}
          >
            <FolderSearch className="h-4 w-4 mr-1" />
            Auto-detect in folder...
          </Button>
        </div>

        {/* Remote file browser (inline, below the table) */}
        {isBrowsing && (
          <div className="border rounded-md p-2">
            <RemoteFileBrowser
              open={isBrowsing}
              onClose={() => {
                setBrowsingIndex(null);
                setFolderBrowseMode(false);
              }}
              onSelect={folderBrowseMode ? handleFolderSelect : handleFileSelect}
              mounts={workerMounts}
              mode={folderBrowseMode ? "directory" : "file"}
            />
          </div>
        )}

        {/* Status line */}
        <p className="text-sm text-muted-foreground">
          {resolvedCount} of {paths.length} paths resolved
        </p>

        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!allResolved}>
            Submit
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
