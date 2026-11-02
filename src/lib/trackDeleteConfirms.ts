/**
 * Confirm prompts for track deletions that more than one entry point offers
 * (menu, keyboard shortcut, command palette), so each asks the same question.
 */

import { confirmDialog } from "@/stores/confirmStore";

export function confirmDeleteInstanceAndTrack(): Promise<boolean> {
  return confirmDialog({
    message: "Delete this instance and its track?",
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
