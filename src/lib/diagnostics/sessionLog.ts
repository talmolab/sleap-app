/**
 * Diagnostics session log — durable, crash-surviving capture of the app's
 * console trace.
 *
 * The app already intercepts every `console.*` into an in-memory ring buffer
 * (see {@link import("@/components/panels/DebugPanel")}), but that buffer is
 * lost on close/crash. This module tees the SAME entries to an append-only file
 * under `<appLocalData>/sleap-logs/session-<bootTs>-<shortId>.log` so a tester
 * who hits a bug — even a crash — can still hand us the trace. It also mints the
 * session/install identity that makes a diagnostics bundle traceable.
 *
 * Desktop (Tauri) only for the disk sink; in the browser we still mint identity
 * so {@link collectDiagnostics} has stable ids. Everything here is best-effort:
 * a failure must never break app boot or logging.
 */

import { isTauri } from "@/lib/platform";
import { registerLogSink, type LogEntry } from "@/components/panels/DebugPanel";

const INSTALL_ID_KEY = "sleap.diagnostics.installId";
const LOGS_DIR_NAME = "sleap-logs";
/** Retain the current session's log + this many previous ones (crash-durable). */
const KEEP_PREVIOUS_SESSIONS = 1;
const FLUSH_INTERVAL_MS = 2000;
/** Sentinel written at boot and removed on clean shutdown. If it's still here at
 *  the next boot, the prior session ended improperly (crash/freeze/force-quit). */
const SENTINEL_FILE = "session.running";

/** A prior session that never marked clean — surfaced as a recovery prompt. */
export interface PriorCrashInfo {
  sessionId: string;
  bootTimestamp: number;
  logName: string;
}

let sessionId = "";
let bootTimestamp = 0;
let sessionLogPath: string | null = null;
let pending: string[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let priorCrashInfo: PriorCrashInfo | null = null;

function safeUuid(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `s-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
}

/** Stable per-install id (persisted in localStorage), for correlating a
 *  tester's bundles across sessions. */
export function getInstallId(): string {
  try {
    let id = localStorage.getItem(INSTALL_ID_KEY);
    if (!id) {
      id = safeUuid();
      localStorage.setItem(INSTALL_ID_KEY, id);
    }
    return id;
  } catch {
    return "unknown";
  }
}

export function getSessionId(): string {
  return sessionId;
}

export function getBootTimestamp(): number {
  return bootTimestamp;
}

/**
 * Pure rotation policy: given the session-log filenames present in the logs
 * directory and how many previous sessions to keep, return the filenames to
 * delete (oldest beyond the keep window). Exported for unit testing.
 */
export function sessionLogsToPrune(files: string[], keepPrevious: number): string[] {
  const parsed = files
    .map((f) => ({ f, ts: Number(/^session-(\d+)-/.exec(f)?.[1] ?? NaN) }))
    .filter((p) => Number.isFinite(p.ts))
    .sort((a, b) => b.ts - a.ts); // newest first
  return parsed.slice(Math.max(0, keepPrevious)).map((p) => p.f);
}

function formatEntry(e: LogEntry): string {
  return `[${new Date(e.timestamp).toISOString()}] [${e.level}] ${e.args}\n`;
}

function scheduleFlush() {
  if (flushTimer != null) return;
  flushTimer = setInterval(() => void flush(), FLUSH_INTERVAL_MS);
}

async function flush(): Promise<void> {
  if (!sessionLogPath || pending.length === 0) return;
  const chunk = pending.join("");
  pending = [];
  try {
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    await writeTextFile(sessionLogPath, chunk, { append: true });
  } catch {
    // best-effort; drop the chunk rather than growing memory unbounded
  }
}

/**
 * Initialize identity and (on desktop) the durable disk sink. Idempotent per
 * process. Rotates old session logs, keeping the current + last
 * {@link KEEP_PREVIOUS_SESSIONS}.
 */
export async function initSessionLog(): Promise<void> {
  if (bootTimestamp !== 0) return; // already initialized
  bootTimestamp = Date.now();
  sessionId = safeUuid();
  getInstallId(); // ensure minted

  if (!isTauri) return; // browser: identity only, no disk sink

  try {
    const { appLocalDataDir, join } = await import("@tauri-apps/api/path");
    const { mkdir, readDir, remove, writeTextFile } = await import(
      "@tauri-apps/plugin-fs"
    );
    const dir = await join(await appLocalDataDir(), LOGS_DIR_NAME);
    await mkdir(dir, { recursive: true });

    // Rotate: prune old session logs before opening this session's file.
    try {
      const existing = (await readDir(dir))
        .filter((e) => e.isFile)
        .map((e) => e.name);
      for (const f of sessionLogsToPrune(existing, KEEP_PREVIOUS_SESSIONS)) {
        try {
          await remove(await join(dir, f));
        } catch {
          /* ignore individual prune failures */
        }
      }
    } catch {
      /* readDir may fail on first run; non-fatal */
    }

    // Improper-shutdown detection: a leftover "running" sentinel from a PRIOR
    // session means it never marked clean (crash / freeze / force-quit). Capture
    // it for the recovery prompt before we claim the sentinel for this run.
    const sentinelPath = await join(dir, SENTINEL_FILE);
    try {
      const { readTextFile, exists } = await import("@tauri-apps/plugin-fs");
      if (await exists(sentinelPath)) {
        const prev = JSON.parse(await readTextFile(sentinelPath));
        if (prev?.sessionId && prev.sessionId !== sessionId) {
          priorCrashInfo = {
            sessionId: String(prev.sessionId),
            bootTimestamp: Number(prev.bootTimestamp) || 0,
            logName: String(prev.logName || ""),
          };
        }
      }
    } catch {
      /* no / corrupt sentinel — nothing to recover */
    }

    const shortId = sessionId.slice(0, 8);
    const logName = `session-${bootTimestamp}-${shortId}.log`;
    sessionLogPath = await join(dir, logName);
    await writeTextFile(
      sessionLogPath,
      `# SLEAP Label diagnostics session log\n# session=${sessionId} install=${getInstallId()} boot=${new Date(bootTimestamp).toISOString()}\n`,
      { append: false },
    );

    // Claim the sentinel for THIS session (removed on clean shutdown).
    try {
      await writeTextFile(
        sentinelPath,
        JSON.stringify({ sessionId, bootTimestamp, logName }),
        { append: false },
      );
    } catch {
      /* non-fatal */
    }

    registerLogSink((entry) => {
      pending.push(formatEntry(entry));
      scheduleFlush();
    });

    window.addEventListener("beforeunload", () => {
      void flush();
      void markCleanShutdown();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") void flush();
    });
  } catch {
    // diagnostics is best-effort; never break boot
    sessionLogPath = null;
  }
}

