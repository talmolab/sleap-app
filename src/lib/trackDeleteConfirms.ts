/**
 * Confirm prompts for track deletions that more than one entry point offers
 * (menu, keyboard shortcut, command palette), so each asks the same question.
 */

import type { Instance, Labels, Video } from "@talmolab/sleap-io.js";
import { confirmDialog } from "@/stores/confirmStore";
import { instancesOnTrackInVideo } from "@/commands/trackCommands";

/**
 * Asks before Delete Instance and Track, saying what it will remove: the
 * selected instance and every instance on its track in the current video
 * (legacy SLEAP's scope). The track itself stays in the project.
 */
export function confirmDeleteInstanceAndTrack(state: {
  labels: Labels | null;
  video: Video | null;
  instance: Instance | null;
}): Promise<boolean> {
  const { labels, video, instance } = state;
  const track = instance?.track;
  let message = "Delete this instance? It isn't on a track, so nothing else is deleted.";
  if (labels && video && track) {
    const n = instancesOnTrackInVideo(labels.labeledFrames, video, track);
    message =
      n <= 1
        ? `Delete this instance, the only one on track "${track.name}" in this video?`
        : `Delete all ${n} instances on track "${track.name}" in this video, including this one?`;
    message += " The track itself is kept.";
  }
  return confirmDialog({
    title: "Delete Instance and Track",
    message,
    confirmLabel: "Delete",
    destructive: true,
  });
}

export function confirmDeleteUnusedTracks(): Promise<boolean> {
  return confirmDialog({
    message: "Delete all unused tracks?",
    confirmLabel: "Delete",
    destructive: true,
  });
}
