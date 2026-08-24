import { useEffect, useRef, useState } from "react";

export interface LogEntry {
  timestamp: number;
  level: "log" | "warn" | "error" | "info" | "debug";
  args: string;
}

const MAX_ENTRIES = 500;

/** Global log buffer that persists across re-renders. */
const logBuffer: LogEntry[] = [];
const listeners = new Set<() => void>();

/**
 * Optional sinks notified of every intercepted log entry (in addition to the
 * in-memory ring buffer). The diagnostics session-log uses this to tee the
 * console trace to a durable on-disk file — see {@link import("@/lib/diagnostics/sessionLog")}.
 */
export type LogSink = (entry: LogEntry) => void;
const sinks = new Set<LogSink>();

/** Register a sink for intercepted log entries. Returns an unsubscribe fn. */
export function registerLogSink(sink: LogSink): () => void {
  sinks.add(sink);
  return () => {
    sinks.delete(sink);
  };
}

/** A snapshot of the in-memory console log buffer (oldest → newest). */
export function getLogEntries(): readonly LogEntry[] {
  return logBuffer.slice();
}

function pushLog(level: LogEntry["level"], args: unknown[]) {
  const entry: LogEntry = {
    timestamp: Date.now(),
    level,
    args: args
      .map((a) => {
        if (typeof a === "string") return a;
        try {
          return JSON.stringify(a, null, 2);
        } catch {
          return String(a);
        }
      })
      .join(" "),
  };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_ENTRIES) logBuffer.splice(0, logBuffer.length - MAX_ENTRIES);
  listeners.forEach((fn) => fn());
  // Tee to durable sinks (e.g. the diagnostics disk log). Never let a sink
  // failure break logging or re-enter the interceptor.
  sinks.forEach((sink) => {
    try {
      sink(entry);
    } catch {
      /* swallow — a broken sink must not break the app's console */
    }
  });
}

/** Install console interceptors once. */
let installed = false;
function installInterceptors() {
  if (installed) return;
  installed = true;
  const originals = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug,
  };
  for (const level of ["log", "warn", "error", "info", "debug"] as const) {
    console[level] = (...args: unknown[]) => {
      originals[level](...args);
      pushLog(level, args);
    };
  }
}

installInterceptors();

/** Debug flags — toggled from the debug panel, read from anywhere. */
export const debugFlags = {
  logSeeking: false,
};

const LEVEL_COLORS: Record<LogEntry["level"], string> = {
  log: "text-foreground",
  info: "text-blue-400",
  warn: "text-yellow-400",
  error: "text-red-400",
  debug: "text-muted-foreground",
};

export function DebugPanel() {
  const [logSeeking, setLogSeeking] = useState(debugFlags.logSeeking);
  const [, setTick] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const autoScroll = useRef(true);

  useEffect(() => {
    const listener = () => setTick((t) => t + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);

  useEffect(() => {
    if (autoScroll.current) {
      bottomRef.current?.scrollIntoView({ behavior: "instant" });
    }
  });

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    autoScroll.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const clear = () => {
    logBuffer.length = 0;
    setTick((t) => t + 1);
  };

  return (
    <div className="flex flex-col h-full -m-2">
      <div className="flex items-center gap-2 px-2 py-1 border-b border-border shrink-0">
        <button
          onClick={clear}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Clear
        </button>
        <span className="text-xs text-muted-foreground ml-auto">
          {logBuffer.length} entries
        </span>
      </div>
      <div className="flex items-center gap-2 px-2 py-1 border-b border-border shrink-0">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
          <input
            type="checkbox"
            checked={logSeeking}
            onChange={(e) => {
              debugFlags.logSeeking = e.target.checked;
              setLogSeeking(e.target.checked);
            }}
            className="accent-primary"
          />
          Log seeking
        </label>
      </div>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        className="flex-1 overflow-auto font-mono text-[11px] leading-[18px] p-1 min-h-0"
      >
        {logBuffer.map((entry, i) => {
          const time = new Date(entry.timestamp);
          const ts = time.toLocaleTimeString([], { hour12: false, fractionalSecondDigits: 3 } as Intl.DateTimeFormatOptions);
          return (
            <div key={i} className={`flex gap-1.5 ${LEVEL_COLORS[entry.level]} hover:bg-accent/30`}>
              <span className="text-muted-foreground shrink-0 select-none">{ts}</span>
              <pre className="whitespace-pre-wrap break-all flex-1">{entry.args}</pre>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