/** Info about a PRIOR session that ended without marking clean (crash / freeze /
 *  force-quit), or null. Set once during {@link initSessionLog}. */
export function getPriorCrashInfo(): PriorCrashInfo | null {
  return priorCrashInfo;
}

/** Clear this session's crash flag by removing the running sentinel. Called from
 *  graceful-exit paths (quit.ts `forceQuit` + `beforeunload`) and the Rust
 *  `Destroyed` window handler. Best-effort. */
export async function markCleanShutdown(): Promise<void> {
  if (!isTauri) return;
  try {
    const { appLocalDataDir, join } = await import("@tauri-apps/api/path");
    const { remove, exists } = await import("@tauri-apps/plugin-fs");
    const p = await join(await appLocalDataDir(), LOGS_DIR_NAME, SENTINEL_FILE);
    if (await exists(p)) await remove(p);
  } catch {
    /* best-effort */
  }
}

/**
 * Read the retained session logs (current + previous), newest first. Flushes
 * pending entries first so the current session's tail is included. Returns an
 * empty array in the browser or on any error.
 */
export async function readSessionLogs(): Promise<
  { name: string; content: string }[]
> {
  if (!isTauri) return [];
  await flush();
  try {
    const { appLocalDataDir, join } = await import("@tauri-apps/api/path");
    const { readDir, readTextFile } = await import("@tauri-apps/plugin-fs");
    const dir = await join(await appLocalDataDir(), LOGS_DIR_NAME);
    const files = (await readDir(dir))
      .filter((e) => e.isFile && /^session-\d+-.*\.log$/.test(e.name))
      .map((e) => e.name)
      .sort((a, b) => {
        const ta = Number(/^session-(\d+)-/.exec(a)?.[1] ?? 0);
        const tb = Number(/^session-(\d+)-/.exec(b)?.[1] ?? 0);
        return tb - ta; // newest first
      });
    const out: { name: string; content: string }[] = [];
    for (const name of files) {
      try {
        out.push({ name, content: await readTextFile(await join(dir, name)) });
      } catch {
        /* skip unreadable */
      }
    }
    return out;
  } catch {
    return [];
  }
}
