/**
 * Whether a project save is running. While it is, no second save starts and
 * no edit, undo or redo runs (CommandContext refuses them): the writers read
 * the labels across many awaits, and what the save records about the file for
 * the fast in-place save must describe what it wrote. The progress overlay
 * blocks the mouse; this covers the keyboard and the menus.
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
 * True (with a short note) when a save is running, so the caller does
 * nothing: an edit, undo or redo now would change what is being written.
 */
export function refuseWhileSaving(): boolean {
  if (!isSaveInProgress()) return false;
  toast.info("Saving…", {
    id: "save-in-progress",
    description: "Edits, undo and redo wait until the save finishes.",
    duration: 1600,
  });
  return true;
}
