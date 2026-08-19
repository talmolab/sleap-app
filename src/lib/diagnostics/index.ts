/**
 * Diagnostics — traceable local telemetry for desktop testers.
 *
 * `initDiagnostics()` (called once at boot) wires up:
 *  - session/install identity + a durable on-disk session log (sessionLog.ts),
 *  - global `window.onerror` / `unhandledrejection` capture — otherwise uncaught
 *    crashes never reach the console interceptor and are lost.
 *
 * The user-facing "Collect Diagnostics" action serializes everything the app
 * already keeps in memory (plus the durable logs) into one JSON file to send us.
 */

import { initSessionLog } from "./sessionLog";

/** Resolves once diagnostics init has run, so boot UI (the crash-recovery
 *  prompt) can read {@link getPriorCrashInfo} after the sentinel check completes
 *  rather than racing it. */
let resolveReady!: () => void;
export const diagnosticsReady = new Promise<void>((r) => {
  resolveReady = r;
});

let errorHandlersInstalled = false;

function installGlobalErrorHandlers() {
  if (errorHandlersInstalled) return;
  errorHandlersInstalled = true;
  // Funnel into console.error → the console interceptor → in-memory buffer +
  // the durable disk sink. These handlers are the only capture path for
  // uncaught errors and unhandled promise rejections.
  window.addEventListener("error", (e: ErrorEvent) => {
    console.error(
      "[uncaught]",
      e.message,
      e.error?.stack ?? "",
      `${e.filename}:${e.lineno}:${e.colno}`,
    );
  });
  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    const r = e.reason;
    console.error("[unhandledrejection]", r?.message ?? String(r), r?.stack ?? "");
  });
}

/** Best-effort diagnostics init. Never throws; safe to call once at boot. */
export async function initDiagnostics(): Promise<void> {
  try {
    installGlobalErrorHandlers();
  } catch {
    /* ignore */
  }
  try {
    await initSessionLog();
  } catch {
    /* ignore */
  }
  resolveReady();
}

export { collectDiagnostics } from "./collectDiagnostics";
export { saveDiagnosticsBundle } from "./saveDiagnostics";
export { getPriorCrashInfo } from "./sessionLog";
