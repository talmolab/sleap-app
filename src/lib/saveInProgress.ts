/**
 * Whether a project save is running. While it is, no second save starts and
 * no edit, undo or redo runs (CommandContext refuses them): the writers read
 * the labels across many awaits, and what the save records about the file for
 * the fast in-place save must describe what it wrote. Every route that
 * changes or replaces the project checks it: commands, undo and redo
 * (CommandContext), direct edits and video changes (`refuseEditIfViewOnly`),
 * opening or importing another project (`confirmDiscardUnsavedWork`) and
 * Replace Video; closing the window waits for the save too.
 */
import { toast } from "@/lib/notify";

let running = 0;

export function isSaveInProgress(): boolean {
  return running > 0;
}

/** Run `work` as the save in progress. */
export async function whileSaving<T>(work: () => Promise<T>): Promise<T> {
  running++;
  try {
    return await work();
  } finally {
    running--;
  }
}

/**
 * True (with a short note, unless `quiet`) when a save is running, so the
 * caller does nothing: a change now would change what is being written. The
 * change is not applied later.
 */
export function refuseWhileSaving(opts?: { quiet?: boolean }): boolean {
  if (!isSaveInProgress()) return false;
  if (!opts?.quiet) {
    toast.info("Saving…", {
      id: "save-in-progress",
      description: "That change wasn't applied. Try again when the save finishes.",
      duration: 2500,
    });
  }
  return true;
}
