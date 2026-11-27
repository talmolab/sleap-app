/**
 * The analytics client (lib/analytics/client.ts): what is sent, what is never
 * sent, and what happens when the service or the network says no.
 *
 * Every effect is injected, so these run against a fake transport, a fake
 * clock and an in-memory `Storage` — no network, no timers.
 */
import { describe, it, expect } from "../bun-test";
import {
  AnalyticsClient,
  EVENTS_PATH,
  LEGACY_PING_PATH,
  MAX_BATCH_AGE_MS,
  MAX_SESSION_EVENTS,
  MAX_STORED_BATCHES,
  classifyStatus,
  type ClientDeps,
  type KeyValueStore,
} from "@/lib/analytics/client";
import { LIMITS, type WireBatch } from "@/lib/analytics/protocol";

class FakeStorage implements KeyValueStore {
  map = new Map<string, string>();
  failWrites = false;
  get length() {
    return this.map.size;
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (this.failWrites) throw new Error("QuotaExceededError");
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  batchKeys() {
    return [...this.map.keys()].filter((k) => k.startsWith("sleap.analytics.batch."));
  }
}

interface Sent {
  path: string;
  body: Record<string, unknown>;
  keepalive: boolean;
}

function harness(overrides: Partial<ClientDeps> = {}, opts: { canLegacyPing?: boolean } = {}) {
  const storage = new FakeStorage();
  const sent: Sent[] = [];
  const flushRequests: number[] = [];
  const state = {
    enabled: true,
    canSend: true,
    now: 1_800_000_000_000,
    /** Status per path; a function gets the attempt number for that path. */
    status: { [EVENTS_PATH]: 200, [LEGACY_PING_PATH]: 200 } as Record<string, number | ((n: number) => number)>,
  };
  let ids = 0;
  const attempts: Record<string, number> = {};
  const deps: ClientDeps = {
    transport: {
      canLegacyPing: opts.canLegacyPing ?? true,
      async post(path, body, o) {
        sent.push({ path, body: JSON.parse(body), keepalive: o?.keepalive === true });
        attempts[path] = (attempts[path] ?? 0) + 1;
        const s = state.status[path];
        return typeof s === "function" ? s(attempts[path]) : (s ?? 0);
      },
    },
    storage,
    version: "0.2.0",
    installId: "install-0000-0001",
    sessionId: "session-0000-0001",
    now: () => state.now,
    uuid: () => `batch-0000-${String(++ids).padStart(4, "0")}`,
    isEnabled: () => state.enabled,
    canSend: () => state.canSend,
    getContext: () => ({ runtime: "desktop", os: "macos" }),
    getLegacyPing: () => ({
      sleap_version: "sleap-app/0.2.0",
      python_version: "N/A",
      tf_version: "N/A",
      conda_env: "",
      platform: "macOS-14.5-arm64",
    }),
    requestFlush: (delay) => flushRequests.push(delay),
    ...overrides,
  };
  const client = new AnalyticsClient(deps);
  const batches = () => sent.filter((s) => s.path === EVENTS_PATH).map((s) => s.body as unknown as WireBatch);
  return { client, storage, sent, state, flushRequests, batches };
}

const START = { first_run: false, prior_crash: false };

describe("classifyStatus", () => {
  it("separates delivered, retry, drop and no-such-endpoint", () => {
    expect([200, 201, 204].map(classifyStatus)).toEqual(["ok", "ok", "ok"]);
    expect([404, 405].map(classifyStatus)).toEqual(["unsupported", "unsupported"]);
    expect([0, 408, 425, 429, 500, 502, 503].map(classifyStatus)).toEqual(Array(7).fill("retry"));
    expect([400, 401, 403, 413, 415, 422].map(classifyStatus)).toEqual(Array(6).fill("drop"));
  });
});

describe("a delivered batch", () => {
  it("carries the envelope the service requires", async () => {
    const h = harness();
    h.client.track("session_start", START);
    await h.client.flush();

    expect(h.sent).toHaveLength(1);
    const [batch] = h.batches();
    expect(batch).toMatchObject({
      schema: 1,
      product: "sleap-app",
      version: "0.2.0",
      install_id: "install-0000-0001",
      session_id: "session-0000-0001",
      sent_at: h.state.now,
    });
    expect(batch.batch_id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{7,63}$/);
    expect(batch.events).toEqual([{ name: "session_start", t: h.state.now, seq: 0, props: START }]);
    expect(batch.context).toMatchObject({ runtime: "desktop", os: "macos", dropped_batches: 0 });
  });

  it("is removed from storage once the service has it", async () => {
    const h = harness();
    h.client.track("session_start", START);
    await h.client.flush();
    expect(h.storage.batchKeys()).toEqual([]);
    await h.client.flush();
    expect(h.sent).toHaveLength(1); // nothing left to send
  });

  it("folds usage counters into one event", async () => {
    const h = harness();
    h.client.count("m:file.save");
    h.client.count("m:file.save");
    h.client.count("c:AddInstance", 3);
    await h.client.flush();
    const [batch] = h.batches();
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]).toMatchObject({ name: "usage", props: { "m:file.save": 2, "c:AddInstance": 3 } });
    // Counters reset once sealed.
    await h.client.flush();
    expect(h.sent).toHaveLength(1);
  });

