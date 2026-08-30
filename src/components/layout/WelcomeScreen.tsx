/**
 * Welcome screen shown when no project is loaded (#132).
 *
 * A compact New/Open panel anchored bottom-center over the background imagery.
 * The whole screen is a drag-drop target for .slp files. When recoverable labels
 * drafts exist, a "Restore unsaved work?" card lists them above the New/Open
 * panel — a single in-app recovery surface for BOTH runtimes (browser OPFS fast-
 * save + desktop on-disk crash draft). Recovery is always a USER click here, never
 * an automatic pop-up, so it can't double-fire and is trivially escapable.
 */

import { useCallback, useEffect, useState } from "react";
import { useFileIO } from "../../hooks/useFileIO";
import { useAppStore } from "../../stores/appStore";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Plus, FolderOpen, Cpu } from "lucide-react";
import {
  loadRecoverableDrafts,
  type RecoverableDraft,
} from "@/lib/recoverableDrafts";
import { WelcomeEnvironmentsPanel } from "./WelcomeEnvironmentsPanel";
import { UpdatePingDot, UpdatePill, useEnvironmentUpdateStatus } from "./UpdateIndicator";
import { cn } from "@/lib/utils";

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
  const [drafts, setDrafts] = useState<RecoverableDraft[]>([]);
  // Which draft (if any) is mid "discard — are you sure?". An in-app inline
  // confirm (keyed by draft path) that replaces the old window.confirm.
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const [showEnvironments, setShowEnvironments] = useState(false);
  const hasSeenLabelingHintsPrompt = useAppStore((s) => s.hasSeenLabelingHintsPrompt);
  const showLabelingHints = useAppStore((s) => s.showLabelingHints);
  const answerLabelingHintsPrompt = useCallback((wantsHints: boolean) => {
    const store = useAppStore.getState();
    store.set("showLabelingHints", wantsHints);
    store.set("hasSeenLabelingHintsPrompt", true);
  }, []);
  const {
    available: environmentUpdateAvailable,
    title: environmentUpdateTitle,
  } = useEnvironmentUpdateStatus();

  // Discover recoverable drafts on mount — both runtimes (browser OPFS + desktop
  // disk), normalized. Idempotent (a StrictMode double-invoke just re-lists).
  useEffect(() => {
    let alive = true;
    loadRecoverableDrafts()
      .then((entries) => {
        if (alive) setDrafts(entries);
      })
      .catch(() => {
        /* discovery unavailable (e.g. private mode) — nothing to offer */
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

  const onConfirmDiscard = useCallback(async (entry: RecoverableDraft) => {
    await entry.discard();
    setDrafts((ds) => ds.filter((d) => d.key !== entry.key));
    setConfirmingKey(null);
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
      <Button
        onClick={() => setShowEnvironments((v) => !v)}
        variant="ghost"
        size="sm"
        className={cn(
          "absolute bottom-3 right-3 z-30 bg-card/80 backdrop-blur-sm hover:bg-card",
          environmentUpdateAvailable && "ring-1 ring-orange-500/60"
        )}
      >
        <span className="relative flex items-center">
          <Cpu className="h-4 w-4" />
          {environmentUpdateAvailable && (
            <UpdatePingDot className="-top-0.5 -right-0.5" />
          )}
        </span>
        Environment
        {environmentUpdateAvailable && (
          <UpdatePill title={environmentUpdateTitle}>Update available</UpdatePill>
        )}
      </Button>

      {showEnvironments && (
        <WelcomeEnvironmentsPanel onClose={() => setShowEnvironments(false)} />
      )}

      <div className="relative z-10 flex flex-col items-center gap-2">
        {error && (
          <div className="max-w-sm text-center text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md border border-destructive/20">
            {error}
          </div>
        )}

        {/* Resume-after-close: recoverable labels drafts (browser OPFS + desktop). */}
        {drafts.length > 0 && (
          <div className="w-full max-w-md rounded-xl border border-border bg-card/95 backdrop-blur-sm px-4 py-3 shadow-lg">
            <div className="text-sm font-medium mb-2">Restore unsaved work?</div>
            <ul className="flex flex-col gap-2">
              {drafts.map((d) => (
                <li
                  key={d.key}
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
                    {confirmingKey === d.key ? (
                      <>
                        <span className="text-xs text-muted-foreground">
                          Discard permanently?
                        </span>
                        <Button
                          size="sm"
                          variant="destructive"
                          onClick={() => void onConfirmDiscard(d)}
                        >
                          Discard
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmingKey(null)}
                        >
                          Cancel
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          size="sm"
                          disabled={loading}
                          onClick={() => void d.restore()}
                        >
                          Restore
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmingKey(d.key)}
                        >
                          Discard
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex items-center gap-3">
          {/* One-time "new to SLEAP?" prompt (#341), off to the side rather
              than stacked in-line — sets the default for the contextual
              labeling hints. Answering either way (or dismissing) marks it
              seen so it never asks again. Shown once, ever. */}
          {!hasSeenLabelingHintsPrompt && (
            <div className="w-52 rounded-lg border border-border/60 bg-card/70 backdrop-blur-sm px-3 py-2.5 shadow-md">
              <div className="flex items-start justify-between gap-2">
                <span className="text-xs font-medium text-foreground/90">
                  New to SLEAP?
                </span>
                <button
                  type="button"
                  aria-label="Dismiss"
                  className="text-xs leading-none text-muted-foreground hover:text-foreground"
                  onClick={() =>
                    useAppStore.getState().set("hasSeenLabelingHintsPrompt", true)
                  }
                >
                  ✕
                </button>
              </div>
              <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                Show gentle tips for common labeling pitfalls as you go?
              </p>
              <div className="mt-2 flex gap-1.5">
                <Button size="xs" onClick={() => answerLabelingHintsPrompt(true)}>
                  Yes
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => answerLabelingHintsPrompt(false)}
                >
                  No
                </Button>
              </div>
            </div>
          )}

          {/* Compact popup: New + Open only */}
          <div className="flex items-center gap-3 rounded-xl border border-border bg-card/95 backdrop-blur-sm px-4 py-3 shadow-lg">
            <Button
              onClick={() => useAppStore.getState().setNewProjectDialogOpen(true)}
              size="lg"
              data-tutorial="new-project-button"
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
        </div>

        <p className="text-xs text-muted-foreground/80">
          Drag &amp; drop a .slp file anywhere
        </p>

        {/* Persistent (not one-time, unlike the prompt above) — same setting
            as Labels > Show Hints During Labeling, surfaced here too since
            not everyone finds it in the menu. */}
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground/80">
          <Checkbox
            className="h-3.5 w-3.5"
            checked={showLabelingHints}
            onCheckedChange={(checked) =>
              useAppStore.getState().set("showLabelingHints", checked === true)
            }
          />
          Show labeling hints
        </label>
        <p className="text-xs text-muted-foreground/60">
          See all of them anytime under Help → Labeling Tips
        </p>
      </div>
    </div>
  );
}
