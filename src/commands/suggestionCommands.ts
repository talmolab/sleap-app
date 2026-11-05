/**
 * Labeling-suggestion edits (the Suggestions panel's Add / Remove / Clear all
 * / Generate / Shuffle) as an undoable command. They used to replace
 * `labels.suggestions` directly, so they had no undo step of their own — and
 * Undo after one instead reverted the previous edit, whose snapshot also
 * brought the old suggestions back.
 */

import { UpdateTopic } from "../types";
import type { SuggestionFrame } from "../types";
import type { Command } from "./types";
import type { CommandContext } from "./CommandContext";
import { dirtyFrameTracker } from "@/lib/autosaveDirty";

/** Replace the project's suggestion list with `params.suggestions`. */
export const SetSuggestions: Command = {
  name: "EditSuggestions",
  topics: [UpdateTopic.Suggestions],
  execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const labels = ctx.state.labels;
    const next = params?.suggestions as SuggestionFrame[] | undefined;
    if (!labels || !next) return;
    labels.suggestions = next;
    // Suggestions live outside any frame: the autosave journal must write
    // the project's structure, not just the current frame.
    dirtyFrameTracker.markStructural();
    ctx.state.markChanged();
  },
};
