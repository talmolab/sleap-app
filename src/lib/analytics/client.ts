/**
 * The analytics client: collects events, seals them into batches, and delivers
 * each batch at least once.
 *
 * Every outside effect is injected (`ClientDeps`), so this file has no globals
 * and its behavior is fully unit-tested: what is sent, what is never sent, and
 * what happens when the network or the service says no.
 *
 * The life of an event:
 *
 *   track() / count()      → held in memory
 *   seal()                 → written to storage as one batch (survives a crash)
 *   flush()                → POSTed; removed from storage once the service has it
 *
 * Three rules shape everything below.
 *
 *  1. CONSENT IS CHECKED AT EVERY STEP, not once at startup. Turning sharing
 *     off discards what is held and what is stored; nothing "already queued"
 *     goes out afterwards.
 *
 *  2. NOTHING IS STORED OR SENT WHILE ON HOLD. On a first launch the app shows
 *     a notice explaining what is shared and how to turn it off. Until that
 *     notice has been seen (`canSend()` is false), events stay in memory only.
 *
 *  3. FAILURE NEVER REACHES THE USER and never grows without bound. A batch
 *     that cannot be delivered is retried later, dropped when the service
 *     says it is malformed, and dropped when it is too old or too many are
 *     waiting. Drops are counted and reported in the next batch's context, so
 *     loss is visible in the data rather than silent.
 */

import { PROMPT_EVENTS, type AnalyticsEventName, type AnalyticsEvents } from "./events";
import {
  ANALYTICS_SCHEMA,
  LIMITS,
  PRODUCT,
  isValidEventName,
  isValidKey,
  sanitizeProps,
  utf8ByteLength,
  type LegacyPing,
  type Props,
  type WireBatch,
  type WireEvent,
} from "./protocol";

/** The batched-events endpoint. */
export const EVENTS_PATH = "/v2/events";
/** The 2022 endpoint, used only when the service has no `/v2/events`. */
export const LEGACY_PING_PATH = "/ping";

export interface Transport {
  /**
   * POST a JSON body to a path on the analytics service. Resolves the HTTP
   * status, or 0 when no answer came back (offline, blocked, timed out).
   * Never rejects.
   */
  post(path: string, body: string, opts?: { keepalive?: boolean }): Promise<number>;
  /**
   * Whether this runtime can reach `/ping`. Only the desktop app can: it posts
   * from native code. A browser cannot, because `/ping` answers no CORS
   * preflight — deliberately (see app/main.py in the service).
   */
  readonly canLegacyPing: boolean;
}

/** The subset of `Storage` the client needs. */
export type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export interface ClientDeps {
  transport: Transport;
  /** `localStorage`, or null when unavailable (then batches live in memory). */
  storage: KeyValueStore | null;
  version: string;
  installId: string;
  sessionId: string;
  now: () => number;
  uuid: () => string;
  /** The user's consent AND the build being one that reports at all. */
  isEnabled: () => boolean;
  /** False until the first-run notice has been seen. */
  canSend: () => boolean;
  /** A fresh description of the machine and build, read when a batch is sealed. */
  getContext: () => Record<string, unknown>;
  /** The `/ping` body, built only if the fallback is taken. */
  getLegacyPing: () => LegacyPing;
  /** Ask for a `flush()` in about `delayMs`. The caller owns the timer. */
  requestFlush: (delayMs: number) => void;
  /** Debug sink for `sleap.analytics.debug`. */
  log?: (message: string, detail?: unknown) => void;
}

export type SendResult = "ok" | "retry" | "drop" | "unsupported";

/**
 * What a response status means for the batch that was sent.
 *
 *  - 404/405: the service has no `/v2/events` (it predates it) → "unsupported".
 *  - 408/425/429/5xx and no answer at all: try again later → "retry".
 *  - any other 4xx: the batch itself is unacceptable and always will be →
 *    "drop". Retrying it would re-send the same rejected bytes forever.
 */
export function classifyStatus(status: number): SendResult {
  if (status >= 200 && status < 300) return "ok";
  if (status === 404 || status === 405) return "unsupported";
  if (status === 0 || status === 408 || status === 425 || status === 429 || status >= 500) return "retry";
  return "drop";
}

const BATCH_KEY_PREFIX = "sleap.analytics.batch.";
const DROPPED_KEY = "sleap.analytics.dropped";