  it("numbers events across batches so a lost batch shows as a gap", async () => {
    const h = harness();
    h.client.track("session_start", START);
    await h.client.flush();
    h.client.track("inference_started", {});
    h.client.track("inference_finished", { outcome: "completed", duration_s: 4 });
    await h.client.flush();
    expect(h.batches().flatMap((b) => b.events.map((e) => e.seq))).toEqual([0, 1, 2]);
  });

  it("asks for a prompt flush after events that a crash would otherwise lose", () => {
    const h = harness();
    h.client.track("heartbeat", { uptime_s: 1, active_s: 1 });
    expect(h.flushRequests).toEqual([]);
    h.client.track("session_start", START);
    expect(h.flushRequests).toHaveLength(1);
  });

  it("passes keepalive through for the send made while the page is closing", async () => {
    const h = harness();
    h.client.track("session_start", START);
    await h.client.flush({ keepalive: true });
    expect(h.sent[0].keepalive).toBe(true);
  });

  it("shares one run between concurrent flushes", async () => {
    const h = harness();
    h.client.track("session_start", START);
    await Promise.all([h.client.flush(), h.client.flush(), h.client.flush()]);
    expect(h.sent).toHaveLength(1);
  });
});

describe("consent", () => {
  it("collects nothing while sharing is off", async () => {
    const h = harness();
    h.state.enabled = false;
    h.client.track("session_start", START);
    h.client.count("m:file.save");
    h.client.trackError({ kind: "uncaught", fp: "abcd1234", message: "boom", stack: "", after: null });
    await h.client.flush();
    expect(h.sent).toEqual([]);
    expect(h.storage.batchKeys()).toEqual([]);
    expect(h.client.hasPending()).toBe(false);
  });

  it("discards what was already collected when sharing is turned off", async () => {
    const h = harness();
    h.client.track("session_start", START);
    h.client.count("m:file.save");
    h.state.enabled = false;
    await h.client.flush();
    expect(h.sent).toEqual([]);
    expect(h.client.hasPending()).toBe(false);
  });

  it("discards batches already stored for retry when sharing is turned off", async () => {
    const h = harness();
    h.state.status[EVENTS_PATH] = 503;
    h.client.track("session_start", START);
    await h.client.flush();
    expect(h.storage.batchKeys()).toHaveLength(1);

    h.state.enabled = false;
    h.state.status[EVENTS_PATH] = 200;
    await h.client.flush();
    expect(h.storage.batchKeys()).toEqual([]);
    expect(h.sent).toHaveLength(1); // only the original, failed attempt
  });

  it("stops mid-delivery if sharing is turned off while a request is in flight", async () => {
    const h = harness();
    h.state.status[EVENTS_PATH] = 503;
    h.client.track("session_start", START);
    await h.client.flush();
    h.state.now += 1000;
    h.client.track("inference_started", {});
    await h.client.flush(); // two batches stored, both undelivered
    expect(h.storage.batchKeys()).toHaveLength(2);

    const before = h.sent.length;
    h.state.status[EVENTS_PATH] = () => {
      h.state.enabled = false; // the user opts out during the first request
      return 200;
    };
    await h.client.flush();
    expect(h.sent.length - before).toBe(1);
    expect(h.storage.batchKeys()).toEqual([]);
  });

  it("discardAll forgets everything immediately", () => {
    const h = harness();
    h.state.status[EVENTS_PATH] = 503;
    h.client.track("session_start", START);
    h.client.seal();
    h.client.count("m:file.save");
    h.client.discardAll();
    expect(h.storage.batchKeys()).toEqual([]);
    expect(h.client.hasPending()).toBe(false);
  });
});

