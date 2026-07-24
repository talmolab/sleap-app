/**
 * Welcome screen shown when no project is loaded (#132).
 *
 * A compact New/Open panel anchored bottom-center over the background imagery.
 * The whole screen is a drag-drop target for .slp files. When recoverable labels
 * drafts exist (browser large-pkg fast-save, resume-after-close), a "Restore
 * unsaved work?" card lists them above the New/Open panel.
 */

import { useCallback, useEffect, useState } from "react";
import { useFileIO } from "../../hooks/useFileIO";
import { useAppStore } from "../../stores/appStore";
import { Button } from "@/components/ui/button";
import { Plus, FolderOpen } from "lucide-react";
import {
  listDraftEntries,
  type DraftManifestEntry,
} from "@/lib/draftManifest";
import { restoreDraft, discardDraft } from "@/lib/draftRestore";

/** Compact "saved N ago" for the restore list. */
function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  return `${d} day${d > 1 ? "s" : ""} ago`;
}

export function WelcomeScreen() {
  const { openProject, openFromDrop, loading, error } = useFileIO();
  const [drafts, setDrafts] = useState<DraftManifestEntry[]>([]);

  // Discover recoverable drafts on mount (origin-shared across tabs).
  useEffect(() => {
    let alive = true;
    listDraftEntries()
      .then((entries) => {
        if (alive) setDrafts(entries);
      })
      .catch(() => {
        /* IndexedDB unavailable (e.g. private mode) — no drafts to offer */
      });
    return () => {
      alive = false;
    };
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file && file.name.endsWith(".slp")) {
        openFromDrop(file);
      }
    },
    [openFromDrop]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const onDiscard = useCallback(async (entry: DraftManifestEntry) => {
    if (
      !window.confirm(
        `Discard the unsaved work for "${entry.displayName}"? This can't be undone.`
      )
    ) {
      return;
    }
    await discardDraft(entry);
    setDrafts((ds) => ds.filter((d) => d.draftPath !== entry.draftPath));
  }, []);

  return (
    <div
      // Anchor the panel to the bottom (items-end) with padding so it sits in
      // the lower viewport and never clips (>=20px from the edge), #132.
      className="flex-1 flex items-end justify-center relative pb-6"
      style={{
        backgroundImage: `url(${import.meta.env.BASE_URL}background.jpg)`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <div className="relative z-10 flex flex-col items-center gap-2">
        {error && (
          <div className="max-w-sm text-center text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md border border-destructive/20">
            {error}
          </div>
        )}

        {/* Resume-after-close: recoverable browser labels drafts. */}
        {drafts.length > 0 && (
          <div className="w-full max-w-md rounded-xl border border-border bg-card/95 backdrop-blur-sm px-4 py-3 shadow-lg">
            <div className="text-sm font-medium mb-2">Restore unsaved work?</div>
            <ul className="flex flex-col gap-2">
              {drafts.map((d) => (
                <li
                  key={d.draftPath}
                  className="flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {d.displayName}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      saved {timeAgo(d.savedAt)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      size="sm"
                      disabled={loading}
                      onClick={() => void restoreDraft(d)}
                    >
                      Restore
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void onDiscard(d)}
                    >
                      Discard
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Compact popup: New + Open only */}
        <div className="flex items-center gap-3 rounded-xl border border-border bg-card/95 backdrop-blur-sm px-4 py-3 shadow-lg">
          <Button
            onClick={() => useAppStore.getState().setNewProjectDialogOpen(true)}
            size="lg"
          >
            <Plus className="h-4 w-4" />
            New Project
          </Button>
          <Button
            onClick={openProject}
            disabled={loading}
            variant="outline"
            size="lg"
          >
            <FolderOpen className="h-4 w-4" />
            {loading ? "Loading..." : "Open Project"}
          </Button>
        </div>

        <p className="text-xs text-muted-foreground/80">
          Drag &amp; drop a .slp file anywhere
        </p>
      </div>
    </div>
  );
}