/** Batches waiting in storage beyond this are dropped, oldest first. */
export const MAX_STORED_BATCHES = 20;
/** A batch older than this is dropped unsent: its moment has passed. */
export const MAX_BATCH_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Events accepted per session. A runaway loop must not become a flood. */
export const MAX_SESSION_EVENTS = 500;
/** Distinct usage keys per batch; the rest are summed under `other`. */
const MAX_USAGE_KEYS = LIMITS.maxPropsKeys - 8;
/** Distinct error fingerprints reported per session. */
const MAX_ERROR_FINGERPRINTS = 25;

/** How soon after a prompt event to send, so a burst still lands in one batch. */
export const PROMPT_FLUSH_DELAY_MS = 3_000;

interface StoredBatch {
  sealedAt: number;
  batch: Omit<WireBatch, "sent_at">;
}

export class AnalyticsClient {
  private pending: WireEvent[] = [];
  private counters = new Map<string, number>();
  private errorCounts = new Map<string, number>();
  private seq = 0;
  private suppressed = 0;
  private flushing: Promise<void> | null = null;
  /** Set if `flush()` is called while a delivery is already in flight. */
  private reflushNeeded = false;
  /** The service answered 404 to `/v2/events` this session. */
  private v2Unsupported = false;
  private legacyPingSent = false;
  /** Used instead of `deps.storage` when it is missing or throws. */
  private memory = new Map<string, string>();

  constructor(private readonly deps: ClientDeps) {}

  // ── Collecting ────────────────────────────────────────────────────────────

  /** Record one event from the catalog. A no-op when sharing is off. */
  track<K extends AnalyticsEventName>(name: K, props: AnalyticsEvents[K]): void {
    if (!this.accepting() || !isValidEventName(name)) return;
    if (this.seq >= MAX_SESSION_EVENTS) {
      this.suppressed++;
      return;
    }
    this.pending.push({
      name,
      t: this.deps.now(),
      seq: this.seq++,
      props: sanitizeProps(props as Record<string, unknown>),
    });
    if (this.pending.length >= LIMITS.maxEvents - 1) this.deps.requestFlush(0);
    else if (PROMPT_EVENTS.has(name)) this.deps.requestFlush(PROMPT_FLUSH_DELAY_MS);
  }

  /** Add to a usage counter; sent as one `usage` event with the next batch. */
  count(key: string, n = 1): void {
    if (!this.accepting() || !isValidKey(key)) return;
    const slot = this.counters.has(key) || this.counters.size < MAX_USAGE_KEYS ? key : "other";
    this.counters.set(slot, (this.counters.get(slot) ?? 0) + n);
  }

  /**
   * Record an error by fingerprint. The first occurrence is sent; repeats are
   * counted and re-sent only at 10, 100, 1000… so a tight loop that throws on
   * every frame reports its magnitude without sending thousands of events.
   */
  trackError(error: Omit<AnalyticsEvents["error"], "count">): void {
    if (!this.accepting()) return;
    const seen = this.errorCounts.get(error.fp) ?? 0;
    if (seen === 0 && this.errorCounts.size >= MAX_ERROR_FINGERPRINTS) return;
    const count = seen + 1;
    this.errorCounts.set(error.fp, count);
    if (count === 1 || /^10+$/.test(String(count))) this.track("error", { ...error, count });
  }

  /** Whether anything has been collected since the last batch was sealed. */
  hasPending(): boolean {
    return this.pending.length > 0 || this.counters.size > 0;
  }

  private accepting(): boolean {
    return !this.v2Unsupported && this.deps.isEnabled();
  }

  // ── Sealing ───────────────────────────────────────────────────────────────

