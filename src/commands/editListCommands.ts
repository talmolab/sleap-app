/**
 * Shift one video's labels earlier by the number of frames its MP4/MOV edit
 * list hides (sleap-io.js #274) — one undoable step. See `lib/editListShift.ts`.
 */

import { UpdateTopic } from "../types";
import type { Labels, Video } from "../types";
import type { Command } from "./types";
import type { CommandContext } from "./CommandContext";
import {
  applyLabelShift,
  planHasChanges,
  setVideoRecord,
  videoName,
} from "@/lib/editListShift";

export const SHIFT_VIDEO_LABELS_COMMAND_NAME = "ShiftVideoLabels";

/** The undo label for a shift (also how undo/redo of it is recognized). */
export function shiftUndoLabel(video: Video, by: number): string {
  return `Shift labels ${by} frame${by === 1 ? "" : "s"} earlier on ${videoName(video)}`;
}

/**
 * The video's "shifted" record lives in `labels.provenance`, which undo/redo
 * don't restore. Keep it in step: once the shift is undone (it's the next
 * redo) the video is recorded as "kept" — undoing the shift is choosing to
 * keep the labels, and asking again on a later open could shift labels made
 * after the undo (already in the new numbering); once it's redone (it's the
 * next undo) it's "shifted" again. Further steps on either side leave the last
 * state, which is still right.
 */
const trackedShifts = new WeakMap<CommandContext, Map<string, { labels: Labels; video: Video }>>();

function trackShiftRecord(ctx: CommandContext, label: string, labels: Labels, video: Video): void {
  let shifts = trackedShifts.get(ctx);
  if (!shifts) {
    const map = new Map<string, { labels: Labels; video: Video }>();
    shifts = map;
    trackedShifts.set(ctx, map);
    ctx.onUpdate(() => {
      const current = ctx.state.labels;
      for (const [key, shift] of map) {
        if (shift.labels !== current) {
          map.delete(key); // another project: its history is gone
        } else if (ctx.redoLabel === key) {
          setVideoRecord(shift.labels, shift.video, "kept");
        } else if (ctx.undoLabel === key) {
          setVideoRecord(shift.labels, shift.video, "shifted");
        }
      }
    });
  }
  shifts.set(label, { labels, video });
}

/**
 * Params: `video` (the project video) and `by` (frames to move earlier, > 0).
 * Moves the video's old-numbered labels (user instances, user annotations,
 * negative marks, suggestions); predictions and user instances linked to a
 * prediction on their frame stay. Records the video as "shifted" so it isn't
 * offered again. Self-contained undo: a whole-project snapshot taken before
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
    const label = shiftUndoLabel(video, by);
    snapshot.label = label;
    ctx.pushUndoSnapshot(snapshot);
    setVideoRecord(labels, video, "shifted");
    trackShiftRecord(ctx, label, labels, video);

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
