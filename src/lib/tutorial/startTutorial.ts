/**
 * Entry point for the "Start Tutorial" menu items.
 *
 * The tutorial creates its own project from the sample video, so it only runs
 * from a fresh app. With a project already open, it offers a new window
 * (`openNewInstance`) instead of adding sample data to the user's project; that
 * window carries `?tutorial=1`, which App.tsx reads on mount to start the
 * tutorial there.
 */

import { useAppStore } from "@/stores/appStore";
import { confirmDialog } from "@/stores/confirmStore";
import { openNewInstance } from "@/lib/newInstance";

/** Query param that makes a freshly opened window start the tutorial. */
export const TUTORIAL_PARAM = "tutorial";

export function readTutorialParam(search: string): boolean {
  return new URLSearchParams(search).get(TUTORIAL_PARAM) === "1";
}

export async function requestStartTutorial(): Promise<void> {
  const store = useAppStore.getState();
  if (!store.projectLoaded) {
    store.startTutorial();
    return;
  }
  const ok = await confirmDialog({
    title: "Start the tutorial in a new window?",
    message:
      "The tutorial builds its own project from a sample video, so it runs in a new window and leaves the project you have open untouched.",
    confirmLabel: "Open new window",
  });
  if (ok) await openNewInstance({ tutorial: true });
}