  /**
   * Move everything collected so far into one stored batch. Returns whether a
   * batch was written. Does nothing while on hold, so that nothing is
   * persisted before the first-run notice has been seen.
   */
  seal(): boolean {
    if (!this.deps.isEnabled()) {
      this.discardAll();
      return false;
    }
    if (!this.deps.canSend()) return false;
    if (this.pending.length === 0 && this.counters.size === 0) return false;

    let events = this.pending.splice(0, LIMITS.maxEvents - 1);
    if (this.counters.size > 0) {
      events.push({
        name: "usage",
        t: this.deps.now(),
        seq: this.seq++,
        props: sanitizeProps(Object.fromEntries(this.counters)),
      });
      this.counters.clear();
    }

    const envelope = (list: WireEvent[]): StoredBatch["batch"] => ({
      schema: ANALYTICS_SCHEMA,
      batch_id: this.deps.uuid(),
      product: PRODUCT,
      version: this.deps.version,
      install_id: this.deps.installId,
      session_id: this.deps.sessionId,
      context: this.context(),
      events: list,
    });

    // Stay under the UTF-8 byte cap (matching Rust `body.len()` and Python
    // `MAX_BODY_BYTES`). Overflow goes back to the front of the queue.
    const maxBytes = LIMITS.maxBodyBytes - 256;
    let batch = envelope(events);
    while (events.length > 1 && utf8ByteLength(JSON.stringify(batch)) > maxBytes) {
      const keep = Math.ceil(events.length / 2);
      this.pending.unshift(...events.slice(keep));
      events = events.slice(0, keep);
      batch = envelope(events);
    }
    // If even a single event still exceeds the cap (e.g. dense multi-byte UTF-8
    // strings), strip its props rather than sealing an unsendable batch.
    if (utf8ByteLength(JSON.stringify(batch)) > maxBytes) {
      batch = envelope([{ ...events[0], props: {} }]);
      if (utf8ByteLength(JSON.stringify(batch)) > maxBytes) {
        this.bumpDropped();
        return false;
      }
    }

    this.writeStored(batch.batch_id, { sealedAt: this.deps.now(), batch });
    this.enforceStoredCap();
    return true;
  }

  private context(): Props {
    let live: Record<string, unknown> = {};
    try {
      live = this.deps.getContext();
    } catch {
      /* a context that cannot be read is an empty context */
    }
    return sanitizeProps(
      { ...live, dropped_batches: this.droppedCount(), suppressed_events: this.suppressed },
      LIMITS.maxContextKeys,
    );
  }

  // ── Delivering ────────────────────────────────────────────────────────────

  /**
   * Seal what is pending and try to deliver every stored batch, oldest first.
   *
   * Sealing ALWAYS happens synchronously up front — even when a prior delivery
   * is already in flight — so a `pagehide` / `visibilitychange` / quit call
   * never loses newly tracked events if the page exits before the earlier POST
   * settles. Concurrent callers share one delivery loop that re-drains if more
   * batches were sealed mid-flight. Never throws.
   */
  flush(opts?: { keepalive?: boolean }): Promise<void> {
    if (!this.deps.isEnabled()) {
      this.discardAll();
      return Promise.resolve();
    }
    if (this.deps.canSend() && !this.v2Unsupported) {
      this.seal();
    }
    if (this.flushing) {
      this.reflushNeeded = true;
      return this.flushing;
    }
    this.flushing = this.deliverLoop(opts)
      .catch((error) => this.deps.log?.("flush failed", error))
      .finally(() => {
        this.flushing = null;
      });
    return this.flushing;
  }

  private async deliverLoop(opts?: { keepalive?: boolean }): Promise<void> {
    do {
      this.reflushNeeded = false;
      await this.deliver(opts);
    } while (this.reflushNeeded && this.deps.isEnabled() && this.deps.canSend() && !this.v2Unsupported);
  }

  private async deliver(opts?: { keepalive?: boolean }): Promise<void> {
    if (!this.deps.isEnabled()) {
      this.discardAll();
      return;
    }
    if (!this.deps.canSend() || this.v2Unsupported) return;
    this.seal();

    for (const key of this.storedKeys()) {
      const stored = this.readStored(key);
      if (!stored) {
        this.removeStored(key);
        continue;
      }
      if (this.deps.now() - stored.sealedAt > MAX_BATCH_AGE_MS) {
        this.removeStored(key);
        this.bumpDropped();
        continue;
      }
      // Consent may have been withdrawn while an earlier request was in flight.
      if (!this.deps.isEnabled()) {
        this.discardAll();
        return;
      }

      // sent_at is stamped per ATTEMPT: the reporting repo places each event at
      // `received_at - (sent_at - t)`, which only holds if sent_at is when this
      // request actually left, not when the batch was first sealed.
      const body = JSON.stringify({ ...stored.batch, sent_at: this.deps.now() });
      const status = await this.deps.transport.post(EVENTS_PATH, body, opts);
      const result = classifyStatus(status);
      this.deps.log?.(`POST ${EVENTS_PATH} → ${status} (${result})`, stored.batch);

      if (result === "ok") {
        this.removeStored(key);
      } else if (result === "drop") {
        this.removeStored(key);
        this.bumpDropped();
      } else if (result === "unsupported") {
        await this.fallBackToLegacyPing();
        return;
      } else {
        return; // retry later; keep the order
      }
    }
  }

