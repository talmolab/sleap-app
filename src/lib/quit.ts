import { isTauri } from "./platform";
import { useAppStore } from "../stores/appStore";
import { hasUnsavedWork } from "./unsavedGuard";

let pendingQuitResolve: ((confirmed: boolean) => void) | null = null;

/** Resolve the pending quit confirmation. Called by the UI. */
export function resolveQuitConfirm(confirmed: boolean) {
  if (pendingQuitResolve) {
    pendingQuitResolve(confirmed);
    pendingQuitResolve = null;
  }
}

async function confirmUnsaved(): Promise<boolean> {
  const store = useAppStore.getState();
  // Also prompt when a browser large-pkg working copy has edits saved to OPFS
  // but not yet exported to disk. (On desktop workingCopyPendingExport is always
  // false, so this is unchanged there.) Quit does NOT delete the working copy —
  // it should survive for a future resume-on-open.
  if (!hasUnsavedWork(store)) return true;

  store.set("quitConfirmOpen", true);
  return new Promise<boolean>((resolve) => {
    pendingQuitResolve = resolve;
  });
}

async function forceQuit(): Promise<void> {
  if (isTauri) {
    const { exit } = await import("@tauri-apps/plugin-process");
    await exit(0);
  } else {
    window.close();
  }
}

/** Quit the app, prompting if there are unsaved changes. */
export async function quitApp(): Promise<void> {
  if (!(await confirmUnsaved())) return;
  await forceQuit();
}

/**
 * Listen for the native window close event (title bar X) and intercept
 * it to prompt for unsaved changes. Call once at app startup.
 */
export async function setupCloseHandler(): Promise<void> {
  if (!isTauri) return;

  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const appWindow = getCurrentWindow();

  await appWindow.onCloseRequested(async (event) => {
    if (hasUnsavedWork(useAppStore.getState())) {
      event.preventDefault();
      if (await confirmUnsaved()) {
        await forceQuit();
      }
    }
  });
}
