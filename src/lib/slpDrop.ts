/**
 * Drag-drop of an `.slp` onto a window (desktop). On an empty window it loads in
 * place (unchanged Welcome behavior); on a window that already holds a project it
 * NEVER clobbers it — per {@link planSlpDrop} it either tells the user the file is
 * already open (here or in another window) or confirms opening it in a separate
 * SLEAP window. The pure routing decision lives in windowRouting; this module is
 * the thin imperative glue (dialogs + toasts + window ops).
 */

import { useAppStore } from "@/stores/appStore";
import { choiceDialog } from "@/stores/choiceStore";
import { toast } from "@/lib/notify";
import { ellipsizeMiddle } from "@/lib/ellipsize";
import {
  focusWindow,
  openOrFocusPath,
  planSlpDrop,
  resolveOpen,
} from "@/lib/windowRouting";

/** Last path segment of a filesystem path (handles both `/` and `\`). */
function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * Route an `.slp` dropped onto this window (desktop only). See module docs.
 * Names shown in dialogs/toasts are middle-truncated so a long filename can't
 * overflow the fixed-width modal.
 */
export async function routeSlpDrop(path: string): Promise<void> {
  const projectLoaded = useAppStore.getState().projectLoaded;

  // Empty window (Welcome): load in place. openOrFocusPath still dedups a file
  // that happens to be open elsewhere.
  if (!projectLoaded) {
    await openOrFocusPath(path);
    return;
  }

  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const myLabel = getCurrentWindow().label;
  const plan = planSlpDrop(
    await resolveOpen(path, myLabel),
    myLabel,
    projectLoaded
  );
  const name = ellipsizeMiddle(basename(path));

  switch (plan.kind) {
    case "openHere":
      await openOrFocusPath(path);
      return;

    case "alreadyHere":
      toast(`"${name}" is already open in this window.`);
      return;

    case "focusOther":
      await focusWindow(plan.label);
      toast(`"${name}" brought to front.`);
      return;

    case "confirmNewWindow": {
      // A different .slp dropped onto a loaded project: never clobber it — offer
      // to merge it into the current project (via the merge pipeline) or open it
      // in a separate window.
      const choice = await choiceDialog({
        title: "Add this project?",
        message: `"${name}" is a different SLEAP project.\nMerge it into your current project, or open it in a separate window.`,
        options: [
          { key: "merge", label: "Merge into project", primary: true },
          { key: "newWindow", label: "Open in new window" },
        ],
      });
      if (choice === "merge") {
        const st = useAppStore.getState();
        st.setMergeProjectSeedPath(path);
        st.setMergeProjectDialogOpen(true);
      } else if (choice === "newWindow") {
        await openOrFocusPath(path);
      }
      return;
    }
  }
}
