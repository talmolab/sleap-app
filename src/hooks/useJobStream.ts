import { useEffect, useRef, useState } from "react";
import { useConnectStore } from "@/stores/connectStore";
import type { WorkerEvent } from "@/lib/protocolV1/client";
import { initialJobStream, reduceJobEvents, type JobStreamState } from "@/lib/jobStream";

export interface UseJobStreamOptions {
  /** How often buffered events are folded into state, in ms. Injectable for tests; defaults to 250. */
  flushIntervalMs?: number;
  /** Overridable for tests (no fake timers in this repo); defaults to the real `setInterval`. */
  setIntervalImpl?: (cb: () => void, ms: number) => unknown;
  /** Overridable for tests; defaults to the real `clearInterval`. */
  clearIntervalImpl?: (handle: unknown) => void;
}

const DEFAULT_FLUSH_INTERVAL_MS = 250;
const defaultSetInterval = (cb: () => void, ms: number): unknown => setInterval(cb, ms);
const defaultClearInterval = (handle: unknown): void =>
  clearInterval(handle as ReturnType<typeof setInterval>);

/**
 * Subscribes to one worker job's event stream (replay from `since_seq: 0`,
 * then live) and folds it through `jobStream.ts`'s `reduceJobEvents` into
 * `JobStreamState` — the Connect window's per-job viewer (`JobViewerDialog`,
 * PR4b §4b.6).
 *
 * Buffered rather than applied per-event: the worker's full replay backlog
 * (everything since `since_seq: 0`) arrives as a burst, and re-rendering once
 * per event would be wasteful. Flushed on an interval, plus once right after
 * `jobsSubscribe` resolves — by then the backlog has already been delivered
 * to the buffer synchronously (see `WorkerClient.jobsSubscribe`'s doc
 * comment: the listener is registered before the request is sent, and
 * frames on one WebSocket arrive in order), so the viewer doesn't sit empty
 * for up to a full interval on open.
 *
 * A failure to connect or subscribe lands in `status: "unknown"` with the
 * error in `detail`, same shape a caller already handles for a job stuck
 * mid-replay.
 */
export function useJobStream(
  workerId: string,
  jobId: string,
  label: string,
  options: UseJobStreamOptions = {},
): JobStreamState {
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  // Latest overrides in a ref, not the effect's deps — an options object a
  // caller doesn't memoize would otherwise re-subscribe on every render.
  const implsRef = useRef({
    setInterval: options.setIntervalImpl ?? defaultSetInterval,
    clearInterval: options.clearIntervalImpl ?? defaultClearInterval,
  });
  implsRef.current = {
    setInterval: options.setIntervalImpl ?? defaultSetInterval,
    clearInterval: options.clearIntervalImpl ?? defaultClearInterval,
  };

  const [state, setState] = useState<JobStreamState>(() => initialJobStream(label));

  useEffect(() => {
    let cancelled = false;
    let buffer: WorkerEvent[] = [];
    let unsubscribe: (() => void) | null = null;
    let intervalHandle: unknown = null;

    setState(initialJobStream(label));

    const flush = () => {
      if (buffer.length === 0) return;
      const events = buffer;
      buffer = [];
      setState((prev) => reduceJobEvents(prev, events));
    };

    void (async () => {
      try {
        const client = await useConnectStore.getState().clientFor(workerId);
        if (cancelled) return;
        unsubscribe = await client.jobsSubscribe(jobId, 0, (event) => {
          buffer.push(event);
        });
        if (cancelled) {
          unsubscribe();
          return;
        }
        flush(); // the initial backlog is already in the buffer by now
        intervalHandle = implsRef.current.setInterval(flush, flushIntervalMs);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState((prev) => ({ ...prev, status: "unknown", detail: message }));
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
      if (intervalHandle !== null) implsRef.current.clearInterval(intervalHandle);
    };
  }, [workerId, jobId, label, flushIntervalMs]);

  return state;
}
