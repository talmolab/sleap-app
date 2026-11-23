import { isTauri } from "./platform";
import { useAppStore } from "../stores/appStore";
import { hasUnsavedWork } from "./unsavedGuard";
import { isSaveInProgress } from "./saveInProgress";
import { markCleanShutdown } from "./diagnostics/sessionLog";

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

/**
 * While a save runs, ask before closing: closing can cut off a write of the
 * project file (an in-place patch has no temp file). "Wait" keeps the window;
 * a save that hangs can still be closed with "Close anyway". True to close.
 */
async function confirmCloseDuringSave(): Promise<boolean> {
  if (!isSaveInProgress()) return true;
  const { confirmDialog } = await import("@/stores/confirmStore");
  return confirmDialog({
    title: "A save is running",
    message:
      "Closing now can leave the project file half written. Wait for the save to " +
      "finish, or close anyway.",
    confirmLabel: "Close anyway",
    cancelLabel: "Wait",
    destructive: true,
  });
}

async function forceQuit(): Promise<void> {
  // Mark the diagnostics session clean BEFORE exiting so the next launch doesn't
  // mistake this intentional quit for a crash. Awaited so it lands before exit.
  await markCleanShutdown();
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

// ── Quit across windows ─────────────────────────────────────────────────────
// Each desktop window is its own JS heap with its own project, but Quit exits
// the whole process — so the quitting window must ask every OTHER window about
// ITS unsaved work too. Request/reply over targeted Tauri events:
//   requester → window  QUIT_ASK    { id, to, from }
//   window → requester  QUIT_REPLY  { id, phase: "ack", dirty }       (at once)
//                       QUIT_REPLY  { id, phase: "decision", proceed } (if dirty,
//                                    after that window's own Quit prompt)
const QUIT_ASK = "quit-ask";
const QUIT_REPLY = "quit-reply";
/** How long to wait for a window to acknowledge. A window that never answers
 *  (no listener — still booting) has no project of its own to lose. The
 *  user's decision itself is never timed out. */
const QUIT_ACK_TIMEOUT_MS = 5000;

interface QuitAsk { id: string; to: string; from: string }
type QuitReply =
  | { id: string; phase: "ack"; dirty: boolean }
  | { id: string; phase: "decision"; proceed: boolean };

/** How the quitting window reaches its peers (a seam for tests). */
export interface QuitPeers {
  /** Labels of every window except this one. */
  otherWindows(): Promise<string[]>;
  /** Ask `label` about unsaved work: null if it didn't answer in time; else
   *  whether it's dirty and, when it is, its user's Quit decision. */
  ask(label: string): Promise<{ dirty: boolean; decision: Promise<boolean> } | null>;
}

/**
 * Walk the other windows one at a time; each one with unsaved work shows its
 * own Quit prompt. Resolves false as soon as any user cancels, true once every
 * window agreed (or had nothing to lose).
 */
export async function confirmOtherWindows(peers: QuitPeers): Promise<boolean> {
  for (const label of await peers.otherWindows()) {
    const reply = await peers.ask(label);
    if (!reply?.dirty) continue;
    if (!(await reply.decision)) return false;
  }
  return true;
}

async function tauriQuitPeers(): Promise<QuitPeers> {
  const { getCurrentWebviewWindow, getAllWebviewWindows } = await import(
    "@tauri-apps/api/webviewWindow"
  );
  const { emitTo } = await import("@tauri-apps/api/event");
  const me = getCurrentWebviewWindow();
  return {
    async otherWindows() {
      try {
        return (await getAllWebviewWindows()).map((w) => w.label).filter((l) => l !== me.label);
      } catch (err) {
        console.warn("[quit] window enumeration failed; checking this window only:", err);
        return [];
      }
    },
    async ask(label) {
      const id = crypto.randomUUID();
      let onAck!: (dirty: boolean) => void;
      let onDecision!: (proceed: boolean) => void;
      const ack = new Promise<boolean>((r) => (onAck = r));
      const decision = new Promise<boolean>((r) => (onDecision = r));
      const unlisten = await me.listen<QuitReply>(QUIT_REPLY, ({ payload }) => {
        if (payload?.id !== id) return;
        if (payload.phase === "ack") onAck(payload.dirty);
        else onDecision(payload.proceed);
      });
      await emitTo(label, QUIT_ASK, { id, to: label, from: me.label } satisfies QuitAsk);
      const dirty = await Promise.race([
        ack,
        new Promise<null>((r) => setTimeout(() => r(null), QUIT_ACK_TIMEOUT_MS)),
      ]);
      if (!dirty) {
        unlisten();
        return dirty === null ? null : { dirty: false, decision: Promise.resolve(true) };
      }
      return { dirty: true, decision: decision.finally(unlisten) };
    },
  };
}

/**
 * Answer other windows' Quit checks: report whether this window has unsaved
 * work and, if so, bring it forward and ask its user. Call once at startup.
 */
async function setupQuitPeerListener(): Promise<void> {
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const { emitTo } = await import("@tauri-apps/api/event");
  const me = getCurrentWebviewWindow();
  await me.listen<QuitAsk>(QUIT_ASK, async ({ payload }) => {
    if (!payload || payload.to !== me.label) return;
    const reply = (r: QuitReply) => emitTo(payload.from, QUIT_REPLY, r);
    const dirty = hasUnsavedWork(useAppStore.getState()) || isSaveInProgress();
    await reply({ id: payload.id, phase: "ack", dirty });
    if (!dirty) return;
    const { focusWindow } = await import("./windowRouting");
    await focusWindow(me.label);
    const proceed = (await confirmCloseDuringSave()) && (await confirmUnsaved());
    await reply({ id: payload.id, phase: "decision", proceed });
  });
}

/** Quit the WHOLE app, prompting in every window that has unsaved changes. */
export async function quitApp(): Promise<void> {
  if (!(await confirmCloseDuringSave())) return;
  if (!(await confirmUnsaved())) return;
  if (isTauri && !(await confirmOtherWindows(await tauriQuitPeers()))) return;
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

  await setupQuitPeerListener().catch((err) =>
    console.warn("[quit] couldn't listen for other windows' quit checks:", err),
  );

  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const appWindow = getCurrentWindow();

  await appWindow.onCloseRequested(async (event) => {
    // A save is writing the project's file (an in-place patch can't be cut
    // off safely): keep the window open until it finishes.
    if (isSaveInProgress()) {
      event.preventDefault();
      if ((await confirmCloseDuringSave()) && (await confirmUnsaved())) {
        await closeThisWindow();
      }
      return;
    }
    // No unsaved work: let the default close proceed (Tauri closes just this
    // window, or exits if it's the last one).
    if (!hasUnsavedWork(useAppStore.getState())) return;
    event.preventDefault();
    if (await confirmUnsaved()) {
      await closeThisWindow();
    }
  });
}
