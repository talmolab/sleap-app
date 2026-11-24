/**
 * Video-level commands (state that lives on `Video`, not on labeled frames).
 */

import { UpdateTopic } from "../types";
import type { Command } from "./types";
import type { CommandContext } from "./CommandContext";
import { dirtyFrameTracker } from "@/lib/autosaveDirty";
import { toast } from "@/lib/notify";
import {
  applyGrayscaleState,
  toggleGrayscaleAll,
  type GrayscaleState,
} from "@/lib/videoGrayscale";

/** Re-apply a set of video states and make the canvas re-read the frame. */
function restoreGrayscale(ctx: CommandContext, states: GrayscaleState[]): void {
  for (const s of states) applyGrayscaleState(s);
  afterGrayscaleChange(ctx);
}

/** Saves must rewrite videos_json; the player must re-decode the frame. */
function afterGrayscaleChange(ctx: CommandContext): void {
  dirtyFrameTracker.markStructural();
  ctx.state.markChanged();
  ctx.state.bumpBackendSwapNonce();
  ctx.state.markVideoUpdated();
}

/**
 * Toggle Grayscale — PyQt SLEAP's Videos-dock button (`commands.py`
 * `ToggleGrayscale`): reads the current video's grayscale state and switches
 * EVERY video to the opposite, silently. Undoable (⌘Z switches them back).
 */
export const ToggleGrayscale: Command = {
  name: "ToggleGrayscale",
  topics: [UpdateTopic.Video, UpdateTopic.Frame],
  skipAutoSnapshot: true,
  execute(ctx: CommandContext) {
    const { labels, video } = ctx.state;
    if (!labels) return;
    let result;
    try {
      result = toggleGrayscaleAll(labels.videos, video);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      return;
    }
    if (result.after.length === 0) return;

    const snapshot = ctx.takeSnapshot("ToggleGrayscale");
    snapshot.sideEffect = {
      undo: () => restoreGrayscale(ctx, result.before),
      redo: () => restoreGrayscale(ctx, result.after),
    };
    ctx.pushUndoSnapshot(snapshot);
    afterGrayscaleChange(ctx);
  },
};
