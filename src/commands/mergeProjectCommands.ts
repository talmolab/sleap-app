/**
 * Merge-into-Project command (File ▸ Merge into Project…).
 *
 * Folds another already-loaded `Labels` (a user-picked `.slp`) into the current
 * project via sleap-io.js `Labels.merge` — the SAME engine the active-learning
 * merge-back ({@link MergePredictions}) uses. The dialog
 * ({@link file://./../components/dialogs/MergeProjectDialog.tsx}) owns the
 * file-pick, the non-mutating `Labels.match` preview, and the skeleton-mismatch
 * block; this command is the thin, undoable apply step.
 *
 * Matchers are LOCKED to `{ video: "basename", track: "name" }` — mirroring
 * MergePredictions: a donor file references the same videos under a possibly
 * different path (basename matches; also matches a pkg.slp's embedded video via
 * its retained source filename) and its tracks are matched by name so shared
 * identities collapse instead of duplicating under io's IDENTITY default. The
 * frame conflict strategy comes from the dialog's radio.
 */

import type { Labels } from "@talmolab/sleap-io.js";
import { UpdateTopic } from "../types";
import type { Command } from "./types";
import type { CommandContext } from "./CommandContext";
import { toast } from "@/lib/notify";
import {
  mergeStrategyToFrameStrategy,
  mergeResultSummary,
  type MergeStrategyChoice,
} from "@/lib/mergeProject";

/** Video/track matchers used for BOTH the preview `match` and the `merge`. */
export const MERGE_INTO_PROJECT_MATCHERS = {
  video: "basename",
  track: "name",
} as const;

export const MergeIntoProjectCommand: Command = {
  name: "MergeIntoProject",
  topics: [UpdateTopic.Labels, UpdateTopic.Frame, UpdateTopic.Instance],
  skipAutoSnapshot: true,
  async execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const { labels } = ctx.state;
    if (!labels) return;

    const other = params?.other as Labels | undefined;
    if (!other) return;

    const choice = (params?.strategy as MergeStrategyChoice) ?? "smart";

    const snapshot = ctx.takeAllFramesSnapshot("MergeIntoProject");
    const result = await labels.merge(other, {
      ...MERGE_INTO_PROJECT_MATCHERS,
      frame: mergeStrategyToFrameStrategy(choice),
    });
    ctx.pushUndoSnapshot(snapshot);
    ctx.state.markChanged();

    toast.success(mergeResultSummary(result));
  },
};
