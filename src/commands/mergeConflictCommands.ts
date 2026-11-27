/**
 * Merge-into-Project APPLY with per-conflict resolutions (A3).
 *
 * The dialog computes conflicts ({@link file://../lib/mergeConflicts.ts}
 * enumerateConflicts), seeds each with the global default, lets the user
 * override, then dispatches this command with the resolved list. Apply =
 * pre-delete the losers + one `keep_both` merge (see design doc), wrapped in a
 * single undo snapshot — the same A2 snapshot that covers frames/tracks/videos/
 * skeletons/suggestions. With every choice `"both"` this equals A2's Keep-both.
 */

import type { Labels } from "@talmolab/sleap-io.js";
import { UpdateTopic } from "../types";
import type { Command } from "./types";
import type { CommandContext } from "./CommandContext";
import { toast } from "@/lib/notify";
import {
  mergeResultSummary,
  reconcileSkeletonsInPlace,
  type SkeletonMergeMode,
} from "@/lib/mergeProject";
import type { UnmappedNodeFill } from "@/lib/skeletonIO";
import { attachSkeletonUndoToSnapshot } from "@/commands/skeletonCommands";
import {
  applyConflictResolutions,
  type ResolvedConflict,
} from "@/lib/mergeConflicts";

export const MergeConflictsCommand: Command = {
  // Same user-facing name as A2 so the undo/redo toast + Edit-menu label read
  // "Merge Into Project" regardless of which apply path ran.
  name: "MergeIntoProject",
  topics: [
    UpdateTopic.Labels,
    UpdateTopic.Skeleton,
    UpdateTopic.Frame,
    UpdateTopic.Instance,
  ],
  skipAutoSnapshot: true,
  async execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const { labels } = ctx.state;
    if (!labels) return;

    const donor = params?.other as Labels | undefined;
    if (!donor) return;

    const resolutions =
      (params?.resolutions as ResolvedConflict[] | undefined) ?? [];
    const skeletonMode = params?.skeletonMode as SkeletonMergeMode | undefined;
    const unmapped: UnmappedNodeFill =
      params?.unmapped === "absent" ? "absent" : "unlabeled";

    const snapshot = ctx.takeAllFramesSnapshot("MergeIntoProject");
    let unified = false;
    if (
      skeletonMode === "unify" &&
      labels.skeletons.length === 1 &&
      donor.skeletons.length === 1
    ) {
      attachSkeletonUndoToSnapshot(ctx, snapshot, labels.skeletons[0]);
      reconcileSkeletonsInPlace(labels, donor, unmapped);
      unified = true;
    }

    const result = await applyConflictResolutions(labels, donor, resolutions);
    ctx.pushUndoSnapshot(snapshot);
    ctx.state.markChanged();
    if (unified || skeletonMode === "separate") {
      ctx.state.bumpOverlayVersion();
    }

    toast.success(mergeResultSummary(result));
  },
};
