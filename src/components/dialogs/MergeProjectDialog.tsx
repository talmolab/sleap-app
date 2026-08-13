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
 */

import { useState, useCallback, useMemo } from "react";
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

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

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

  const reset = useCallback(() => {
    setDonor(null);
    setDonorName("");
    setPreview(null);
    setConflicts([]);
    setDefaultChoice("both");
    setChoices({});
    setBusy(null);
    setError(null);
  }, []);

  const handleOpenChange = useCallback(
    (o: boolean) => {
      if (!o) reset();
      setOpen(o);
    },
    [reset, setOpen]
  );

  const pickAndPreview = useCallback(async () => {
    if (!labels) return;
    setError(null);
    const platform = await getPlatform();
    let result: string | string[] | File | File[] | null;
    try {
      result = await platform.showOpenDialog({
        filters: [{ name: "SLEAP Labels", extensions: ["slp"] }],
      });
    } catch (e) {
      setError(errMsg(e));
      return;
    }
    if (!result || Array.isArray(result)) return; // canceled

    setBusy("loading");
    setDonor(null);
    setPreview(null);
    setConflicts([]);
    setChoices({});
    try {
      const donorLabels =
        typeof result === "string"
          ? await loadLabelsFromSlpPath(result, platform.readFile)
          : await loadLabelsFromSlpFile(result);
      const name =
        typeof result === "string" ? result.split(/[\\/]/).pop() ?? result : result.name;
      // Same matchers as the merge, so the preview reflects what will happen.
      const match = await labels.match(donorLabels, MERGE_INTO_PROJECT_MATCHERS);
      const previewSummary = summarizeMatch(match);
      setDonor(donorLabels);
      setDonorName(name);
      setPreview(previewSummary);
      // Enumerate real per-instance conflicts (only meaningful if not blocked).
      if (!previewSummary.skeletonBlocked) {
        setConflicts(await enumerateConflicts(labels, donorLabels));
      }
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(null);
    }
  }, [labels]);

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
      handleOpenChange(false);
    } catch (e) {
      setError(errMsg(e));
      setBusy(null);
    }
  }, [donor, conflicts, choices, defaultChoice, handleOpenChange]);

  const blocked = preview?.skeletonBlocked ?? false;
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
            Merge another SLEAP <code>.slp</code> into the current project. Nothing
            changes until you click Merge.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 py-1">
          <Button variant="outline" size="sm" onClick={pickAndPreview} disabled={busy !== null}>
            {donorName ? "Choose a different file…" : "Choose .slp…"}
          </Button>
          {donorName && (
            <span className="truncate text-sm text-muted-foreground" title={donorName}>
              {donorName}
            </span>
          )}
        </div>

        {busy === "loading" && (
          <p className="text-sm text-muted-foreground">Reading, matching & finding conflicts…</p>
        )}

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

        {preview && (
          <>
            <Separator />
            <div className="space-y-1 text-sm">
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
            Cancel
          </Button>
          <Button onClick={handleMerge} disabled={!canMerge}>
            {busy === "merging"
              ? "Merging…"
              : hasConflicts
                ? `Merge (${conflicts.length} conflict${conflicts.length !== 1 ? "s" : ""})`
                : "Merge"}
          </Button>
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
        <span className="truncate text-xs text-muted-foreground" title={detail}>
          {detail}
        </span>
      )}
    </div>
  );
}
