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
  // Also prompt when a browser large-pkg labels draft has edits saved locally
  // but not yet exported to disk. (On desktop pendingExport is always false, so
  // this is unchanged there.) Quit does NOT delete the draft — it should survive
  // for a future resume-on-open.
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

/**
 * Close ONLY this window — unless it's the last one, in which case quit the app.
 * Uses `destroy()` (not `close()`) so it doesn't re-fire onCloseRequested and
 * re-prompt after the user already confirmed. With multiple windows open,
 * closing one must not tear down the whole process (each window is its own
 * isolated project).
 */
async function closeThisWindow(): Promise<void> {
  if (!isTauri) {
    window.close();
    return;
  }
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  try {
    const { getAllWebviewWindows } = await import("@tauri-apps/api/webviewWindow");
    const all = await getAllWebviewWindows();
    if (all.length <= 1) {
      await forceQuit(); // last window → quit the process
      return;
    }
  } catch (err) {
    // Enumeration unavailable → fall through to destroying just this window; if
    // it was the last one, Tauri exits the app by default anyway.
    console.warn("[quit] window enumeration failed; closing this window:", err);
  }
  await getCurrentWindow().destroy();
}

/** Quit the WHOLE app, prompting if there are unsaved changes. */
export async function quitApp(): Promise<void> {
  if (!(await confirmUnsaved())) return;
  await forceQuit();
}

/**
 * Listen for the native window close event (title bar X) and intercept it to
 * prompt for unsaved changes. Call once at app startup. Closing a window only
 * closes THAT window (the app keeps running while other windows are open); the
 * last window's close quits the app. The Rust `Destroyed` handler drops the
 * window's entry from the open-file registry either way.
 */
export async function setupCloseHandler(): Promise<void> {
  if (!isTauri) return;

  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const appWindow = getCurrentWindow();

  await appWindow.onCloseRequested(async (event) => {
    // No unsaved work: let the default close proceed (Tauri closes just this
    // window, or exits if it's the last one).
    if (!hasUnsavedWork(useAppStore.getState())) return;
    event.preventDefault();
    if (await confirmUnsaved()) {
      await closeThisWindow();
    }
  });
}