describe("the first-run hold", () => {
  it("neither stores nor sends before the notice has been seen", async () => {
    const h = harness();
    h.state.canSend = false;
    h.client.track("session_start", START);
    h.client.count("m:file.open");
    expect(h.client.seal()).toBe(false);
    await h.client.flush();
    expect(h.sent).toEqual([]);
    expect(h.storage.map.size).toBe(0);
    expect(h.client.hasPending()).toBe(true); // held in memory only
  });

  it("delivers what was held once the notice has been seen", async () => {
    const h = harness();
    h.state.canSend = false;
    h.client.track("session_start", START);
    await h.client.flush();
    h.state.canSend = true;
    await h.client.flush();
    expect(h.batches()[0].events.map((e) => e.name)).toEqual(["session_start"]);
  });

  it("drops what was held if the user turns sharing off from the notice", async () => {
    const h = harness();
    h.state.canSend = false;
    h.client.track("session_start", START);
    h.state.enabled = false;
    h.state.canSend = true;
    await h.client.flush();
    expect(h.sent).toEqual([]);
  });
});

describe("when the service has no /v2/events (404)", () => {
  it("sends one legacy ping from the desktop app and stops collecting", async () => {
    const h = harness();
    h.state.status[EVENTS_PATH] = 404;
    h.client.track("session_start", START);
    await h.client.flush();

    expect(h.sent.map((s) => s.path)).toEqual([EVENTS_PATH, LEGACY_PING_PATH]);
    expect(h.sent[1].body).toEqual({
      sleap_version: "sleap-app/0.2.0",
      python_version: "N/A",
      tf_version: "N/A",
      conda_env: "",
      platform: "macOS-14.5-arm64",
    });
    expect(h.storage.batchKeys()).toEqual([]);

    // The rest of the session is silent: no events pile up, no second ping.
    h.client.track("inference_started", {});
    h.client.count("m:file.save");
    await h.client.flush();
    expect(h.sent).toHaveLength(2);
    expect(h.client.hasPending()).toBe(false);
  });

  it("does not count the undeliverable batch as dropped", async () => {
    const h = harness();
    h.state.status[EVENTS_PATH] = 404;
    h.client.track("session_start", START);
    await h.client.flush();
    expect(h.storage.getItem("sleap.analytics.dropped")).toBeNull();
  });

  it("sends no ping from the web app, which cannot reach /ping", async () => {
    const h = harness({}, { canLegacyPing: false });
    h.state.status[EVENTS_PATH] = 404;
    h.client.track("session_start", START);
    await h.client.flush();
    expect(h.sent.map((s) => s.path)).toEqual([EVENTS_PATH]);
  });

  it("asks again on the next launch, so an upgraded service is picked up", async () => {
    const storage = new FakeStorage();
    const first = harness({ storage });
    first.state.status[EVENTS_PATH] = 404;
    first.client.track("session_start", START);
    await first.client.flush();

    const second = harness({ storage }); // a new session; the service now has v2
    second.client.track("session_start", START);
    await second.client.flush();
    expect(second.sent.map((s) => s.path)).toEqual([EVENTS_PATH]);
  });
});

