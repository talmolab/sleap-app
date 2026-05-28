import { isTauri } from "./platform";
import { useAppStore } from "../stores/appStore";

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
  if (!store.hasChanges) return true;

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
    const { hasChanges } = useAppStore.getState();
    if (hasChanges) {
      event.preventDefault();
      if (await confirmUnsaved()) {
        await forceQuit();
      }
    }
  });
}
