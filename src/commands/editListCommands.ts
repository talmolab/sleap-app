/**
 * Shift one video's labels earlier by the number of frames its MP4/MOV edit
 * list hides (sleap-io.js #274) — one undoable step. See `lib/editListShift.ts`.
 */

import { UpdateTopic } from "../types";
import type { Video } from "../types";
import type { Command } from "./types";
import type { CommandContext } from "./CommandContext";
import { applyLabelShift, planHasChanges } from "@/lib/editListShift";

export const SHIFT_VIDEO_LABELS_COMMAND_NAME = "ShiftVideoLabels";

/** The video's file name, for the undo label. */
function videoName(video: Video): string {
  const f = Array.isArray(video.filename) ? (video.filename[0] ?? "") : video.filename;
  return f.split(/[\\/]/).pop() || "video";
}

/**
 * Params: `video` (the project video) and `by` (frames to move earlier, > 0).
 * Moves user instances, user annotations, negative marks and suggestions;
 * predictions stay. Self-contained undo: a whole-project snapshot taken before
 * the shift (frames are re-created, so a per-frame snapshot can't cover it).
 * The view stays on the same frame number, now showing that frame's labels.
 */
export const ShiftVideoLabelsCommand: Command = {
  name: SHIFT_VIDEO_LABELS_COMMAND_NAME,
  topics: [UpdateTopic.Labels, UpdateTopic.Frame, UpdateTopic.Instance, UpdateTopic.Suggestions],
  skipAutoSnapshot: true,
  execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const { labels } = ctx.state;
    const video = params?.video as Video | undefined;
    const by = Number(params?.by ?? 0);
    if (!labels || !video || !labels.videos.includes(video)) return;
    if (!Number.isInteger(by) || by <= 0) return;

    const snapshot = ctx.takeAllFramesSnapshot(SHIFT_VIDEO_LABELS_COMMAND_NAME);
    const result = applyLabelShift(labels, video, by);
    if (!planHasChanges(result)) return;
    snapshot.label = `Shift labels ${by} frame${by === 1 ? "" : "s"} earlier on ${videoName(video)}`;
    ctx.pushUndoSnapshot(snapshot);

    // The frame objects were rebuilt: point the view at the current frame's new
    // object (or none) so the canvas shows what is on this frame now.
    const { video: activeVideo, frameIdx } = ctx.state;
    if (activeVideo) {
      const current = labels.find({ video: activeVideo, frameIdx });
      ctx.state.setLabeledFrame(current[0] ?? null);
    }
    ctx.state.setInstance(null);
    ctx.state.bumpOverlayVersion();
    ctx.state.markChanged();
  },
};
