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
import { mergeResultSummary } from "@/lib/mergeProject";
import {
  applyConflictResolutions,
  type ResolvedConflict,
} from "@/lib/mergeConflicts";

export const MergeConflictsCommand: Command = {
  // Same user-facing name as A2 so the undo/redo toast + Edit-menu label read
  // "Merge Into Project" regardless of which apply path ran.
  name: "MergeIntoProject",
  topics: [UpdateTopic.Labels, UpdateTopic.Frame, UpdateTopic.Instance],
  skipAutoSnapshot: true,
  async execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const { labels } = ctx.state;
    if (!labels) return;

    const donor = params?.other as Labels | undefined;
    if (!donor) return;

    const resolutions =
      (params?.resolutions as ResolvedConflict[] | undefined) ?? [];

    const snapshot = ctx.takeAllFramesSnapshot("MergeIntoProject");
    const result = await applyConflictResolutions(labels, donor, resolutions);
    ctx.pushUndoSnapshot(snapshot);
    ctx.state.markChanged();

    toast.success(mergeResultSummary(result));
  },
};
