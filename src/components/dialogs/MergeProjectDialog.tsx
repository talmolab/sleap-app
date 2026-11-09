/**
 * Merge into Project dialog (File ▸ Merge into Project…).
 *
 * Pick a donor `.slp`, load it WITHOUT activating, show a non-mutating
 * structural preview (videos/skeleton/tracks — via `Labels.match`). A skeleton
 * mismatch BLOCKS the merge. Otherwise we enumerate real per-instance conflicts
 * (5px spatial, user-vs-user); if any, the user resolves them per-row (A3,
 * {@link ConflictReview}) seeded by a global default, then merges via
 * {@link MergeConflictsCommand} (undoable). A clean merge (no conflicts) just
 * combines the two. See memory `project_merge_into_project_design`.
 *
 * Several files at once, as legacy SLEAP's MergeProject does (its "import
 * predictions" action, sleap/gui/commands.py): the picker takes any number of
 * `.slp` files, and they are previewed and merged ONE AT A TIME in the order
 * picked. Each file gets its own preview and conflict review, and each merge is
 * its own undo step. Legacy shows a separate MergeDialog per file, and closing
 * one moves on to the next file; here Skip (or closing the dialog) does the
 * same, so every file is either merged or explicitly skipped.
 */

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import type { Labels } from "@talmolab/sleap-io.js";
import { useAppStore } from "../../stores/appStore";
import { commandContext } from "../../commands/CommandContext";
import { MERGE_INTO_PROJECT_MATCHERS } from "../../commands/mergeProjectCommands";
import { MergeConflictsCommand } from "../../commands/mergeConflictCommands";
import {
  enumerateConflicts,
  mergeStats,
  type Conflict,
  type ConflictChoice,
  type ResolvedConflict,
} from "../../lib/mergeConflicts";
import { loadLabelsFromSlpFile, loadLabelsFromSlpPath } from "../../lib/loadProject";
import { summarizeMatch, type MatchPreview } from "../../lib/mergeProject";
import { getPlatform } from "../../platform/index";
import { ConflictReview } from "./ConflictReview";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A file to merge: a path on desktop, a File in the browser. */
export type MergeSource = string | File;

const sourceName = (source: MergeSource) =>
  typeof source === "string" ? source.split(/[\\/]/).pop() ?? source : source.name;

/** The picker's result as a list: one file, several, or none (canceled). */
export function pickedSources(
  result: string | string[] | File | File[] | null | undefined
): MergeSource[] {
  if (!result) return [];
  return Array.isArray(result) ? [...result] : [result];
}