  /**
   * The service has no `/v2/events`. Events cannot be delivered to it at all,
   * so stop collecting for this session and discard what was stored — they are
   * not counted as dropped, since nothing was wrong with them. Then, on the
   * desktop, send the one thing that service does understand: a launch ping.
   * The next launch asks again, so nothing needs to change in the app the day
   * the service is upgraded.
   */
  private async fallBackToLegacyPing(): Promise<void> {
    this.v2Unsupported = true;
    this.clearHeld();
    this.clearStored();
    if (!this.deps.transport.canLegacyPing || this.legacyPingSent) return;
    this.legacyPingSent = true;
    const ping = this.deps.getLegacyPing();
    const status = await this.deps.transport.post(LEGACY_PING_PATH, JSON.stringify(ping));
    this.deps.log?.(`POST ${LEGACY_PING_PATH} → ${status}`, ping);
  }

  /** Forget everything held and stored. Called when sharing is turned off. */
  discardAll(): void {
    this.clearHeld();
    this.clearStored();
  }

  private clearHeld(): void {
    this.pending = [];
    this.counters.clear();
  }

  // ── Storage ───────────────────────────────────────────────────────────────
  //
  // One key per batch, so several windows (each its own JS heap sharing one
  // localStorage) can seal and deliver without a shared index to corrupt. Two
  // windows may occasionally send the same batch; the service stores both and
  // the reporting repo keeps one per batch_id.

  private storedKeys(): string[] {
    const keys: string[] = [];
    const storage = this.deps.storage;
    try {
      if (storage) {
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (key?.startsWith(BATCH_KEY_PREFIX)) keys.push(key);
        }
      }
    } catch {
      /* fall through to the in-memory batches */
    }
    for (const key of this.memory.keys()) {
      if (key.startsWith(BATCH_KEY_PREFIX) && !keys.includes(key)) keys.push(key);
    }
    const sealedAt = (key: string) => this.readStored(key)?.sealedAt ?? 0;
    return keys.sort((a, b) => sealedAt(a) - sealedAt(b));
  }

  private getItem(key: string): string | null {
    try {
      const value = this.deps.storage?.getItem(key);
      if (value != null) return value;
    } catch {
      /* fall through */
    }
    return this.memory.get(key) ?? null;
  }

  private setItem(key: string, value: string): void {
    try {
      if (this.deps.storage) {
        this.deps.storage.setItem(key, value);
        return;
      }
    } catch {
      /* quota exceeded or storage disabled: keep it in memory instead */
    }
    this.memory.set(key, value);
  }

  private removeItem(key: string): void {
    this.memory.delete(key);
    try {
      this.deps.storage?.removeItem(key);
    } catch {
      /* ignore */
    }
  }

  private readStored(key: string): StoredBatch | null {
    try {
      const parsed = JSON.parse(this.getItem(key) ?? "null") as StoredBatch | null;
      return parsed && typeof parsed.sealedAt === "number" && parsed.batch ? parsed : null;
    } catch {
      return null;
    }
  }

  private writeStored(batchId: string, stored: StoredBatch): void {
    this.setItem(BATCH_KEY_PREFIX + batchId, JSON.stringify(stored));
  }

  private removeStored(key: string): void {
    this.removeItem(key);
  }

  private clearStored(): void {
    for (const key of this.storedKeys()) this.removeItem(key);
  }

  private enforceStoredCap(): void {
    const keys = this.storedKeys();
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_STORED_BATCHES))) {
      this.removeStored(key);
      this.bumpDropped();
    }
  }

  private droppedCount(): number {
    const n = Number(this.getItem(DROPPED_KEY));
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  private bumpDropped(): void {
    this.setItem(DROPPED_KEY, String(this.droppedCount() + 1));
  }
}