describe("when delivery fails", () => {
  it("keeps the batch and retries it on a later flush (5xx, offline)", async () => {
    for (const failure of [503, 0, 429]) {
      const h = harness();
      h.state.status[EVENTS_PATH] = (n) => (n === 1 ? failure : 200);
      h.client.track("session_start", START);
      await h.client.flush();
      expect(h.storage.batchKeys()).toHaveLength(1);
      await h.client.flush();
      expect(h.storage.batchKeys()).toEqual([]);
      const [a, b] = h.batches();
      expect(b.batch_id).toBe(a.batch_id); // same id, so the server can dedupe
    }
  });

  it("re-stamps sent_at on every attempt", async () => {
    const h = harness();
    h.state.status[EVENTS_PATH] = (n) => (n === 1 ? 503 : 200);
    h.client.track("session_start", START);
    const tracked = h.state.now;
    await h.client.flush();
    h.state.now += 60_000;
    await h.client.flush();
    const [first, second] = h.batches();
    expect(second.sent_at - first.sent_at).toBe(60_000);
    expect(second.events[0].t).toBe(tracked); // the event's own time does not move
  });

  it("stops at the first failure and keeps the order", async () => {
    const h = harness();
    h.state.status[EVENTS_PATH] = 503;
    h.client.track("session_start", START);
    await h.client.flush();
    h.state.now += 1000;
    h.client.track("inference_started", {});
    await h.client.flush();
    expect(h.sent).toHaveLength(2); // one attempt per flush, never a burst
    h.state.status[EVENTS_PATH] = 200;
    await h.client.flush();
    expect(h.batches().slice(2).map((b) => b.events[0].name)).toEqual(["session_start", "inference_started"]);
  });

  it("drops a batch the service calls malformed, and reports the drop next time", async () => {
    const h = harness();
    h.state.status[EVENTS_PATH] = (n) => (n === 1 ? 422 : 200);
    h.client.track("session_start", START);
    await h.client.flush();
    expect(h.storage.batchKeys()).toEqual([]); // not retried forever

    h.client.track("inference_started", {});
    await h.client.flush();
    expect(h.batches()[1].context.dropped_batches).toBe(1);
  });

  it("drops a stored batch that has become too old to matter", async () => {
    const h = harness();
    h.state.status[EVENTS_PATH] = 503;
    h.client.track("session_start", START);
    await h.client.flush();
    h.state.now += MAX_BATCH_AGE_MS + 1;
    h.state.status[EVENTS_PATH] = 200;
    await h.client.flush();
    expect(h.sent).toHaveLength(1);
    expect(h.storage.batchKeys()).toEqual([]);
  });

  it("bounds how many batches wait in storage, dropping the oldest", async () => {
    const h = harness();
    h.state.status[EVENTS_PATH] = 0; // offline for a long time
    for (let i = 0; i < MAX_STORED_BATCHES + 5; i++) {
      h.state.now += 1000;
      h.client.track("heartbeat", { uptime_s: i, active_s: i });
      h.client.seal();
    }
    expect(h.storage.batchKeys()).toHaveLength(MAX_STORED_BATCHES);
    expect(h.storage.getItem("sleap.analytics.dropped")).toBe("5");
  });

  it("delivers a batch left behind by a previous session", async () => {
    const storage = new FakeStorage();
    const crashed = harness({ storage, sessionId: "session-that-crashed" });
    crashed.state.status[EVENTS_PATH] = 0;
    crashed.client.track("session_start", START);
    await crashed.client.flush();

    const next = harness({ storage, sessionId: "session-after-restart" });
    await next.client.flush();
    expect(next.batches().map((b) => b.session_id)).toEqual(["session-that-crashed"]);
  });

  it("never throws, even when the transport does", async () => {
    const h = harness({
      transport: {
        canLegacyPing: true,
        post: async () => {
          throw new Error("transport exploded");
        },
      },
    });
    h.client.track("session_start", START);
    await h.client.flush(); // resolves
    expect(h.storage.batchKeys()).toHaveLength(1);
  });
});

describe("storage that is missing or failing", () => {
  it("falls back to memory when there is no storage", async () => {
    const h = harness({ storage: null });
    h.client.track("session_start", START);
    await h.client.flush();
    expect(h.batches()).toHaveLength(1);
  });

  it("falls back to memory when writes are refused (quota, private mode)", async () => {
    const h = harness();
    h.storage.failWrites = true;
    h.state.status[EVENTS_PATH] = (n) => (n === 1 ? 503 : 200);
    h.client.track("session_start", START);
    await h.client.flush();
    await h.client.flush();
    expect(h.batches()).toHaveLength(2);
    expect(h.batches()[1].batch_id).toBe(h.batches()[0].batch_id);
  });

  it("ignores unreadable entries under its own prefix", async () => {
    const h = harness();
    h.storage.map.set("sleap.analytics.batch.garbage", "{not json");
    h.client.track("session_start", START);
    await h.client.flush();
    expect(h.batches()).toHaveLength(1);
    expect(h.storage.batchKeys()).toEqual([]);
  });

  it("touches no storage key outside its own namespace", async () => {
    const h = harness();
    h.storage.map.set("sleap.diagnostics.installId", "keep-me");
    h.storage.map.set("some-other-app", "keep-me-too");
    h.client.track("session_start", START);
    await h.client.flush();
    h.client.discardAll();
    expect(h.storage.getItem("sleap.diagnostics.installId")).toBe("keep-me");
    expect(h.storage.getItem("some-other-app")).toBe("keep-me-too");
  });
});