export function MergeProjectDialog() {
  const open = useAppStore((s) => s.mergeProjectDialogOpen);
  const setOpen = useAppStore((s) => s.setMergeProjectDialogOpen);
  const labels = useAppStore((s) => s.labels);

  const [donor, setDonor] = useState<Labels | null>(null);
  const [donorName, setDonorName] = useState("");
  const [preview, setPreview] = useState<MatchPreview | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [defaultChoice, setDefaultChoice] = useState<ConflictChoice>("both");
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>({});
  const [busy, setBusy] = useState<null | "loading" | "merging">(null);
  const [error, setError] = useState<string | null>(null);
  // The files picked together, merged one at a time; `queuePos` is the one
  // shown now. A single pick (or a dropped file) is a queue of one.
  const [queue, setQueue] = useState<MergeSource[]>([]);
  const [queuePos, setQueuePos] = useState(0);
  // Bumped whenever the file shown changes or the dialog resets, so a load
  // that finishes after you skipped past it (or closed) is ignored instead of
  // replacing the preview of the file now shown.
  const loadSeq = useRef(0);

  /** Clear everything about the file being shown (not the queue). */
  const resetFile = useCallback(() => {
    loadSeq.current++;
    setDonor(null);
    setDonorName("");
    setPreview(null);
    setConflicts([]);
    setDefaultChoice("both");
    setChoices({});
    setBusy(null);
    setError(null);
  }, []);

  const reset = useCallback(() => {
    resetFile();
    setQueue([]);
    setQueuePos(0);
  }, [resetFile]);

  // Load a donor .slp (by path or File) and compute the non-mutating preview.
  // Shared by the file picker and the drop-seeded open.
  const previewDonor = useCallback(
    async (source: MergeSource) => {
      if (!labels) return;
      resetFile();
      const seq = loadSeq.current;
      const stale = () => seq !== loadSeq.current;
      // Name the file before reading it, so a file that fails to load still
      // says which one it was (and can be skipped).
      setDonorName(sourceName(source));
      setBusy("loading");
      try {
        const platform = await getPlatform();
        const donorLabels =
          typeof source === "string"
            ? await loadLabelsFromSlpPath(source, platform.readFile)
            : await loadLabelsFromSlpFile(source);
        // Same matchers as the merge, so the preview reflects what will happen.
        const match = await labels.match(donorLabels, MERGE_INTO_PROJECT_MATCHERS);
        if (stale()) return;
        const previewSummary = summarizeMatch(match);
        setDonor(donorLabels);
        setPreview(previewSummary);
        // Enumerate real per-instance conflicts (only meaningful if not blocked).
        if (!previewSummary.skeletonBlocked) {
          const found = await enumerateConflicts(labels, donorLabels);
          if (stale()) return;
          setConflicts(found);
        }
      } catch (e) {
        if (!stale()) setError(errMsg(e));
      } finally {
        if (!stale()) setBusy(null);
      }
    },
    [labels, resetFile]
  );

  /** Start a new queue and show its first file. */
  const startQueue = useCallback(
    async (sources: MergeSource[]) => {
      if (sources.length === 0) return;
      setQueue(sources);
      setQueuePos(0);
      await previewDonor(sources[0]);
    },
    [previewDonor]
  );

  /**
   * Done with the file shown (merged or skipped): show the next one, or close
   * when it was the last, like legacy's per-file MergeDialog loop.
   */
  const advance = useCallback(async () => {
    const next = queuePos + 1;
    if (next < queue.length) {
      setQueuePos(next);
      await previewDonor(queue[next]);
    } else {
      reset();
      setOpen(false);
    }
  }, [queue, queuePos, previewDonor, reset, setOpen]);

  const handleOpenChange = useCallback(
    (o: boolean) => {
      if (o) {
        setOpen(true);
        return;
      }
      // Never abandon a merge that's being applied.
      if (busy === "merging") return;
      // Closing skips to the next picked file, as closing one of legacy's
      // per-file merge dialogs did; on the last (or only) file it closes.
      void advance();
    },
    [busy, advance, setOpen]
  );

  const pickAndPreview = useCallback(async () => {
    if (!labels) return;
    setError(null);
    const platform = await getPlatform();
    let result: string | string[] | File | File[] | null;
    try {
      result = await platform.showOpenDialog({
        multiple: true,
        filters: [{ name: "SLEAP Labels", extensions: ["slp"] }],
      });
    } catch (e) {
      setError(errMsg(e));
      return;
    }
    const sources = pickedSources(result);
    if (sources.length === 0) return; // canceled: keep whatever is shown
    await startQueue(sources);
  }, [labels, startQueue]);

  // Seeded open: an .slp drop routed here with a path → auto-load + preview it.
  const seedPath = useAppStore((s) => s.mergeProjectSeedPath);
  const setSeedPath = useAppStore((s) => s.setMergeProjectSeedPath);
  useEffect(() => {
    if (open && seedPath) {
      const p = seedPath;
      setSeedPath(null);
      void startQueue([p]);
    }
  }, [open, seedPath, setSeedPath, startQueue]);

  const handleMerge = useCallback(async () => {
    if (!donor) return;
    setBusy("merging");
    try {
      const resolutions: ResolvedConflict[] = conflicts.map((c) => ({
        conflict: c,
        choice: choices[c.id] ?? defaultChoice,
      }));
      await commandContext.execute(MergeConflictsCommand, {
        other: donor,
        resolutions,
      });
      setBusy(null);
      await advance();
    } catch (e) {
      setError(errMsg(e));
      setBusy(null);
    }
  }, [donor, conflicts, choices, defaultChoice, advance]);

  const blocked = preview?.skeletonBlocked ?? false;
  const multi = queue.length > 1;
  const isLast = queuePos >= queue.length - 1;
  const canMerge = !!donor && !blocked && busy === null;
  const hasConflicts = conflicts.length > 0;
  const stats = useMemo(
    () => (donor ? mergeStats(donor, conflicts) : null),
    [donor, conflicts]
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className={hasConflicts ? "sm:max-w-[640px]" : "sm:max-w-[440px]"}>
        <DialogHeader>
          <DialogTitle>Merge into Project</DialogTitle>
          <DialogDescription>
            Merge other SLEAP <code>.slp</code> files into the current project, one
            at a time. Nothing changes until you click Merge.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 items-center gap-2 py-1">
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={pickAndPreview}
            disabled={busy !== null}
          >
            {donorName ? "Choose different files…" : "Choose .slp files…"}
          </Button>
          {multi && (
            <span
              className="shrink-0 text-sm font-medium tabular-nums"
              data-testid="merge-queue-position"
            >
              File {queuePos + 1} of {queue.length}
            </span>
          )}
          {donorName && (
            <span
              className="min-w-0 flex-1 truncate text-sm text-muted-foreground"
              title={donorName}
            >
              {donorName}
            </span>
          )}
        </div>

        {busy === "loading" && (
          <p className="text-sm text-muted-foreground">Reading, matching & finding conflicts…</p>
        )}

        {error && (
          <p className="text-sm text-red-600 dark:text-red-400" data-testid="merge-load-error">
            {error}
          </p>
        )}

        {preview && (
          <>
            <Separator />
            <div className="min-w-0 space-y-1 text-sm">
              <div className="font-medium text-muted-foreground">
                Preview (nothing changed yet)
              </div>
              <PreviewRow
                label="Videos"
                text={`${preview.videosMatched} matched · ${preview.videosNew} new`}
                detail={preview.newVideoNames.length ? preview.newVideoNames.join(", ") : undefined}
              />
              <PreviewRow
                label="Skeleton"
                text={preview.skeletonBlocked ? "⚠ differs" : "✓ matches"}
                warn={preview.skeletonBlocked}
              />
              <PreviewRow
                label="Tracks"
                text={`${preview.tracksMatched} matched · ${preview.tracksNew} new`}
              />
            </div>
          </>
        )}

        {blocked && (
          <p className="text-sm text-red-600 dark:text-red-400">
            The incoming file's skeleton doesn't match this project's, so it can't
            be merged. Open it as its own project, or reconcile the skeletons first.
          </p>
        )}

        {preview && !blocked && (
          <>
            <Separator />
            {hasConflicts && stats ? (
              <ConflictReview
                conflicts={conflicts}
                stats={stats}
                tracks={labels?.tracks ?? []}
                defaultChoice={defaultChoice}
                onDefaultChange={setDefaultChoice}
                choices={choices}
                onChoiceChange={(id, c) =>
                  setChoices((prev) => ({ ...prev, [id]: c }))
                }
                onReset={() => setChoices({})}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                No overlapping instances — this is a clean merge.
              </p>
            )}
          </>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={busy === "merging"}>
            {multi && !isLast ? "Skip this file" : multi ? "Skip and close" : "Cancel"}
          </Button>
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                {/* span so the tooltip still shows while the button is disabled */}
                <span tabIndex={0}>
                  <Button onClick={handleMerge} disabled={!canMerge}>
                    {busy === "merging"
                      ? "Merging…"
                      : hasConflicts
                        ? `Merge (${conflicts.length} conflict${conflicts.length !== 1 ? "s" : ""})`
                        : "Merge"}
                  </Button>
                </span>
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                Runs the merge pipeline — a structural preview and per-conflict
                review — not an immediate merge. Nothing changes until you confirm here.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PreviewRow({
  label,
  text,
  detail,
  warn,
}: {
  label: string;
  text: string;
  detail?: string;
  warn?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
      <span className={warn ? "text-red-600 dark:text-red-400" : undefined}>{text}</span>
      {detail && (
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground" title={detail}>
          {detail}
        </span>
      )}
    </div>
  );
}