describe("limits", () => {
  it("stays inside the service's event and body caps", async () => {
    const h = harness();
    for (let i = 0; i < 260; i++) {
      h.client.track("error", {
        kind: "uncaught",
        fp: `fp${i}`,
        message: "m".repeat(300),
        stack: "s".repeat(500),
        count: 1,
        after: null,
      });
    }
    for (let i = 0; i < 20 && (i === 0 || h.client.hasPending()); i++) await h.client.flush();
    expect(h.client.hasPending()).toBe(false);
    const batches = h.batches();
    expect(batches.length).toBeGreaterThan(2); // 99 of these exceed the body cap, so it split
    for (const batch of batches) {
      expect(batch.events.length).toBeLessThanOrEqual(LIMITS.maxEvents);
      expect(JSON.stringify(batch).length).toBeLessThanOrEqual(LIMITS.maxBodyBytes);
    }
    // Nothing was lost to the splitting.
    expect(batches.flatMap((b) => b.events).length).toBe(260);
  });

  it("caps events per session and reports how many it suppressed", async () => {
    const h = harness();
    for (let i = 0; i < MAX_SESSION_EVENTS + 40; i++) h.client.track("inference_started", {});
    for (let i = 0; i < 8; i++) await h.client.flush();
    expect(h.batches().flatMap((b) => b.events).length).toBe(MAX_SESSION_EVENTS);
    h.client.count("m:file.save"); // counters still flow: the usage event is one event
    await h.client.flush();
    expect(h.batches().at(-1)?.context.suppressed_events).toBe(40);
  });

  it("sums usage keys past the cap under `other`", async () => {
    const h = harness();
    for (let i = 0; i < 200; i++) h.client.count(`m:item${i}`);
    await h.client.flush();
    const props = h.batches()[0].events[0].props;
    expect(Object.keys(props).length).toBeLessThanOrEqual(LIMITS.maxPropsKeys);
    expect(Object.values(props).reduce((a: number, b) => a + (b as number), 0)).toBe(200);
    expect(props.other).toBeGreaterThan(0);
  });

  it("ignores usage keys and event names the service would reject", async () => {
    const h = harness();
    h.client.count("key with spaces");
    h.client.count("m:/Users/jane/secret.slp");
    // @ts-expect-error -- not in the catalog
    h.client.track("Not A Valid Name", {});
    expect(h.client.hasPending()).toBe(false);
  });
});

describe("trackError", () => {
  const error = (fp: string) => ({ kind: "uncaught" as const, fp, message: "boom", stack: "", after: null });

  it("sends the first occurrence, then only at 10, 100, 1000…", async () => {
    const h = harness();
    for (let i = 0; i < 1000; i++) h.client.trackError(error("aaaa1111"));
    await h.client.flush();
    const counts = h.batches()[0].events.map((e) => e.props.count);
    expect(counts).toEqual([1, 10, 100, 1000]);
  });

  it("reports a bounded number of distinct errors per session", async () => {
    const h = harness();
    for (let i = 0; i < 100; i++) h.client.trackError(error(`fp-${i}`));
    await h.client.flush();
    expect(h.batches()[0].events).toHaveLength(25);
  });
});

describe("UTF-8 byte sizing and in-flight flush sealing", () => {
  it("respects UTF-8 byte length for multi-byte strings so Rust/Python never 413", async () => {
    const h = harness();
    // Each CJK char is 1 UTF-16 code unit but 3 UTF-8 bytes.
    const multibyte = "あ".repeat(250); // 750 bytes each
    for (let i = 0; i < 120; i++) {
      h.client.track("error", {
        kind: "uncaught",
        fp: `mb${i}`,
        message: multibyte,
        stack: "",
        count: 1,
        after: null,
      });
    }
    for (let i = 0; i < 20 && (i === 0 || h.client.hasPending()); i++) await h.client.flush();
    for (const batch of h.batches()) {
      expect(new TextEncoder().encode(JSON.stringify(batch)).byteLength).toBeLessThanOrEqual(
        LIMITS.maxBodyBytes,
      );
    }
  });

  it("seals newly tracked events synchronously even while another flush is in flight", async () => {
    let releaseFirst!: (status: number) => void;
    let calls = 0;
    const h = harness({
      transport: {
        canLegacyPing: true,
        post(_path, _body) {
          calls++;
          if (calls === 1) {
            return new Promise<number>((resolve) => {
              releaseFirst = resolve;
            });
          }
          return Promise.resolve(200);
        },
      },
    });

    h.client.track("session_start", START);
    const firstFlush = h.client.flush();

    // While the first POST is in flight, a pagehide/quit tracks a heartbeat and calls flush().
    h.client.track("heartbeat", { uptime_s: 30, active_s: 25 });
    const secondFlush = h.client.flush({ keepalive: true });

    // The second batch MUST already be sealed in localStorage before the first POST settles.
    expect(h.storage.batchKeys()).toHaveLength(2);

    releaseFirst(200);
    await Promise.all([firstFlush, secondFlush]);
    expect(calls).toBe(2);
    expect(h.storage.batchKeys()).toEqual([]);
  });
});
