import { describe, it, expect, beforeEach, afterEach, vi } from "../bun-test";
import {
  useConnectStore,
  pathRulesFor,
  type PairedWorker,
  type TrackedJob,
  capTrackedJobs,
  migrateConnectPersisted,
  resubscribeWorker,
  syncDeviceNameFromStorage,
  __resetManagedConnections,
  __setManagedDeps,
} from "@/stores/connectStore";
import type { JobSpec } from "@/lib/sleapConnect";
import type { WorkerClient } from "@/lib/protocolV1/client";
import type { PathMapping } from "@/lib/pathMappings";
import {
  WorkerProtocolError,
  FS_NOT_FOUND,
  FS_FORBIDDEN,
  AUTH_UNTRUSTED,
} from "@/lib/protocolV1/errors";
import { buildPairCode, base64UrlEncode, fakeBytes, mistypeCode } from "./buildPairCode";

// connectStore's own actions (pairing flow, browse pagination, job
// submission/multi-model splitting, cancel/stop) are what's under test here.
// WorkerClient's wire behavior (hello, auth, envelope framing, event
// ordering) is already covered by tests/unit/protocolV1Client.test.ts — this
// fake stands in for it as a trusted dependency, matching this repo's
// "class tests + thin integration" default for wiring code.
interface FakeMount {
  path: string;
  label?: string;
}
interface FakeFsEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
}
interface FakeWorkerEvent {
  topic: string;
  jobId: string;
  seq: number;
  data: Record<string, unknown>;
}

class FakeWorkerClient {
  static instances: FakeWorkerClient[] = [];
  /** What the next-constructed instance's fsMounts() will resolve to. */
  static nextMounts: FakeMount[] = [];
  /** What the next-constructed instance's peerNodeId will report post-connect(). */
  static nextPeerNodeId: string | null = "worker-node-id";
  /** One-shot: the NEXT-constructed instance's connect() throws this once, then clears — simulates a failed redial. */
  static nextConnectShouldThrow: Error | null = null;
  /** One-shot: the NEXT-constructed instance's authProve() throws this. */
  static nextAuthProveShouldThrow: Error | null = null;

  peerNodeId: string | null;
  authenticated = false;
  closed = false;
  connectCalls = 0;
  connectShouldThrow: Error | null = null;
  pairClaimArgs: string[] = [];
  pairClaimShouldThrow: Error | null = null;
  authProveCalls = 0;
  authProveShouldThrow: Error | null = null;
  jobsSubmitCalls: Record<string, unknown>[] = [];
  jobsCancelCalls: Array<[string, string]> = [];
  jobsDeleteCalls: string[][] = [];
  jobsDeleteShouldThrow: Error | null = null;
  jobsStatusCalls: string[] = [];
  jobsSubscribeCalls: Array<[string, number]> = [];
  fsListCalls: Array<[string, number]> = [];

  mountsResult: FakeMount[] = [];
  fsListResults: Array<{ entries: FakeFsEntry[]; totalCount: number; hasMore: boolean }> = [
    { entries: [], totalCount: 0, hasMore: false },
  ];
  jobsSubmitResult = { jobId: "job_1" };
  /** What jobsStatus() resolves to; `null` makes it reject (job.not_found). */
  jobsStatusResult: { state: string } | null = null;
  jobsListCalls = 0;
  jobsListResult: Array<Record<string, unknown>> = [];
  jobsListShouldThrow: Error | null = null;
  workerInfoCalls = 0;
  workerInfoResult: Record<string, unknown> = {
    gpuModel: "RTX 4090",
    gpuMemoryMb: 24576,
    gpuCount: 1,
    cudaVersion: "12.4",
    sleapNnVersion: "0.1.0",
    busy: false,
  };
  workerInfoShouldThrow: Error | null = null;
  fetchBlobCalls: Array<[string, number | undefined]> = [];
  fetchBlobResult = new Uint8Array([1, 2, 3]);
  fetchBlobShouldThrow: Error | null = null;
  fsStatCalls: string[] = [];
  /** Keyed by path; `undefined` (unconfigured) means "not found". An `Error` value is thrown as-is. */
  fsStatResults: Record<string, { type: "file" | "directory" } | Error> = {};

  private _subscribers = new Map<string, Set<(e: FakeWorkerEvent) => void>>();
  private _seq = 0;
  private _closeListeners = new Set<(info: { intentional: boolean; error?: unknown }) => void>();

  clientsRenameCalls: string[] = [];
  clientsLeaveCalls = 0;

  async clientsLeave() {
    this.clientsLeaveCalls++;
    return { removed: true };
  }

  async clientsRename(name: string) {
    this.clientsRenameCalls.push(name);
  }

  constructor(
    public opts: {
      url: string;
      createSocket?: (url: string) => unknown;
      agent?: { device_name?: string };
    },
  ) {
    this.mountsResult = FakeWorkerClient.nextMounts;
    this.peerNodeId = FakeWorkerClient.nextPeerNodeId;
    this.authProveShouldThrow = FakeWorkerClient.nextAuthProveShouldThrow;
    FakeWorkerClient.nextAuthProveShouldThrow = null;
    FakeWorkerClient.instances.push(this);
  }

  async connect() {
    this.connectCalls++;
    if (this.connectShouldThrow) throw this.connectShouldThrow;
    if (FakeWorkerClient.nextConnectShouldThrow) {
      const err = FakeWorkerClient.nextConnectShouldThrow;
      FakeWorkerClient.nextConnectShouldThrow = null;
      throw err;
    }
  }

  onClose(cb: (info: { intentional: boolean; error?: unknown }) => void): () => void {
    this._closeListeners.add(cb);
    return () => this._closeListeners.delete(cb);
  }

  /** Test helper: simulate the worker connection dropping (an unintentional close). */
  simulateDrop(): void {
    for (const cb of [...this._closeListeners]) cb({ intentional: false });
  }

  async pairClaim(secret: string) {
    this.pairClaimArgs.push(secret);
    if (this.pairClaimShouldThrow) throw this.pairClaimShouldThrow;
    this.authenticated = true;
  }

  async authProve() {
    this.authProveCalls++;
    if (this.authProveShouldThrow) throw this.authProveShouldThrow;
    this.authenticated = true;
  }

  async fsMounts() {
    return this.mountsResult;
  }

  async fsList(path: string, offset = 0) {
    this.fsListCalls.push([path, offset]);
    return this.fsListResults[this.fsListCalls.length - 1] ?? { entries: [], totalCount: 0, hasMore: false };
  }

  async jobsSubmit(spec: Record<string, unknown>) {
    this.jobsSubmitCalls.push(spec);
    return this.jobsSubmitResult;
  }

  jobsCancelShouldThrow: Error | null = null;
  async jobsCancel(jobId: string, mode: string) {
    this.jobsCancelCalls.push([jobId, mode]);
    if (this.jobsCancelShouldThrow) throw this.jobsCancelShouldThrow;
  }

  async jobsDelete(jobIds: string[]) {
    this.jobsDeleteCalls.push(jobIds);
    if (this.jobsDeleteShouldThrow) throw this.jobsDeleteShouldThrow;
    return { deleted: jobIds };
  }

  async jobsStatus(jobId: string) {
    this.jobsStatusCalls.push(jobId);
    if (this.jobsStatusResult === null) throw new Error("job.not_found");
    return this.jobsStatusResult;
  }

  async jobsList() {
    this.jobsListCalls++;
    if (this.jobsListShouldThrow) throw this.jobsListShouldThrow;
    return this.jobsListResult;
  }

  async workerInfo() {
    this.workerInfoCalls++;
    if (this.workerInfoShouldThrow) throw this.workerInfoShouldThrow;
    return this.workerInfoResult;
  }

  async fetchBlob(sha256: string, expectedSize?: number) {
    this.fetchBlobCalls.push([sha256, expectedSize]);
    if (this.fetchBlobShouldThrow) throw this.fetchBlobShouldThrow;
    return this.fetchBlobResult;
  }

  async fsStat(path: string) {
    this.fsStatCalls.push(path);
    const entry = this.fsStatResults[path];
    if (entry === undefined) {
      throw new WorkerProtocolError(FS_NOT_FOUND, `fs.stat('${path}'): not found`);
    }
    if (entry instanceof Error) throw entry;
    return { path, type: entry.type, size: 0, modified: 0 };
  }

  async jobsSubscribe(jobId: string, sinceSeq: number, cb: (e: FakeWorkerEvent) => void) {
    this.jobsSubscribeCalls.push([jobId, sinceSeq]);
    let set = this._subscribers.get(jobId);
    if (!set) {
      set = new Set();
      this._subscribers.set(jobId, set);
    }
    set.add(cb);
    return () => {
      set?.delete(cb);
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const cb of [...this._closeListeners]) cb({ intentional: true });
  }

  /**
   * Test helper: simulate the worker pushing an event to subscribers. `seq`
   * defaults to an auto-incrementing per-instance counter so a sequence of
   * `emit` calls for the same job gets strictly increasing seqs, the way the
   * real worker does — connectStore's seq-dedup would otherwise drop every
   * event after the first if they all arrived with the same hardcoded seq.
   */
  emit(jobId: string, topic: string, data: Record<string, unknown>, seq: number = ++this._seq) {
    for (const cb of this._subscribers.get(jobId) ?? []) cb({ topic, jobId, seq, data });
  }
}

function lastClient(): FakeWorkerClient {
  const c = FakeWorkerClient.instances[FakeWorkerClient.instances.length - 1];
  if (!c) throw new Error("no FakeWorkerClient constructed yet");
  return c;
}

/** Lets a `submitJob` in flight advance to the point it's registered its subscription. */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Makes every `FakeWorkerClient`'s `jobsSubmit` return sequential ids
 * (`${prefix}_1`, `${prefix}_2`, ...) instead of the fixed
 * `jobsSubmitResult` — needed for `submitJobsOn` tests, which (unlike
 * `submitJob`'s sequential-await tests) submit several real jobs before any
 * of them "complete" and so need distinguishable ids to track separately.
 * `prefix` must be unique per test (see the `submitJobsOn` describe block's
 * own comment on why). Returns a restore function.
 */
function withSequentialJobIds(prefix: string): () => void {
  let n = 0;
  const original = FakeWorkerClient.prototype.jobsSubmit;
  FakeWorkerClient.prototype.jobsSubmit = async function (
    this: FakeWorkerClient,
    spec: Record<string, unknown>,
  ) {
    this.jobsSubmitCalls.push(spec);
    return { jobId: `${prefix}_${++n}` };
  };
  return () => {
    FakeWorkerClient.prototype.jobsSubmit = original;
  };
}

/** Polls a predicate across microtask ticks — used with a fake `__setManagedDeps`
 * clock, where every `ManagedConnection` step resolves via an already-settled
 * promise rather than real time passing. */
async function waitUntil(predicate: () => boolean, maxTicks = 500): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error("waitUntil: condition not met within the tick budget");
}

vi.mock("@/lib/protocolV1/identity", () => ({
  getClientIdentity: async () => ({
    nodeId: "client-node-id",
    sign: async (nonce: string) => `sig(${nonce})`,
  }),
}));
vi.mock("@/lib/protocolV1/client", () => ({
  WorkerClient: FakeWorkerClient,
}));
vi.mock("@/lib/notify", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
/** What the next `loadSavedMappings()` call resolves to (the one-time import on first connect). */
let nextSavedMappings: PathMapping[] = [];
vi.mock("@/lib/pathMappings", () => ({
  loadSavedMappings: async () => nextSavedMappings,
}));

const TICKET = JSON.stringify({
  node_id: "worker-node-id",
  addrs: ["ws://192.168.1.42:9631"],
  secret: "one-time-secret",
  expires_at: "2026-09-27T18:00:00Z",
});

const PAIRED_WORKER: PairedWorker = {
  nodeId: "worker-node-id",
  label: "Worker worker-n",
  addrs: ["ws://192.168.1.42:9631"],
  pairedAt: "2026-09-27T00:00:00Z",
};

function makeTracked(overrides: Partial<TrackedJob> = {}): TrackedJob {
  return {
    workerId: PAIRED_WORKER.nodeId,
    jobId: "job_1",
    lastSeq: 0,
    kind: "track",
    label: "Inference",
    source: "window",
    state: "active",
    seen: false,
    submittedAt: Date.now(),
    ...overrides,
  };
}

describe("connectStore", () => {
  beforeEach(async () => {
    FakeWorkerClient.instances.length = 0;
    FakeWorkerClient.nextMounts = [];
    FakeWorkerClient.nextPeerNodeId = "worker-node-id";
    FakeWorkerClient.nextConnectShouldThrow = null;
    FakeWorkerClient.nextAuthProveShouldThrow = null;
    nextSavedMappings = [];
    // `managed`/`activeSubscriptions` are module-level state that outlives
    // any one test in this file (--isolate resets per FILE, not per test) —
    // without this, a connection a previous test left running in the
    // background would keep retrying/probing into this one.
    __resetManagedConnections();
    __setManagedDeps({});
    // Same reasoning for the toast mock's call history (resumeTrackedJobs
    // tests) and the module-level notifiedJobIds de-dupe set.
    const { toast } = await import("@/lib/notify");
    (toast.success as unknown as ReturnType<typeof vi.fn>).mockClear();
    (toast.error as unknown as ReturnType<typeof vi.fn>).mockClear();
    (toast.info as unknown as ReturnType<typeof vi.fn>).mockClear();
    useConnectStore.setState({
      pairedWorkers: [],
      selectedWorkerId: null,
      trackedJobs: [],
      deviceName: null,
      connectionStatus: "disconnected",
      connectionError: null,
      workerMounts: [],
      reattachableJob: null,
      activeTransport: null,
      connections: {},
      workerErrors: {},
      workerInfo: {},
      _client: null,
    });
  });

  describe("transport (ws default)", () => {
    const TICKET_WITH_IROH = JSON.stringify({
      node_id: "worker-node-id",
      addrs: ["ws://192.168.1.42:9631"],
      secret: "one-time-secret",
      iroh: { node_id: "iroh-id", relay_url: "https://relay.example", direct_addrs: ["1.2.3.4:5"] },
    });

    it("a ticket without an iroh section connects over ws and records activeTransport 'ws'", async () => {
      await useConnectStore.getState().pairWithTicket(TICKET);
      const state = useConnectStore.getState();
      expect(lastClient().opts.createSocket).toBeUndefined();
      expect(state.activeTransport).toBe("ws");
      expect(state.pairedWorkers[0].iroh).toBeUndefined();
      expect(state.pairedWorkers[0].transport).toBeUndefined();
    });

    it("keeps ws behavior for a ticket with an iroh section unless iroh is asked for, and remembers the section", async () => {
      await useConnectStore.getState().pairWithTicket(TICKET_WITH_IROH);
      const state = useConnectStore.getState();
      expect(lastClient().opts.url).toBe("ws://192.168.1.42:9631");
      expect(state.activeTransport).toBe("ws");
      expect(state.pairedWorkers[0].iroh).toEqual({
        nodeId: "iroh-id",
        relayUrl: "https://relay.example",
        directAddrs: ["1.2.3.4:5"],
      });
    });

    it("rejects an explicit iroh connect outside the desktop app, before touching connection state", async () => {
      await expect(
        useConnectStore.getState().pairWithTicket(TICKET_WITH_IROH, undefined, { transport: "iroh" }),
      ).rejects.toThrow(/desktop app/);
      const state = useConnectStore.getState();
      expect(state.connectionStatus).toBe("disconnected");
      expect(state.activeTransport).toBeNull();
      expect(FakeWorkerClient.instances).toHaveLength(0);
    });

    it("disconnect clears activeTransport", async () => {
      await useConnectStore.getState().pairWithTicket(TICKET);
      useConnectStore.getState().disconnect();
      expect(useConnectStore.getState().activeTransport).toBeNull();
    });
  });

  describe("pairWithTicket", () => {
    it("connects, claims the ticket, fetches mounts, and records the paired worker", async () => {
      FakeWorkerClient.nextMounts = [{ path: "/mnt/data", label: "Lab data" }];

      await useConnectStore.getState().pairWithTicket(TICKET);

      // The pairing client claims the ticket...
      const pairingClient = FakeWorkerClient.instances[0];
      expect(pairingClient.opts.url).toBe("ws://192.168.1.42:9631");
      expect(pairingClient.connectCalls).toBe(1);
      expect(pairingClient.pairClaimArgs).toEqual(["one-time-secret"]);

      const state = useConnectStore.getState();
      expect(state.connectionStatus).toBe("connected");
      expect(state.selectedWorkerId).toBe("worker-node-id");
      expect(state.workerMounts).toEqual([{ path: "/mnt/data", label: "Lab data" }]);
      expect(state.pairedWorkers).toHaveLength(1);
      expect(state.pairedWorkers[0].nodeId).toBe("worker-node-id");
      expect(state.pairedWorkers[0].addrs[0]).toBe("ws://192.168.1.42:9631");
    });

    it("rejects invalid ticket JSON without touching connection state", async () => {
      await expect(useConnectStore.getState().pairWithTicket("not json")).rejects.toThrow();
      expect(useConnectStore.getState().connectionStatus).toBe("disconnected");
    });

    it("rejects a ticket missing node_id or secret", async () => {
      await expect(
        useConnectStore.getState().pairWithTicket(JSON.stringify({ addrs: ["ws://x"] })),
      ).rejects.toThrow(/node_id or secret/);
    });

    it("rejects when there's no address (ticket and no override)", async () => {
      const noAddr = JSON.stringify({ node_id: "n", secret: "s", addrs: [] });
      await expect(useConnectStore.getState().pairWithTicket(noAddr)).rejects.toThrow(/address/);
    });

    it("uses an explicit address override even if the ticket has one", async () => {
      await useConnectStore.getState().pairWithTicket(TICKET, "ws://override:1234");
      expect(lastClient().opts.url).toBe("ws://override:1234");
    });

    it("sets connectionStatus to 'error' if the worker can't be reached", async () => {
      // Prime a client that will throw on connect() — done by pairing once
      // successfully is not an option, so patch the class default instead.
      const originalConnect = FakeWorkerClient.prototype.connect;
      FakeWorkerClient.prototype.connect = async function (this: FakeWorkerClient) {
        throw new Error("connection refused");
      };
      try {
        await expect(useConnectStore.getState().pairWithTicket(TICKET)).rejects.toThrow(
          "connection refused",
        );
        const state = useConnectStore.getState();
        expect(state.connectionStatus).toBe("error");
        expect(state.connectionError).toBe("connection refused");
      } finally {
        FakeWorkerClient.prototype.connect = originalConnect;
      }
    });

    it("closes the socket if pairClaim fails after connect() already succeeded", async () => {
      const original = FakeWorkerClient.prototype.pairClaim;
      FakeWorkerClient.prototype.pairClaim = async function () {
        throw new Error("auth.pairing_expired");
      };
      try {
        await expect(useConnectStore.getState().pairWithTicket(TICKET)).rejects.toThrow(
          "auth.pairing_expired",
        );
        // The socket opened successfully before the later step failed — it
        // must still be closed, not leaked as an unreachable open connection.
        expect(lastClient().connectCalls).toBe(1);
        expect(lastClient().closed).toBe(true);
      } finally {
        FakeWorkerClient.prototype.pairClaim = original;
      }
    });

    it("rejects and closes the socket if the worker's hello reports a different node_id than the ticket claims", async () => {
      FakeWorkerClient.nextPeerNodeId = "some-other-worker";

      await expect(useConnectStore.getState().pairWithTicket(TICKET)).rejects.toThrow(
        /different node/,
      );

      const client = lastClient();
      expect(client.pairClaimArgs).toEqual([]); // never got to pairClaim
      expect(client.closed).toBe(true);
      const state = useConnectStore.getState();
      expect(state.connectionStatus).toBe("error");
      expect(state.pairedWorkers).toEqual([]);
    });
  });

  describe("pairWithTicket — one-line pairing code (PR6a §a.2)", () => {
    const CODE_NODE_ID = fakeBytes(32);
    const CODE_SECRET = fakeBytes(16, 101);

    it("decodes and pairs over ws, including its relay as the iroh section", async () => {
      FakeWorkerClient.nextPeerNodeId = base64UrlEncode(CODE_NODE_ID);
      const code = await buildPairCode({
        nodeId: CODE_NODE_ID,
        secret: CODE_SECRET,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        addrs: [{ ip: [192, 168, 1, 42], port: 9631 }],
        relay: { index: 3 }, // RELAY_TABLE[2] ("use1-1")
      });

      await useConnectStore.getState().pairWithTicket(code);

      const pairingClient = FakeWorkerClient.instances[0];
      expect(pairingClient.opts.url).toBe("ws://192.168.1.42:9631");
      expect(pairingClient.pairClaimArgs).toEqual([base64UrlEncode(CODE_SECRET)]);

      const state = useConnectStore.getState();
      expect(state.connectionStatus).toBe("connected");
      expect(state.pairedWorkers[0].nodeId).toBe(base64UrlEncode(CODE_NODE_ID));
      expect(state.pairedWorkers[0].iroh?.relayUrl).toBe("https://use1-1.relay.n0.iroh.link./");
    });

    it("rejects an expired code before dialing the worker", async () => {
      const code = await buildPairCode({
        nodeId: CODE_NODE_ID,
        secret: CODE_SECRET,
        expiresAt: 1700000000, // long past
        addrs: [{ ip: [192, 168, 1, 42], port: 9631 }],
      });

      await expect(useConnectStore.getState().pairWithTicket(code)).rejects.toThrow(
        /This pairing code expired at .*run `sleap-rtc pair` again/,
      );
      // Never got as far as opening a connection.
      expect(FakeWorkerClient.instances).toHaveLength(0);
      expect(useConnectStore.getState().connectionStatus).toBe("disconnected");
    });

    it("rejects a mistyped code (bad checksum) with a clear message", async () => {
      const code = await buildPairCode({
        nodeId: CODE_NODE_ID,
        secret: CODE_SECRET,
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        addrs: [{ ip: [192, 168, 1, 42], port: 9631 }],
      });
      const mistyped = mistypeCode(code);

      await expect(useConnectStore.getState().pairWithTicket(mistyped)).rejects.toThrow(
        /incomplete or mistyped/,
      );
      expect(FakeWorkerClient.instances).toHaveLength(0);
    });
  });

  describe("connectToWorker", () => {
    it("throws for an unpaired node_id", async () => {
      await expect(useConnectStore.getState().connectToWorker("unknown")).rejects.toThrow(
        /pair with it first/,
      );
    });

    it("throws if the paired worker has no known address", async () => {
      useConnectStore.setState({ pairedWorkers: [{ ...PAIRED_WORKER, addrs: [] }] });
      await expect(
        useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId),
      ).rejects.toThrow(/No known address/);
    });

    it("reconnects via authProve (not pairClaim) and marks connected", async () => {
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER] });

      await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);

      const client = lastClient();
      expect(client.connectCalls).toBe(1);
      expect(client.authProveCalls).toBe(1);
      expect(client.pairClaimArgs).toEqual([]);
      expect(useConnectStore.getState().connectionStatus).toBe("connected");
    });

    it("closes any previous client before dialing the new one", async () => {
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER] });
      await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);
      const first = lastClient();

      await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);

      expect(first.closed).toBe(true);
    });

    it("sets connectionStatus to 'error' if authProve is rejected", async () => {
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER] });
      const original = FakeWorkerClient.prototype.authProve;
      FakeWorkerClient.prototype.authProve = async function () {
        throw new Error("auth.untrusted");
      };
      try {
        await expect(
          useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId),
        ).rejects.toThrow("auth.untrusted");
        expect(useConnectStore.getState().connectionStatus).toBe("error");
      } finally {
        FakeWorkerClient.prototype.authProve = original;
      }
    });

    it("closes the socket if authProve fails after connect() already succeeded", async () => {
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER] });
      const original = FakeWorkerClient.prototype.authProve;
      FakeWorkerClient.prototype.authProve = async function () {
        throw new Error("auth.untrusted");
      };
      try {
        await expect(
          useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId),
        ).rejects.toThrow("auth.untrusted");
        expect(lastClient().connectCalls).toBe(1);
        expect(lastClient().closed).toBe(true);
      } finally {
        FakeWorkerClient.prototype.authProve = original;
      }
    });

    it("rejects and closes the socket if the address now answers as a different node_id", async () => {
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER] });
      FakeWorkerClient.nextPeerNodeId = "some-other-worker";

      await expect(
        useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId),
      ).rejects.toThrow(/different node/);

      const client = lastClient();
      expect(client.authProveCalls).toBe(0); // never got to authProve
      expect(client.closed).toBe(true);
      expect(useConnectStore.getState().connectionStatus).toBe("error");
    });

    it("imports saved path mappings once, for a worker that's never had pathRules set", async () => {
      nextSavedMappings = [{ local: "/Users/alice/data", worker: "/mnt/data" }];
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER] });

      await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);

      const worker = useConnectStore
        .getState()
        .pairedWorkers.find((w) => w.nodeId === PAIRED_WORKER.nodeId);
      expect(worker?.pathRules).toEqual(nextSavedMappings);
    });

    it("never re-imports once pathRules is defined, even as an empty array", async () => {
      nextSavedMappings = [{ local: "/Users/alice/data", worker: "/mnt/data" }];
      useConnectStore.setState({ pairedWorkers: [{ ...PAIRED_WORKER, pathRules: [] }] });

      await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);

      const worker = useConnectStore
        .getState()
        .pairedWorkers.find((w) => w.nodeId === PAIRED_WORKER.nodeId);
      expect(worker?.pathRules).toEqual([]); // untouched, not re-imported
    });

    it("imports only once across repeated reconnects to the same worker", async () => {
      nextSavedMappings = [{ local: "/a", worker: "/mnt/a" }];
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER] });

      await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);
      nextSavedMappings = [{ local: "/b", worker: "/mnt/b" }]; // would differ if re-imported
      await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);

      const worker = useConnectStore
        .getState()
        .pairedWorkers.find((w) => w.nodeId === PAIRED_WORKER.nodeId);
      expect(worker?.pathRules).toEqual([{ local: "/a", worker: "/mnt/a" }]);
    });
  });

  describe("path rules", () => {
    it("addPathRule adds a rule for a worker with none yet", () => {
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER] });

      useConnectStore.getState().addPathRule(PAIRED_WORKER.nodeId, { local: "/a", worker: "/mnt/a" });

      expect(pathRulesFor(PAIRED_WORKER.nodeId)).toEqual([{ local: "/a", worker: "/mnt/a" }]);
    });

    it("addPathRule replaces any existing rule with the same local path", () => {
      useConnectStore.setState({
        pairedWorkers: [{ ...PAIRED_WORKER, pathRules: [{ local: "/a", worker: "/mnt/old" }] }],
      });

      useConnectStore.getState().addPathRule(PAIRED_WORKER.nodeId, { local: "/a", worker: "/mnt/new" });

      expect(pathRulesFor(PAIRED_WORKER.nodeId)).toEqual([{ local: "/a", worker: "/mnt/new" }]);
    });

    it("addPathRule leaves other workers' rules untouched", () => {
      const other: PairedWorker = { ...PAIRED_WORKER, nodeId: "other" };
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER, other] });

      useConnectStore.getState().addPathRule(PAIRED_WORKER.nodeId, { local: "/a", worker: "/mnt/a" });

      expect(pathRulesFor("other")).toEqual([]);
    });

    it("clearPathRule removes only the rule matching that local path", () => {
      useConnectStore.setState({
        pairedWorkers: [
          {
            ...PAIRED_WORKER,
            pathRules: [
              { local: "/a", worker: "/mnt/a" },
              { local: "/b", worker: "/mnt/b" },
            ],
          },
        ],
      });

      useConnectStore.getState().clearPathRule(PAIRED_WORKER.nodeId, "/a");

      expect(pathRulesFor(PAIRED_WORKER.nodeId)).toEqual([{ local: "/b", worker: "/mnt/b" }]);
    });

    it("pathRulesFor returns [] for an unknown worker or one with no rules set", () => {
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER] });
      expect(pathRulesFor(PAIRED_WORKER.nodeId)).toEqual([]);
      expect(pathRulesFor("unknown")).toEqual([]);
      expect(pathRulesFor(null)).toEqual([]);
    });

    it("persists pathRules via the existing pairedWorkers partialize", () => {
      const worker: PairedWorker = { ...PAIRED_WORKER, pathRules: [{ local: "/a", worker: "/mnt/a" }] };
      useConnectStore.setState({ pairedWorkers: [worker] });

      const partialize = useConnectStore.persist.getOptions().partialize;
      expect(partialize).toBeDefined();
      const persisted = partialize!(useConnectStore.getState()) as { pairedWorkers: PairedWorker[] };

      expect(persisted.pairedWorkers).toEqual([worker]);
    });
  });

  describe("statWorkerPath", () => {
    beforeEach(async () => {
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER] });
      await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);
    });

    it("throws if not connected", async () => {
      useConnectStore.getState().disconnect();
      await expect(useConnectStore.getState().statWorkerPath("/mnt/a")).rejects.toThrow(
        /Not connected/,
      );
    });

    it("reports an existing file", async () => {
      const client = lastClient();
      client.fsStatResults["/mnt/a.slp"] = { type: "file" };

      await expect(useConnectStore.getState().statWorkerPath("/mnt/a.slp")).resolves.toEqual({
        exists: true,
        type: "file",
      });
    });

    it("reports an existing directory", async () => {
      const client = lastClient();
      client.fsStatResults["/mnt/sub"] = { type: "directory" };

      await expect(useConnectStore.getState().statWorkerPath("/mnt/sub")).resolves.toEqual({
        exists: true,
        type: "directory",
      });
    });

    it("maps FS_NOT_FOUND to {exists: false}", async () => {
      await expect(useConnectStore.getState().statWorkerPath("/mnt/missing")).resolves.toEqual({
        exists: false,
      });
    });

    it("maps FS_FORBIDDEN to {exists: false}", async () => {
      const client = lastClient();
      client.fsStatResults["/mnt/secret"] = new WorkerProtocolError(FS_FORBIDDEN, "forbidden");

      await expect(useConnectStore.getState().statWorkerPath("/mnt/secret")).resolves.toEqual({
        exists: false,
      });
    });

    it("rethrows other errors", async () => {
      const client = lastClient();
      client.fsStatResults["/mnt/broken"] = new Error("ECONNRESET");

      await expect(useConnectStore.getState().statWorkerPath("/mnt/broken")).rejects.toThrow(
        "ECONNRESET",
      );
    });
  });

  describe("selectWorker", () => {
    it("null disconnects", async () => {
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER] });
      await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);
      const client = lastClient();

      await useConnectStore.getState().selectWorker(null);

      expect(client.closed).toBe(true);
      expect(useConnectStore.getState().connectionStatus).toBe("disconnected");
    });

    it("a node_id connects to that worker", async () => {
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER] });
      await useConnectStore.getState().selectWorker(PAIRED_WORKER.nodeId);
      expect(useConnectStore.getState().connectionStatus).toBe("connected");
    });
  });

  describe("disconnect", () => {
    it("closes the client and resets runtime state but keeps pairing/selection", async () => {
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER] });
      await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);
      const client = lastClient();

      useConnectStore.getState().disconnect();

      expect(client.closed).toBe(true);
      const state = useConnectStore.getState();
      expect(state.connectionStatus).toBe("disconnected");
      expect(state.workerMounts).toEqual([]);
      // pathRules: [] now stamped by connectToWorker's one-time legacy-mappings import.
      expect(state.pairedWorkers).toEqual([{ ...PAIRED_WORKER, pathRules: [] }]);
      expect(state.selectedWorkerId).toBe(PAIRED_WORKER.nodeId);
    });

    it("keeps the managed connection running in the background when the worker has an active tracked job", async () => {
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER] });
      await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);
      const client = lastClient();
      useConnectStore.setState({
        trackedJobs: [makeTracked({ workerId: PAIRED_WORKER.nodeId })],
      });

      useConnectStore.getState().disconnect();

      expect(client.closed).toBe(false); // kept alive, not torn down
      const state = useConnectStore.getState();
      expect(state.connectionStatus).toBe("disconnected"); // selected-UI fields still clear
      expect(state._client).toBeNull();
      expect(state.activeTransport).toBeNull();

      // Prove it's genuinely still managed, not just not-yet-closed: a drop
      // still triggers a background reconnect even with nothing selected.
      const instancesBefore = FakeWorkerClient.instances.length;
      client.simulateDrop();
      await flushAsync();
      expect(FakeWorkerClient.instances.length).toBeGreaterThan(instancesBefore);
    });
  });

  describe("forgetWorker", () => {
    it("removes the worker from the paired list", async () => {
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER] });
      await useConnectStore.getState().forgetWorker(PAIRED_WORKER.nodeId);
      expect(useConnectStore.getState().pairedWorkers).toEqual([]);
    });

    it("disconnects and clears selection if forgetting the currently-selected worker", async () => {
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER] });
      await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);
      const client = lastClient();

      await useConnectStore.getState().forgetWorker(PAIRED_WORKER.nodeId);

      expect(client.closed).toBe(true);
      const state = useConnectStore.getState();
      expect(state.selectedWorkerId).toBeNull();
      expect(state.connectionStatus).toBe("disconnected");
    });

    it("leaves an unrelated connection untouched", async () => {
      const other: PairedWorker = { ...PAIRED_WORKER, nodeId: "other", addrs: ["ws://other:1"] };
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER, other] });
      await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);

      await useConnectStore.getState().forgetWorker("other");

      const state = useConnectStore.getState();
      expect(state.selectedWorkerId).toBe(PAIRED_WORKER.nodeId);
      expect(state.connectionStatus).toBe("connected");
      expect(state.pairedWorkers.map((w) => w.nodeId)).toEqual([PAIRED_WORKER.nodeId]);
    });
  });

  describe("browseRemoteDir", () => {
    beforeEach(async () => {
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER] });
      await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);
    });

    it("throws if not connected", async () => {
      useConnectStore.getState().disconnect();
      await expect(useConnectStore.getState().browseRemoteDir("/mnt")).rejects.toThrow(
        /Not connected/,
      );
    });

    it("maps a single page of entries and stops when hasMore is false", async () => {
      const client = lastClient();
      client.fsListResults = [
        {
          entries: [
            { name: "a.slp", type: "file", size: 10 },
            { name: "sub", type: "directory" },
          ],
          totalCount: 2,
          hasMore: false,
        },
      ];

      const entries = await useConnectStore.getState().browseRemoteDir("/mnt");

      expect(entries).toEqual([
        { name: "a.slp", isDir: false, size: 10 },
        { name: "sub", isDir: true, size: undefined },
      ]);
      expect(client.fsListCalls).toEqual([["/mnt", 0]]);
    });

    it("auto-paginates until hasMore is false", async () => {
      const client = lastClient();
      client.fsListResults = [
        { entries: [{ name: "a.slp", type: "file" }], totalCount: 3, hasMore: true },
        { entries: [{ name: "b.slp", type: "file" }], totalCount: 3, hasMore: false },
      ];

      const entries = await useConnectStore.getState().browseRemoteDir("/mnt");

      expect(entries.map((e) => e.name)).toEqual(["a.slp", "b.slp"]);
      expect(client.fsListCalls).toEqual([
        ["/mnt", 0],
        ["/mnt", 1],
      ]);
    });
  });

  describe("unpaired by the worker / Forget", () => {
    it("Forget over a live connection unpairs on the worker, then closes it", async () => {
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER] });
      await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);
      const client = lastClient();

      await useConnectStore.getState().forgetWorker(PAIRED_WORKER.nodeId);

      expect(client.clientsLeaveCalls).toBe(1);
      expect(client.closed).toBe(true);
      expect(useConnectStore.getState().pairedWorkers).toEqual([]);
    });

    it("Forget while not connected dials once to unpair, and closes that client", async () => {
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER] });
      await useConnectStore.getState().forgetWorker(PAIRED_WORKER.nodeId);
      const client = lastClient();
      expect(client.clientsLeaveCalls).toBe(1);
      expect(client.closed).toBe(true);
      expect(useConnectStore.getState().pairedWorkers).toEqual([]);
    });

    it("Forget of an unreachable worker still forgets it locally", async () => {
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER] });
      FakeWorkerClient.nextConnectShouldThrow = new Error("unreachable");
      await useConnectStore.getState().forgetWorker(PAIRED_WORKER.nodeId);
      expect(useConnectStore.getState().pairedWorkers).toEqual([]);
    });

    it("a connect refused as untrusted marks the worker unpaired, and automatic dials stop", async () => {
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER] });
      FakeWorkerClient.nextAuthProveShouldThrow = new WorkerProtocolError(AUTH_UNTRUSTED, "not paired");

      await expect(useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId)).rejects.toThrow();

      const state = useConnectStore.getState();
      expect(state.pairedWorkers[0].unpairedAt).toBeTruthy();
      expect(state.connectionError).toContain("unpaired by the worker");
      const dials = FakeWorkerClient.instances.length;
      await expect(state.clientFor(PAIRED_WORKER.nodeId)).rejects.toThrow("unpaired by the worker");
      expect(FakeWorkerClient.instances.length).toBe(dials);
    });

    it("clientFor during an explicit connect waits for that dial instead of failing", async () => {
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER] });
      const connecting = useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);
      const client = await useConnectStore.getState().clientFor(PAIRED_WORKER.nodeId);
      await connecting;
      expect(client).toBe(lastClient() as unknown as WorkerClient);
      expect(FakeWorkerClient.instances.length).toBe(1);
    });

    it("re-pairing an unpaired worker keeps its name and path rules", async () => {
      useConnectStore.setState({
        pairedWorkers: [
          {
            ...PAIRED_WORKER,
            label: "GPU box",
            pathRules: [{ local: "/a", worker: "/mnt/a" }],
            unpairedAt: "2026-10-23T00:00:00Z",
          },
        ],
        connections: { [PAIRED_WORKER.nodeId]: { status: "unpaired", route: "ws" } },
      });

      await useConnectStore.getState().pairWithTicket(TICKET);

      const [w] = useConnectStore.getState().pairedWorkers;
      expect(w.label).toBe("GPU box");
      expect(w.pathRules).toEqual([{ local: "/a", worker: "/mnt/a" }]);
      expect(w.unpairedAt).toBeUndefined();
      expect(useConnectStore.getState().connections[PAIRED_WORKER.nodeId]?.status).not.toBe("unpaired");
    });
  });

  describe("device name", () => {
    const OTHER_WORKER: PairedWorker = {
      nodeId: "other-worker-id",
      label: "Other",
      addrs: ["ws://10.0.0.6:9631"],
      pairedAt: "2026-09-27T00:00:00Z",
    };

    beforeEach(() => {
      useConnectStore.setState({ pairedWorkers: [OTHER_WORKER] });
      FakeWorkerClient.nextPeerNodeId = OTHER_WORKER.nodeId;
    });

    it("sends the chosen name in the hello agent", async () => {
      useConnectStore.setState({ deviceName: "Bench PC" });
      await useConnectStore.getState().clientFor(OTHER_WORKER.nodeId);
      expect(lastClient().opts.agent?.device_name).toBe("Bench PC");
    });

    it("sends a default name when none is chosen", async () => {
      await useConnectStore.getState().clientFor(OTHER_WORKER.nodeId);
      expect(lastClient().opts.agent?.device_name).toBeTruthy();
    });

    it("setDeviceName saves the trimmed name and pushes it to connected workers", async () => {
      await useConnectStore.getState().clientFor(OTHER_WORKER.nodeId);
      await useConnectStore.getState().setDeviceName("  Lab   Mac ");
      expect(useConnectStore.getState().deviceName).toBe("Lab Mac");
      expect(lastClient().clientsRenameCalls).toEqual(["Lab Mac"]);
    });

    it("a rename in another tab updates this tab and pushes it to this tab's workers", async () => {
      useConnectStore.setState({ deviceName: "Old" });
      await useConnectStore.getState().clientFor(OTHER_WORKER.nodeId);
      syncDeviceNameFromStorage(JSON.stringify({ state: { deviceName: "New" }, version: 2 }));
      expect(useConnectStore.getState().deviceName).toBe("New");
      await Promise.resolve();
      expect(lastClient().clientsRenameCalls).toEqual(["New"]);
      // The next hello carries it too.
      __resetManagedConnections();
      await useConnectStore.getState().clientFor(OTHER_WORKER.nodeId);
      expect(lastClient().opts.agent?.device_name).toBe("New");
    });

    it("ignores storage writes that don't change the name, or aren't parseable", async () => {
      useConnectStore.setState({ deviceName: "Same" });
      await useConnectStore.getState().clientFor(OTHER_WORKER.nodeId);
      syncDeviceNameFromStorage(JSON.stringify({ state: { deviceName: "Same" } }));
      syncDeviceNameFromStorage("not json");
      syncDeviceNameFromStorage(null);
      await Promise.resolve();
      expect(useConnectStore.getState().deviceName).toBe("Same");
      expect(lastClient().clientsRenameCalls).toEqual([]);
    });

    it("setDeviceName ignores a blank name", async () => {
      useConnectStore.setState({ deviceName: "Keep" });
      await useConnectStore.getState().setDeviceName("   ");
      expect(useConnectStore.getState().deviceName).toBe("Keep");
    });
  });

  describe("browseRemoteDirOn / mountsFor", () => {
    const OTHER_WORKER: PairedWorker = {
      nodeId: "other-worker-id",
      label: "Other worker",
      addrs: ["ws://10.0.0.5:9631"],
      pairedAt: "2026-09-27T00:00:00Z",
    };

    beforeEach(() => {
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER, OTHER_WORKER] });
    });

    it("dials the given worker on demand (no prior connect/select needed) and paginates its fs.list", async () => {
      FakeWorkerClient.nextPeerNodeId = OTHER_WORKER.nodeId;
      // Establish the dial first so `fsListResults` can be set before
      // `browseRemoteDirOn` issues its first call.
      await useConnectStore.getState().clientFor(OTHER_WORKER.nodeId);
      const client = lastClient();
      client.fsListResults = [
        { entries: [{ name: "a.slp", type: "file" }], totalCount: 2, hasMore: true },
        { entries: [{ name: "b.slp", type: "file" }], totalCount: 2, hasMore: false },
      ];

      const entries = await useConnectStore
        .getState()
        .browseRemoteDirOn(OTHER_WORKER.nodeId, "/mnt");

      expect(entries.map((e) => e.name)).toEqual(["a.slp", "b.slp"]);
      expect(client.fsListCalls).toEqual([
        ["/mnt", 0],
        ["/mnt", 1],
      ]);
    });

    it("starts pagination from the given offset", async () => {
      FakeWorkerClient.nextPeerNodeId = OTHER_WORKER.nodeId;
      await useConnectStore.getState().clientFor(OTHER_WORKER.nodeId);
      const client = lastClient();
      client.fsListResults = [{ entries: [{ name: "c.slp", type: "file" }], totalCount: 3, hasMore: false }];

      const entries = await useConnectStore
        .getState()
        .browseRemoteDirOn(OTHER_WORKER.nodeId, "/mnt", 2);

      expect(entries.map((e) => e.name)).toEqual(["c.slp"]);
      expect(client.fsListCalls).toEqual([["/mnt", 2]]);
    });

    it("never touches the selected worker's connection for a different worker", async () => {
      await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);
      const selectedClient = lastClient();

      FakeWorkerClient.nextPeerNodeId = OTHER_WORKER.nodeId;
      await useConnectStore.getState().browseRemoteDirOn(OTHER_WORKER.nodeId, "/mnt");

      expect(selectedClient.fsListCalls).toEqual([]);
      expect(useConnectStore.getState()._client).toBe(selectedClient as unknown as WorkerClient);
    });

    it("mountsFor fetches fs.mounts for any paired worker via clientFor", async () => {
      FakeWorkerClient.nextMounts = [{ path: "/data", label: "Data" }];
      FakeWorkerClient.nextPeerNodeId = OTHER_WORKER.nodeId;

      const mounts = await useConnectStore.getState().mountsFor(OTHER_WORKER.nodeId);

      expect(mounts).toEqual([{ path: "/data", label: "Data" }]);
    });
  });

  describe("submitJob", () => {
    beforeEach(async () => {
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER] });
      await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);
    });

    it("throws if not connected to a worker", async () => {
      useConnectStore.getState().disconnect();
      const spec: JobSpec = { type: "track", data_path: "/x.slp", model_paths: [] };
      await expect(useConnectStore.getState().submitJob(spec, () => {})).rejects.toThrow(
        /Not connected/,
      );
    });

    it("submits a single-model spec, forwards job.log, and resolves on completion", async () => {
      const lines: string[] = [];
      const spec: JobSpec = { type: "track", data_path: "/x.slp", model_paths: ["m1"] };

      const promise = useConnectStore.getState().submitJob(spec, (line) => lines.push(line));
      await flushAsync();
      const client = lastClient();
      client.emit("job_1", "job.log", { line: "epoch 1" });
      client.emit("job_1", "job.status", { state: "completed" });

      const result = await promise;

      expect(result).toEqual({ jobId: "job_1", success: true, runId: expect.any(String) });
      expect(lines).toEqual(["epoch 1"]);
      // Terminal: the tracked entry is kept (it's the Connect window's job
      // history) with its state updated, not cleared.
      expect(useConnectStore.getState().trackedJobs).toEqual([
        expect.objectContaining({ jobId: "job_1", state: "completed", seen: true }),
      ]);
    });

    it("resolves with success:false and the worker's detail on job.status: failed", async () => {
      const spec: JobSpec = { type: "track", data_path: "/x.slp", model_paths: ["m1"] };
      const promise = useConnectStore.getState().submitJob(spec, () => {});
      await flushAsync();
      lastClient().emit("job_1", "job.status", { state: "failed", detail: "exit code 1" });

      const result = await promise;
      expect(result).toEqual({
        jobId: "job_1",
        success: false,
        error: "exit code 1",
        runId: expect.any(String),
      });
      expect(useConnectStore.getState().trackedJobs).toEqual([
        expect.objectContaining({ jobId: "job_1", state: "failed", seen: true, error: "exit code 1" }),
      ]);
    });

    it("keeps a completed job's tracked entry free of a stale error field", async () => {
      const spec: JobSpec = { type: "track", data_path: "/x.slp", model_paths: ["m1"] };
      const promise = useConnectStore.getState().submitJob(spec, () => {});
      await flushAsync();
      lastClient().emit("job_1", "job.status", { state: "completed" });
      await promise;
      expect(
        useConnectStore.getState().trackedJobs.find((j) => j.jobId === "job_1")?.error,
      ).toBeUndefined();
    });

    it("captures job.result's blobs (which arrive before job.status: completed)", async () => {
      const spec: JobSpec = { type: "track", data_path: "/x.slp", model_paths: ["m1"] };
      const promise = useConnectStore.getState().submitJob(spec, () => {});
      await flushAsync();
      const client = lastClient();
      // Mirrors the real worker's order (job.result before the terminal
      // job.status) — see talmolab/sleap-connect's job_methods.py.
      client.emit("job_1", "job.result", {
        blobs: { predictions: { sha256: "abc123", size: 4096 } },
      });
      client.emit("job_1", "job.status", { state: "completed" });

      const result = await promise;
      expect(result).toEqual({
        jobId: "job_1",
        success: true,
        resultBlobs: { predictions: { sha256: "abc123", size: 4096 } },
        runId: expect.any(String),
      });
    });

    it("leaves resultBlobs undefined when job.result carries no blobs", async () => {
      const spec: JobSpec = { type: "track", data_path: "/x.slp", model_paths: ["m1"] };
      const promise = useConnectStore.getState().submitJob(spec, () => {});
      await flushAsync();
      const client = lastClient();
      client.emit("job_1", "job.result", { blobs: {} });
      client.emit("job_1", "job.status", { state: "completed" });

      const result = await promise;
      expect(result.resultBlobs).toBeUndefined();
    });

    // Hydra-quoted: the worker interpolates run_name unquoted into
    // `trainer_config.run_name=<value>`, and the `=` in `n=12` would otherwise
    // be a sleap-nn override parse error.
    it("sends each split job's YAML run name as a Hydra-quoted run_name, so the worker doesn't rename it to the model type", async () => {
      const spec: JobSpec = {
        type: "train",
        config_contents: [
          "trainer_config:\n  run_name: 261020_120000.centroid.n=12\n",
          "trainer_config:\n  run_name: 261020_120000.centered_instance.n=12\n",
        ],
        model_types: ["centroid", "centered_instance"],
        labels_path: "/labels.slp",
      };

      const promise = useConnectStore.getState().submitJob(spec, () => {});
      for (let i = 0; i < 2; i++) {
        await flushAsync();
        lastClient().emit("job_1", "job.status", { state: "completed" });
      }
      await promise;

      const [first, second] = lastClient().jobsSubmitCalls;
      expect(first.run_name).toBe("'261020_120000.centroid.n=12'");
      expect(second.run_name).toBe("'261020_120000.centered_instance.n=12'");
    });

    it("leaves run_name unset when the YAML has none, and never overrides an explicit one", async () => {
      const submit = async (spec: JobSpec) => {
        const promise = useConnectStore.getState().submitJob(spec, () => {});
        await flushAsync();
        lastClient().emit("job_1", "job.status", { state: "completed" });
        await promise;
        return lastClient().jobsSubmitCalls.at(-1)!;
      };

      const noName = await submit({
        type: "train",
        config_contents: ["trainer_config: {}\n"],
        model_types: ["single_instance"],
        labels_path: "/l.slp",
      });
      expect("run_name" in noName).toBe(false);

      const explicit = await submit({
        type: "train",
        config_contents: ["trainer_config:\n  run_name: from_yaml\n"],
        model_types: ["single_instance"],
        labels_path: "/l.slp",
        run_name: "explicit",
      });
      expect(explicit.run_name).toBe("explicit");
    });

    it("splits a multi-model TrainJobSpec into sequential single-model jobs", async () => {
      const modelCompletions: unknown[] = [];
      const spec: JobSpec = {
        type: "train",
        config_contents: ["centroid yaml", "centered_instance yaml"],
        model_types: ["centroid", "centered_instance"],
        labels_path: "/labels.slp",
      };

      const promise = useConnectStore
        .getState()
        .submitJob(spec, () => {}, { onModelComplete: (r) => modelCompletions.push(r) });

      for (let i = 0; i < 2; i++) {
        await flushAsync();
        lastClient().emit("job_1", "job.status", { state: "completed" });
      }
      const result = await promise;

      const client = lastClient();
      expect(client.jobsSubmitCalls).toHaveLength(2);
      expect(client.jobsSubmitCalls[0]).toMatchObject({
        config_contents: ["centroid yaml"],
        model_types: ["centroid"],
      });
      expect(client.jobsSubmitCalls[1]).toMatchObject({
        config_contents: ["centered_instance yaml"],
        model_types: ["centered_instance"],
      });
      // Only the intermediate (non-final) model fires onModelComplete.
      expect(modelCompletions).toEqual([
        { jobId: "job_1", success: true, runId: expect.any(String) },
      ]);
      expect(result).toEqual({ jobId: "job_1", success: true, runId: expect.any(String) });
    });

    it("tags a split multi-model run: both jobs share run.id, indices 0/1, count 2", async () => {
      const spec: JobSpec = {
        type: "train",
        config_contents: ["centroid yaml", "centered_instance yaml"],
        model_types: ["centroid", "centered_instance"],
        labels_path: "/labels.slp",
      };

      const promise = useConnectStore.getState().submitJob(spec, () => {});
      for (let i = 0; i < 2; i++) {
        await flushAsync();
        lastClient().emit("job_1", "job.status", { state: "completed" });
      }
      await promise;

      const client = lastClient();
      const [first, second] = client.jobsSubmitCalls;
      expect(first.run).toEqual(expect.objectContaining({ index: 0, count: 2 }));
      expect(second.run).toEqual(expect.objectContaining({ index: 1, count: 2 }));
      expect((first.run as { id: string }).id).toBe((second.run as { id: string }).id);
    });

    it("tags a single-job spec with run {index: 0, count: 1}", async () => {
      const spec: JobSpec = { type: "track", data_path: "/x.slp", model_paths: ["m1"] };
      const promise = useConnectStore.getState().submitJob(spec, () => {});
      await flushAsync();
      const client = lastClient();
      client.emit("job_1", "job.status", { state: "completed" });
      await promise;

      expect(client.jobsSubmitCalls[0].run).toEqual(
        expect.objectContaining({ index: 0, count: 1 }),
      );
    });

    it("`options.run` links to an existing run id and tags it with stage, instead of minting a fresh one", async () => {
      const spec: JobSpec = { type: "track", data_path: "/x.slp", model_paths: ["m1"] };
      const promise = useConnectStore
        .getState()
        .submitJob(spec, () => {}, { run: { id: "train-run-id", stage: "inference" } });
      await flushAsync();
      const client = lastClient();
      client.emit("job_1", "job.status", { state: "completed" });
      const result = await promise;

      expect(client.jobsSubmitCalls[0].run).toEqual({
        id: "train-run-id",
        index: 0,
        count: 1,
        stage: "inference",
      });
      // The caller can read the (possibly overridden) run id straight off
      // the result — `trainingStore`'s own post-training inference needs
      // this to link ITS follow-up track job to the same run.
      expect(result.runId).toBe("train-run-id");
    });

    it("every split job of a multi-model run carries the result's runId, generated once per call", async () => {
      const spec: JobSpec = {
        type: "train",
        config_contents: ["centroid yaml", "centered_instance yaml"],
        model_types: ["centroid", "centered_instance"],
        labels_path: "/labels.slp",
      };
      const promise = useConnectStore.getState().submitJob(spec, () => {});
      for (let i = 0; i < 2; i++) {
        await flushAsync();
        lastClient().emit("job_1", "job.status", { state: "completed" });
      }
      const result = await promise;
      expect(result.runId).toEqual(expect.any(String));
      expect(result.runId).toBe((lastClient().jobsSubmitCalls[0].run as { id: string }).id);
    });

    it("forwards job.log's progress flag (absent = false)", async () => {
      const lines: Array<[string, boolean | undefined]> = [];
      const spec: JobSpec = { type: "track", data_path: "/x.slp", model_paths: ["m1"] };
      const promise = useConnectStore.getState().submitJob(spec, (line, p) => lines.push([line, p]));
      await flushAsync();
      const client = lastClient();
      client.emit("job_1", "job.log", { line: "Epoch 0: 40%|####", progress: true });
      client.emit("job_1", "job.log", { line: "done" });
      client.emit("job_1", "job.status", { state: "completed" });
      await promise;
      expect(lines).toEqual([
        ["Epoch 0: 40%|####", true],
        ["done", false],
      ]);
    });

    it("captures a train job's model_dir and labels_path from job.result", async () => {
      const spec: JobSpec = {
        type: "train",
        config_contents: ["yaml"],
        model_types: ["single_instance"],
        labels_path: "/labels.slp",
      };
      const promise = useConnectStore.getState().submitJob(spec, () => {});
      await flushAsync();
      const client = lastClient();
      client.emit("job_1", "job.result", { blobs: {}, model_dir: "/w/models/run1", labels_path: "/w/labels.slp" });
      client.emit("job_1", "job.status", { state: "completed" });
      expect(await promise).toEqual({
        jobId: "job_1",
        success: true,
        modelDir: "/w/models/run1",
        labelsPath: "/w/labels.slp",
        runId: expect.any(String),
      });
    });

    it("tags parsed telemetry with each split job's index; ignores malformed events", async () => {
      const telemetry: Array<[string, number]> = [];
      const spec: JobSpec = {
        type: "train",
        config_contents: ["centroid yaml", "centered_instance yaml"],
        model_types: ["centroid", "centered_instance"],
        labels_path: "/labels.slp",
      };
      const promise = useConnectStore.getState().submitJob(spec, () => {}, {
        onTelemetry: (t, jobIndex) => telemetry.push([t.kind, jobIndex]),
      });

      await flushAsync();
      lastClient().emit("job_1", "job.epoch", { epoch: 0, train_loss: 1, val_loss: null });
      lastClient().emit("job_1", "job.epoch", { train_loss: 1 }); // no epoch: dropped
      lastClient().emit("job_1", "job.status", { state: "completed" });
      await flushAsync();
      lastClient().emit("job_1", "job.curve", { points: [{ x: 0, y: 1 }] });
      lastClient().emit("job_1", "job.metric", { epoch: 1, total_epochs: 10, wandb_url: null });
      lastClient().emit("job_1", "job.status", { state: "completed" });
      await promise;

      expect(telemetry).toEqual([
        ["epoch", 0],
        ["curve", 1],
        ["metric", 1],
      ]);
    });

    it("aborts the multi-model sequence on the first failure", async () => {
      const spec: JobSpec = {
        type: "train",
        config_contents: ["centroid yaml", "centered_instance yaml"],
        model_types: ["centroid", "centered_instance"],
        labels_path: "/labels.slp",
      };

      const promise = useConnectStore.getState().submitJob(spec, () => {});
      await flushAsync();
      lastClient().emit("job_1", "job.status", { state: "failed", detail: "boom" });

      const result = await promise;
      expect(result).toEqual({
        jobId: "job_1",
        success: false,
        error: "boom",
        runId: expect.any(String),
      });
      expect(lastClient().jobsSubmitCalls).toHaveLength(1);
    });

    it("ignores a duplicate or out-of-order seq (reconnect backlog overlap)", async () => {
      const lines: string[] = [];
      const spec: JobSpec = { type: "track", data_path: "/x.slp", model_paths: ["m1"] };
      const promise = useConnectStore.getState().submitJob(spec, (line) => lines.push(line));
      await flushAsync();
      const client = lastClient();

      client.emit("job_1", "job.log", { line: "epoch 1" }, 5);
      client.emit("job_1", "job.log", { line: "epoch 1 (replayed)" }, 5); // same seq: dropped
      client.emit("job_1", "job.log", { line: "stale" }, 3); // older seq: dropped
      client.emit("job_1", "job.status", { state: "completed" }, 6);

      const result = await promise;
      expect(result).toEqual({ jobId: "job_1", success: true, runId: expect.any(String) });
      expect(lines).toEqual(["epoch 1"]);
      expect(
        useConnectStore.getState().trackedJobs.find((j) => j.jobId === "job_1")?.lastSeq,
      ).toBe(6);
    });

    it("re-subscribes from the last applied seq after a simulated reconnect, and the original promise resolves on the new client's terminal event", async () => {
      const spec: JobSpec = { type: "track", data_path: "/x.slp", model_paths: ["m1"] };
      const promise = useConnectStore.getState().submitJob(spec, () => {});
      await flushAsync();
      const firstClient = lastClient();
      firstClient.emit("job_1", "job.log", { line: "epoch 1" }); // seq 1, persisted immediately

      // Simulate the drop/redial: a brand-new client takes over the subscription.
      const secondClient = new FakeWorkerClient({ url: firstClient.opts.url });
      resubscribeWorker(PAIRED_WORKER.nodeId, secondClient as never);

      expect(secondClient.jobsSubscribeCalls).toEqual([["job_1", 1]]);

      // Explicit seq: a real worker's seq numbering is per-job, continuing
      // across a reconnect — `secondClient`'s own auto-increment counter
      // starts fresh at 1 and would otherwise collide with the seq already
      // applied from `firstClient`.
      secondClient.emit("job_1", "job.status", { state: "completed" }, 2);
      const result = await promise;
      expect(result).toEqual({ jobId: "job_1", success: true, runId: expect.any(String) });
    });
  });

  describe("submitJobsOn", () => {
    // Every test below uses its own unique job-id prefix (never "job_N") and
    // terminates every job it creates before returning: `notifiedJobIds` and
    // `activeSubscriptions` are both module-level state this file's
    // `beforeEach` does NOT reset (see the top `beforeEach`'s own comment) —
    // a reused id would silently eat another test's toast, and a job left
    // "active" forever stays subscribed and gets re-attached by
    // `resubscribeWorker` the next time anything reconnects to this same
    // worker (e.g. the `resumeTrackedJobs` tests below), corrupting an
    // unrelated test's `jobsSubscribeCalls` assertions.
    let restoreJobIds: () => void;

    beforeEach(() => {
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER] });
    });

    afterEach(() => {
      restoreJobIds();
    });

    it("sends each job's YAML run name as run_name (the launcher wizard's worker-file path)", async () => {
      restoreJobIds = withSequentialJobIds("launchRunName");
      const spec: JobSpec = {
        type: "train",
        config_contents: [
          "trainer_config:\n  run_name: 261020_120000.centroid.n=7\n",
          "trainer_config:\n  run_name: 261020_120000.centered_instance.n=7\n",
        ],
        model_types: ["centroid", "centered_instance"],
        labels_path: "/data/labels.slp",
      };

      await useConnectStore.getState().submitJobsOn(PAIRED_WORKER.nodeId, spec, { source: "worker-file" });

      const [first, second] = lastClient().jobsSubmitCalls;
      expect(first.run_name).toBe("'261020_120000.centroid.n=7'");
      expect(second.run_name).toBe("'261020_120000.centered_instance.n=7'");

      lastClient().emit("launchRunName_1", "job.status", { state: "completed" });
      lastClient().emit("launchRunName_2", "job.status", { state: "completed" });
      await flushAsync();
    });

    it("submits every model's job up front, before any of them finishes, sharing one run id", async () => {
      restoreJobIds = withSequentialJobIds("launchA");
      const spec: JobSpec = {
        type: "train",
        config_contents: ["centroid yaml", "centered_instance yaml"],
        model_types: ["centroid", "centered_instance"],
        labels_path: "/data/labels.slp",
      };

      const jobIds = await useConnectStore
        .getState()
        .submitJobsOn(PAIRED_WORKER.nodeId, spec, { source: "worker-file" });

      expect(jobIds).toEqual(["launchA_1", "launchA_2"]);
      const client = lastClient();
      expect(client.jobsSubmitCalls).toHaveLength(2);
      expect(client.jobsSubmitCalls[0]).toMatchObject({
        config_contents: ["centroid yaml"],
        model_types: ["centroid"],
      });
      expect(client.jobsSubmitCalls[1]).toMatchObject({
        config_contents: ["centered_instance yaml"],
        model_types: ["centered_instance"],
      });
      const [first, second] = client.jobsSubmitCalls;
      expect(first.run).toEqual(expect.objectContaining({ index: 0, count: 2 }));
      expect(second.run).toEqual(expect.objectContaining({ index: 1, count: 2 }));
      expect((first.run as { id: string }).id).toBe((second.run as { id: string }).id);

      // Neither job has been told it finished — both still active, and
      // nothing here ever awaited a job.status event the way submitJob does.
      const tracked = useConnectStore.getState().trackedJobs;
      expect(tracked).toHaveLength(2);
      expect(tracked.every((j) => j.state === "active")).toBe(true);
      expect(tracked.every((j) => j.source === "worker-file")).toBe(true);
      expect(tracked.map((j) => j.jobId)).toEqual(["launchA_1", "launchA_2"]);

      client.emit("launchA_1", "job.status", { state: "completed" });
      client.emit("launchA_2", "job.status", { state: "completed" });
      await flushAsync();
    });

    it("tags a single-job spec with run {index: 0, count: 1} and tracks it with the given source", async () => {
      restoreJobIds = withSequentialJobIds("launchB");
      const spec: JobSpec = { type: "track", data_path: "/x.slp", model_paths: ["m1"] };

      const jobIds = await useConnectStore
        .getState()
        .submitJobsOn(PAIRED_WORKER.nodeId, spec, { source: "worker-file" });

      expect(jobIds).toEqual(["launchB_1"]);
      expect(lastClient().jobsSubmitCalls[0]).toMatchObject({
        run: expect.objectContaining({ index: 0, count: 1 }),
      });
      expect(useConnectStore.getState().trackedJobs).toEqual([
        expect.objectContaining({
          jobId: "launchB_1",
          kind: "track",
          label: "Inference",
          source: "worker-file",
          state: "active",
        }),
      ]);

      lastClient().emit("launchB_1", "job.status", { state: "completed" });
      await flushAsync();
    });

    it("watches a submitted job in the background: a later job.status updates state and toasts", async () => {
      restoreJobIds = withSequentialJobIds("launchC");
      const { toast } = await import("@/lib/notify");
      const spec: JobSpec = { type: "track", data_path: "/x.slp", model_paths: ["m1"] };
      await useConnectStore.getState().submitJobsOn(PAIRED_WORKER.nodeId, spec, { source: "window" });

      lastClient().emit("launchC_1", "job.status", { state: "completed" });
      await flushAsync();

      expect(useConnectStore.getState().trackedJobs).toEqual([
        expect.objectContaining({ jobId: "launchC_1", state: "completed" }),
      ]);
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringContaining("finished"),
        expect.objectContaining({ action: expect.objectContaining({ label: "Open" }) }),
      );
    });

    it("tracks and watches a train job's chained_job_ids, inheriting the parent's source", async () => {
      restoreJobIds = withSequentialJobIds("launchD");
      const { toast } = await import("@/lib/notify");
      const spec: JobSpec = {
        type: "train",
        config_contents: ["centroid yaml"],
        model_types: ["centroid"],
        labels_path: "/data/labels.slp",
      };
      await useConnectStore.getState().submitJobsOn(PAIRED_WORKER.nodeId, spec, { source: "worker-file" });

      const client = lastClient();
      client.emit("launchD_1", "job.result", { chained_job_ids: ["launchD_chained"] });
      await flushAsync();

      expect(useConnectStore.getState().trackedJobs).toEqual([
        expect.objectContaining({ jobId: "launchD_1", source: "worker-file" }),
        expect.objectContaining({
          jobId: "launchD_chained",
          kind: "track",
          label: "Inference",
          source: "worker-file",
          state: "active",
        }),
      ]);

      // The chained job is actually watched, not just recorded: its own
      // job.status still reaches it and still toasts.
      client.emit("launchD_chained", "job.status", { state: "completed" });
      await flushAsync();
      expect(
        useConnectStore.getState().trackedJobs.find((j) => j.jobId === "launchD_chained")?.state,
      ).toBe("completed");
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringContaining("Inference"),
        expect.anything(),
      );

      client.emit("launchD_1", "job.status", { state: "completed" });
      await flushAsync();
    });

    it("never tracks the same chained job id twice", async () => {
      restoreJobIds = withSequentialJobIds("launchE");
      const spec: JobSpec = { type: "train", config_contents: ["c"], model_types: ["centroid"] };
      await useConnectStore.getState().submitJobsOn(PAIRED_WORKER.nodeId, spec, { source: "window" });

      const client = lastClient();
      client.emit("launchE_1", "job.result", { chained_job_ids: ["launchE_chained"] });
      await flushAsync();
      // A second job.result (e.g. a reconnect's backlog replay) repeating
      // the same chained id must not add a duplicate tracked entry.
      client.emit("launchE_1", "job.result", { chained_job_ids: ["launchE_chained"] });
      await flushAsync();

      expect(
        useConnectStore.getState().trackedJobs.filter((j) => j.jobId === "launchE_chained"),
      ).toHaveLength(1);

      client.emit("launchE_1", "job.status", { state: "completed" });
      client.emit("launchE_chained", "job.status", { state: "completed" });
      await flushAsync();
    });
  });

  describe("cancelJob / stopJob", () => {
    beforeEach(async () => {
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER] });
      await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);
    });

    it("is a no-op with no current job", () => {
      expect(() => useConnectStore.getState().cancelJob()).not.toThrow();
      expect(lastClient().jobsCancelCalls).toEqual([]);
    });

    it("cancelJob sends mode: 'cancel' for the current job and clears the reattach banner", async () => {
      useConnectStore.setState({
        trackedJobs: [makeTracked()],
        reattachableJob: { jobId: "job_1", state: "running" },
      });
      useConnectStore.getState().cancelJob();
      await flushAsync();
      expect(lastClient().jobsCancelCalls).toEqual([["job_1", "cancel"]]);
      expect(useConnectStore.getState().reattachableJob).toBeNull();
    });

    it("stopJob sends mode: 'stop' for the current job", async () => {
      useConnectStore.setState({ trackedJobs: [makeTracked()] });
      useConnectStore.getState().stopJob();
      await flushAsync();
      expect(lastClient().jobsCancelCalls).toEqual([["job_1", "stop"]]);
    });

    // A split multi-model run is N sequential jobs sharing run.id: model 1
    // runs while the rest wait in the worker's queue. Stop Early (like local
    // training and SLEAP) ends only the model in progress, so the next one
    // still trains; Cancel ends the whole run.
    function splitRun() {
      useConnectStore.setState({
        trackedJobs: [
          makeTracked({ jobId: "job_a", kind: "train", submittedAt: 1 }),
          makeTracked({ jobId: "job_b", kind: "train", submittedAt: 2 }),
        ],
      });
      lastClient().jobsListResult = [
        { jobId: "job_a", state: "running", createdAt: "t1", queuePosition: null, modelTypes: [], run: { id: "run_1", index: 0, count: 2 } },
        { jobId: "job_b", state: "queued", createdAt: "t2", queuePosition: 1, modelTypes: [], run: { id: "run_1", index: 1, count: 2 } },
      ];
    }

    it("stopJob on a split run stops the model in progress, not the queued last one", async () => {
      splitRun();
      useConnectStore.getState().stopJob();
      await flushAsync();
      expect(lastClient().jobsCancelCalls).toEqual([["job_a", "stop"]]);
    });

    it("cancelJob on a split run cancels every unfinished job in it", async () => {
      splitRun();
      useConnectStore.getState().cancelJob();
      await flushAsync();
      expect(lastClient().jobsCancelCalls).toEqual([
        ["job_a", "cancel"],
        ["job_b", "cancel"],
      ]);
    });

    it("cancelJob leaves another run's jobs alone", async () => {
      splitRun();
      useConnectStore.setState({
        trackedJobs: [
          makeTracked({ jobId: "job_old", kind: "track", submittedAt: 0 }),
          ...useConnectStore.getState().trackedJobs,
        ],
      });
      lastClient().jobsListResult = [
        { jobId: "job_old", state: "running", createdAt: "t0", queuePosition: null, modelTypes: [], run: { id: "run_0", index: 0, count: 1 } },
        ...lastClient().jobsListResult,
      ];
      useConnectStore.getState().cancelJob();
      await flushAsync();
      expect(lastClient().jobsCancelCalls.map(([id]) => id)).toEqual(["job_a", "job_b"]);
    });

    it("cancelJob(runId) cancels that run even when a newer run was started since", async () => {
      // The Training panel's run (run_1) and, after it, a run queued from the
      // Connect window's New job wizard (run_2): the panel's Cancel must end
      // run_1, and run_2 must be left to start next.
      splitRun();
      useConnectStore.setState({
        trackedJobs: [
          ...useConnectStore.getState().trackedJobs,
          makeTracked({ jobId: "job_w1", kind: "train", source: "worker-file", submittedAt: 3 }),
          makeTracked({ jobId: "job_w2", kind: "train", source: "worker-file", submittedAt: 4 }),
        ],
      });
      lastClient().jobsListResult = [
        ...lastClient().jobsListResult,
        { jobId: "job_w1", state: "queued", createdAt: "t3", queuePosition: 2, modelTypes: [], run: { id: "run_2", index: 0, count: 2 } },
        { jobId: "job_w2", state: "queued", createdAt: "t4", queuePosition: 3, modelTypes: [], run: { id: "run_2", index: 1, count: 2 } },
      ];
      useConnectStore.getState().cancelJob("run_1");
      await flushAsync();
      expect(lastClient().jobsCancelCalls).toEqual([
        ["job_a", "cancel"],
        ["job_b", "cancel"],
      ]);
    });

    it("stopJob(runId) stops that run's model in progress", async () => {
      splitRun();
      useConnectStore.getState().stopJob("run_1");
      await flushAsync();
      expect(lastClient().jobsCancelCalls).toEqual([["job_a", "stop"]]);
    });

    it("falls back to the latest tracked job when the worker's job list is unavailable", async () => {
      useConnectStore.setState({ trackedJobs: [makeTracked()] });
      lastClient().jobsListShouldThrow = new Error("offline");
      useConnectStore.getState().stopJob();
      await flushAsync();
      expect(lastClient().jobsCancelCalls).toEqual([["job_1", "stop"]]);
      lastClient().jobsListShouldThrow = null;
    });

    it("shows an error toast when the worker refuses the stop", async () => {
      useConnectStore.setState({ trackedJobs: [makeTracked()] });
      lastClient().jobsCancelShouldThrow = new Error("job.not_found");
      useConnectStore.getState().stopJob();
      await flushAsync();
      const { toast } = await import("@/lib/notify");
      expect(toast.error).toHaveBeenCalledWith(
        expect.stringContaining("Couldn't stop training"),
        expect.objectContaining({ description: expect.stringContaining("job.not_found") }),
      );
      lastClient().jobsCancelShouldThrow = null;
    });

    it("only cancels a job tracked against the currently-selected worker", async () => {
      useConnectStore.setState({
        trackedJobs: [makeTracked({ workerId: "other-worker", jobId: "job_other" })],
      });
      useConnectStore.getState().cancelJob();
      await flushAsync();
      expect(lastClient().jobsCancelCalls).toEqual([]);
    });
  });

  describe("clientFor / releaseIdleConnections", () => {
    const OTHER_WORKER: PairedWorker = {
      nodeId: "other-worker-id",
      label: "Other worker",
      addrs: ["ws://10.0.0.5:9631"],
      pairedAt: "2026-09-27T00:00:00Z",
    };

    beforeEach(() => {
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER, OTHER_WORKER] });
    });

    it("connects a non-selected worker without changing the selected client/selection", async () => {
      await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);
      const selectedClient = lastClient();

      FakeWorkerClient.nextPeerNodeId = OTHER_WORKER.nodeId;
      const client = await useConnectStore.getState().clientFor(OTHER_WORKER.nodeId);

      expect(client).not.toBe(selectedClient as unknown as WorkerClient);
      expect(useConnectStore.getState()._client).toBe(selectedClient as unknown as WorkerClient);
      expect(useConnectStore.getState().selectedWorkerId).toBe(PAIRED_WORKER.nodeId);
    });

    it("reuses the same client on a second call for the same worker", async () => {
      FakeWorkerClient.nextPeerNodeId = OTHER_WORKER.nodeId;
      const first = await useConnectStore.getState().clientFor(OTHER_WORKER.nodeId);
      const second = await useConnectStore.getState().clientFor(OTHER_WORKER.nodeId);
      expect(second).toBe(first);
      expect(FakeWorkerClient.instances).toHaveLength(1);
    });

    it("concurrent calls for one worker share a single dial", async () => {
      FakeWorkerClient.nextPeerNodeId = OTHER_WORKER.nodeId;
      const [a, b] = await Promise.all([
        useConnectStore.getState().clientFor(OTHER_WORKER.nodeId),
        useConnectStore.getState().clientFor(OTHER_WORKER.nodeId),
      ]);
      expect(b).toBe(a);
      expect(FakeWorkerClient.instances).toHaveLength(1);
    });

    it("records a failed dial in workerErrors and rethrows", async () => {
      FakeWorkerClient.nextConnectShouldThrow = new Error("unreachable");
      await expect(useConnectStore.getState().clientFor(OTHER_WORKER.nodeId)).rejects.toThrow(
        "unreachable",
      );
      expect(useConnectStore.getState().workerErrors[OTHER_WORKER.nodeId]).toBe("unreachable");
    });

    it("clears a worker's recorded error on its next successful dial", async () => {
      FakeWorkerClient.nextConnectShouldThrow = new Error("unreachable");
      await expect(
        useConnectStore.getState().clientFor(OTHER_WORKER.nodeId),
      ).rejects.toThrow();
      FakeWorkerClient.nextPeerNodeId = OTHER_WORKER.nodeId;
      await useConnectStore.getState().clientFor(OTHER_WORKER.nodeId);
      expect(useConnectStore.getState().workerErrors[OTHER_WORKER.nodeId]).toBeNull();
    });

    it("releaseIdleConnections stops only idle, non-selected connections", async () => {
      await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);
      FakeWorkerClient.nextPeerNodeId = OTHER_WORKER.nodeId;
      await useConnectStore.getState().clientFor(OTHER_WORKER.nodeId);
      const otherClient = lastClient();
      const selectedClient = useConnectStore.getState()._client;

      useConnectStore.getState().releaseIdleConnections();

      expect(otherClient.closed).toBe(true);
      expect(useConnectStore.getState()._client).toBe(selectedClient);
      // A fresh clientFor() call for the released worker dials again.
      const reconnected = await useConnectStore.getState().clientFor(OTHER_WORKER.nodeId);
      expect(reconnected).not.toBe(otherClient as unknown as WorkerClient);
    });

    it("releaseIdleConnections leaves a worker with an active tracked job running", async () => {
      FakeWorkerClient.nextPeerNodeId = OTHER_WORKER.nodeId;
      await useConnectStore.getState().clientFor(OTHER_WORKER.nodeId);
      const otherClient = lastClient();
      useConnectStore.setState({ trackedJobs: [makeTracked({ workerId: OTHER_WORKER.nodeId })] });

      useConnectStore.getState().releaseIdleConnections();

      expect(otherClient.closed).toBe(false);
    });
  });

  describe("per-worker job actions + worker info", () => {
    beforeEach(() => {
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER] });
    });

    it("refreshWorkerInfo fetches worker.info into workerInfo", async () => {
      FakeWorkerClient.nextMounts = [];
      await useConnectStore.getState().refreshWorkerInfo(PAIRED_WORKER.nodeId);
      lastClient().workerInfoResult = {
        gpuModel: "A100",
        gpuMemoryMb: 81920,
        gpuCount: 2,
        cudaVersion: "12.4",
        sleapNnVersion: "0.2.0",
        busy: true,
      };
      await useConnectStore.getState().refreshWorkerInfo(PAIRED_WORKER.nodeId);
      expect(useConnectStore.getState().workerInfo[PAIRED_WORKER.nodeId]).toEqual({
        gpuModel: "A100",
        gpuMemoryMb: 81920,
        gpuCount: 2,
        cudaVersion: "12.4",
        sleapNnVersion: "0.2.0",
        busy: true,
      });
    });

    it("refreshWorkerInfo records a failure in workerErrors instead of throwing", async () => {
      FakeWorkerClient.nextConnectShouldThrow = new Error("unreachable");
      await useConnectStore.getState().refreshWorkerInfo(PAIRED_WORKER.nodeId);
      expect(useConnectStore.getState().workerErrors[PAIRED_WORKER.nodeId]).toBe("unreachable");
      expect(useConnectStore.getState().workerInfo[PAIRED_WORKER.nodeId]).toBeUndefined();
    });

    it("a later successful refreshWorkerInfo clears a stale workerErrors entry", async () => {
      await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);
      useConnectStore.setState({ workerErrors: { [PAIRED_WORKER.nodeId]: "old failure" } });
      await useConnectStore.getState().refreshWorkerInfo(PAIRED_WORKER.nodeId);
      expect(useConnectStore.getState().workerErrors[PAIRED_WORKER.nodeId]).toBeNull();
    });

    it("listJobs returns the worker's jobs.list", async () => {
      await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);
      lastClient().jobsListResult = [{ jobId: "job_1", state: "running", createdAt: "t1" }];
      const jobs = await useConnectStore.getState().listJobs(PAIRED_WORKER.nodeId);
      expect(jobs).toEqual([
        expect.objectContaining({ jobId: "job_1", state: "running" }),
      ]);
    });

    it("jobDetail returns the worker's jobs.status", async () => {
      await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);
      lastClient().jobsStatusResult = { state: "completed" };
      const status = await useConnectStore.getState().jobDetail(PAIRED_WORKER.nodeId, "job_1");
      expect(status.state).toBe("completed");
      expect(lastClient().jobsStatusCalls).toEqual(["job_1"]);
    });

    it("cancelJobOn calls jobsCancel on the given worker's client with the given mode", async () => {
      await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);
      await useConnectStore.getState().cancelJobOn(PAIRED_WORKER.nodeId, "job_1", "stop");
      expect(lastClient().jobsCancelCalls).toEqual([["job_1", "stop"]]);
    });

    describe("deleteJobsOn (PR6a §a.3)", () => {
      let restoreJobIds: () => void;

      afterEach(() => {
        restoreJobIds();
      });

      it("calls jobsDelete with the given job ids", async () => {
        restoreJobIds = withSequentialJobIds("del");
        await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);
        await useConnectStore.getState().deleteJobsOn(PAIRED_WORKER.nodeId, ["job_a", "job_b"]);
        expect(lastClient().jobsDeleteCalls).toEqual([["job_a", "job_b"]]);
      });

      it("prunes the deleted ids from trackedJobs, leaving other tracked jobs alone", async () => {
        restoreJobIds = withSequentialJobIds("del");
        useConnectStore.setState({
          trackedJobs: [
            makeTracked({ jobId: "job_a", workerId: PAIRED_WORKER.nodeId }),
            makeTracked({ jobId: "job_keep", workerId: PAIRED_WORKER.nodeId }),
          ],
        });
        await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);
        await useConnectStore.getState().deleteJobsOn(PAIRED_WORKER.nodeId, ["job_a"]);
        expect(useConnectStore.getState().trackedJobs.map((j) => j.jobId)).toEqual(["job_keep"]);
      });

      it("drops the deleted job's live subscription, so a later reconnect never re-subscribes it", async () => {
        restoreJobIds = withSequentialJobIds("del");
        useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER] });
        const spec: JobSpec = { type: "track", data_path: "/x.slp", model_paths: ["m1"] };
        const [jobId] = await useConnectStore
          .getState()
          .submitJobsOn(PAIRED_WORKER.nodeId, spec, { source: "worker-file" });

        await useConnectStore.getState().deleteJobsOn(PAIRED_WORKER.nodeId, [jobId!]);

        const freshClient = lastClient();
        freshClient.jobsSubscribeCalls = [];
        resubscribeWorker(PAIRED_WORKER.nodeId, freshClient as unknown as WorkerClient);
        expect(freshClient.jobsSubscribeCalls).toEqual([]);
      });

      it("propagates a job.active error from the worker without deleting anything client-side", async () => {
        restoreJobIds = withSequentialJobIds("del");
        useConnectStore.setState({
          trackedJobs: [makeTracked({ jobId: "job_a", workerId: PAIRED_WORKER.nodeId })],
        });
        await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);
        lastClient().jobsDeleteShouldThrow = new WorkerProtocolError(
          "job.active",
          "Job job_a is active and can't be deleted",
        );

        await expect(
          useConnectStore.getState().deleteJobsOn(PAIRED_WORKER.nodeId, ["job_a"]),
        ).rejects.toMatchObject({ code: "job.active" });
        expect(useConnectStore.getState().trackedJobs.map((j) => j.jobId)).toEqual(["job_a"]);
      });
    });
  });

  describe("fetchResultBlob", () => {
    it("throws if not connected to a worker", async () => {
      await expect(
        useConnectStore.getState().fetchResultBlob({ sha256: "abc123", size: 4 }),
      ).rejects.toThrow(/Not connected/);
    });

    it("delegates to the client's fetchBlob with the ref's sha256 and size", async () => {
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER] });
      await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);
      const client = lastClient();
      client.fetchBlobResult = new Uint8Array([9, 9, 9]);

      const bytes = await useConnectStore
        .getState()
        .fetchResultBlob({ sha256: "abc123", size: 4096 });

      expect(client.fetchBlobCalls).toEqual([["abc123", 4096]]);
      expect(bytes).toEqual(new Uint8Array([9, 9, 9]));
    });
  });

  describe("reattach detection", () => {
    const originalJobsStatus = FakeWorkerClient.prototype.jobsStatus;
    afterEach(() => {
      FakeWorkerClient.prototype.jobsStatus = originalJobsStatus;
    });

    it("surfaces a reattachableJob when the tracked job on this worker is still active", async () => {
      useConnectStore.setState({
        pairedWorkers: [PAIRED_WORKER],
        trackedJobs: [makeTracked()],
      });
      FakeWorkerClient.prototype.jobsStatus = async function (this: FakeWorkerClient, jobId: string) {
        this.jobsStatusCalls.push(jobId);
        return { state: "running" };
      };

      await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);

      expect(lastClient().jobsStatusCalls).toEqual(["job_1"]);
      expect(useConnectStore.getState().reattachableJob).toEqual({
        jobId: "job_1",
        state: "running",
      });
    });

    it("does not reattach a job that already reached a terminal state", async () => {
      useConnectStore.setState({
        pairedWorkers: [PAIRED_WORKER],
        trackedJobs: [makeTracked()],
      });
      FakeWorkerClient.prototype.jobsStatus = async function () {
        return { state: "completed" };
      };

      await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);

      expect(useConnectStore.getState().reattachableJob).toBeNull();
    });

    it("does not reattach a job tracked against a different worker", async () => {
      const other: PairedWorker = { ...PAIRED_WORKER, nodeId: "other", addrs: ["ws://other:1"] };
      useConnectStore.setState({
        pairedWorkers: [PAIRED_WORKER, other],
        trackedJobs: [makeTracked({ workerId: "other" })],
      });

      await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);

      expect(lastClient().jobsStatusCalls).toEqual([]);
      expect(useConnectStore.getState().reattachableJob).toBeNull();
    });

    it("does not reattach if the worker no longer recognizes the job", async () => {
      useConnectStore.setState({
        pairedWorkers: [PAIRED_WORKER],
        trackedJobs: [makeTracked()],
      });
      FakeWorkerClient.prototype.jobsStatus = async function () {
        throw new Error("job.not_found");
      };

      await expect(
        useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId),
      ).resolves.toBeUndefined();

      expect(useConnectStore.getState().reattachableJob).toBeNull();
    });

    it("no tracked job at all means no reattach check", async () => {
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER], trackedJobs: [] });

      await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);

      expect(lastClient().jobsStatusCalls).toEqual([]);
      expect(useConnectStore.getState().reattachableJob).toBeNull();
    });
  });

  describe("managed reconnection", () => {
    it("a freshly paired worker is reconnect-managed too", async () => {
      let t = 0;
      __setManagedDeps({
        now: () => t,
        sleep: (ms: number) => {
          t += ms;
          return Promise.resolve();
        },
      });
      await useConnectStore.getState().pairWithTicket(TICKET);

      // ...then pairing hands off to a managed connection (auth.prove, now
      // that this client is trusted), and the pairing client is closed.
      const pairingClient = FakeWorkerClient.instances[0];
      const managedClient = lastClient();
      expect(pairingClient.closed).toBe(true);
      expect(managedClient).not.toBe(pairingClient);
      expect(managedClient.authProveCalls).toBe(1);
      expect(useConnectStore.getState()._client).toBe(managedClient as unknown as WorkerClient);

      managedClient.simulateDrop();
      await waitUntil(() => useConnectStore.getState().connectionStatus === "connected"
        && useConnectStore.getState()._client !== (managedClient as unknown as WorkerClient));
      expect(FakeWorkerClient.instances.length).toBe(3);
    });

    it("an unintentional drop goes through 'reconnecting' and redials to a new _client", async () => {
      let t = 0;
      __setManagedDeps({
        now: () => t,
        sleep: (ms: number) => {
          t += ms;
          return Promise.resolve();
        },
      });
      useConnectStore.setState({ pairedWorkers: [PAIRED_WORKER] });
      await useConnectStore.getState().connectToWorker(PAIRED_WORKER.nodeId);
      const first = lastClient();
      const firstAsClient = first as unknown as WorkerClient;
      expect(useConnectStore.getState().connectionStatus).toBe("connected");

      // The first redial attempt fails once; ManagedConnection's own
      // backoff/retry sequencing is unit-tested in managedConnection.test.ts —
      // here we only need the wiring: status flips to "reconnecting" while
      // down, and a LATER successful redial swaps in a new _client.
      FakeWorkerClient.nextConnectShouldThrow = new Error("still down");
      first.simulateDrop();
      await waitUntil(() => useConnectStore.getState().connectionStatus === "reconnecting");
      expect(useConnectStore.getState()._client).toBe(firstAsClient);

      await waitUntil(() => useConnectStore.getState().connectionStatus === "connected");

      const state = useConnectStore.getState();
      expect(state._client).not.toBe(firstAsClient);
      expect(state._client).not.toBeNull();
      expect(FakeWorkerClient.instances.length).toBeGreaterThan(1);
    });
  });

  describe("resumeTrackedJobs", () => {
    it("toasts success and marks the job completed when the worker reports it finished while unwatched", async () => {
      const { toast } = await import("@/lib/notify");
      useConnectStore.setState({
        pairedWorkers: [PAIRED_WORKER],
        trackedJobs: [makeTracked({ jobId: "job_resume_1" })],
      });
      const originalJobsStatus = FakeWorkerClient.prototype.jobsStatus;
      FakeWorkerClient.prototype.jobsStatus = async function (this: FakeWorkerClient, jobId: string) {
        this.jobsStatusCalls.push(jobId);
        return { state: "completed" };
      };
      try {
        await useConnectStore.getState().resumeTrackedJobs();
      } finally {
        FakeWorkerClient.prototype.jobsStatus = originalJobsStatus;
      }

      expect(toast.success).toHaveBeenCalledTimes(1);
      expect(toast.success).toHaveBeenCalledWith(
        expect.stringContaining("finished"),
        expect.objectContaining({ action: expect.objectContaining({ label: "Open" }) }),
      );
      const job = useConnectStore
        .getState()
        .trackedJobs.find((j) => j.jobId === "job_resume_1");
      expect(job?.state).toBe("completed");
    });

    it("tracks a train job's chained inference jobs when it finished while the app was closed", async () => {
      useConnectStore.setState({
        pairedWorkers: [PAIRED_WORKER],
        trackedJobs: [makeTracked({ jobId: "job_resume_chain", source: "worker-file" })],
      });
      const originalJobsStatus = FakeWorkerClient.prototype.jobsStatus;
      FakeWorkerClient.prototype.jobsStatus = async function (this: FakeWorkerClient, jobId: string) {
        this.jobsStatusCalls.push(jobId);
        return jobId === "job_resume_chain"
          ? { state: "completed", result: { chained_job_ids: ["job_resume_chained"] } }
          : { state: "running" };
      };
      try {
        await useConnectStore.getState().resumeTrackedJobs();
      } finally {
        FakeWorkerClient.prototype.jobsStatus = originalJobsStatus;
      }

      const chained = useConnectStore
        .getState()
        .trackedJobs.find((j) => j.jobId === "job_resume_chained");
      expect(chained).toMatchObject({ kind: "track", source: "worker-file", state: "active" });
      await Promise.resolve(); // let the chained job's watcher reach jobsSubscribe
      expect(lastClient().jobsSubscribeCalls).toContainEqual(["job_resume_chained", 0]);
      // Finish it so its watcher leaves the module-level subscription registry
      // (otherwise a later test's reconnect would re-attach it).
      lastClient().emit("job_resume_chained", "job.status", { state: "completed" });
    });

    it("subscribes a watcher for a still-running job, resuming from its persisted lastSeq", async () => {
      useConnectStore.setState({
        pairedWorkers: [PAIRED_WORKER],
        trackedJobs: [makeTracked({ jobId: "job_resume_2", lastSeq: 7 })],
      });
      const originalJobsStatus = FakeWorkerClient.prototype.jobsStatus;
      FakeWorkerClient.prototype.jobsStatus = async function (this: FakeWorkerClient, jobId: string) {
        this.jobsStatusCalls.push(jobId);
        return { state: "running" };
      };
      try {
        await useConnectStore.getState().resumeTrackedJobs();
      } finally {
        FakeWorkerClient.prototype.jobsStatus = originalJobsStatus;
      }

      expect(lastClient().jobsSubscribeCalls).toEqual([["job_resume_2", 7]]);
      const job = useConnectStore
        .getState()
        .trackedJobs.find((j) => j.jobId === "job_resume_2");
      expect(job?.state).toBe("active"); // still running — no notification yet
    });

    it("calling resumeTrackedJobs twice does not double-notify", async () => {
      const { toast } = await import("@/lib/notify");
      useConnectStore.setState({
        pairedWorkers: [PAIRED_WORKER],
        trackedJobs: [makeTracked({ jobId: "job_resume_3" })],
      });
      const originalJobsStatus = FakeWorkerClient.prototype.jobsStatus;
      FakeWorkerClient.prototype.jobsStatus = async function (this: FakeWorkerClient, jobId: string) {
        this.jobsStatusCalls.push(jobId);
        return { state: "completed" };
      };
      try {
        await useConnectStore.getState().resumeTrackedJobs();
        await useConnectStore.getState().resumeTrackedJobs();
      } finally {
        FakeWorkerClient.prototype.jobsStatus = originalJobsStatus;
      }

      expect(toast.success).toHaveBeenCalledTimes(1);
    });

    it("toasts info (not error) and records the detail when a job was canceled while unwatched", async () => {
      const { toast } = await import("@/lib/notify");
      useConnectStore.setState({
        pairedWorkers: [PAIRED_WORKER],
        trackedJobs: [makeTracked({ jobId: "job_resume_4" })],
      });
      const originalJobsStatus = FakeWorkerClient.prototype.jobsStatus;
      FakeWorkerClient.prototype.jobsStatus = async function (this: FakeWorkerClient, jobId: string) {
        this.jobsStatusCalls.push(jobId);
        return { state: "canceled", error: "canceled by user" };
      };
      try {
        await useConnectStore.getState().resumeTrackedJobs();
      } finally {
        FakeWorkerClient.prototype.jobsStatus = originalJobsStatus;
      }

      expect(toast.info).toHaveBeenCalledTimes(1);
      expect(toast.info).toHaveBeenCalledWith(
        expect.stringContaining("was canceled"),
        expect.objectContaining({ action: expect.objectContaining({ label: "Open" }) }),
      );
      expect(toast.error).not.toHaveBeenCalled();
      const job = useConnectStore
        .getState()
        .trackedJobs.find((j) => j.jobId === "job_resume_4");
      expect(job?.state).toBe("canceled");
      expect(job?.error).toBe("canceled by user");
    });
  });
});

describe("trackedJobs persisted migration (v1 -> v2)", () => {
  it("migrates an existing currentJob into a single active TrackedJob", () => {
    const migrated = migrateConnectPersisted(
      {
        pairedWorkers: [],
        selectedWorkerId: "worker-node-id",
        currentJob: { workerId: "worker-node-id", jobId: "job_1" },
      },
      1,
    ) as { trackedJobs: TrackedJob[]; currentJob?: unknown };

    expect(migrated.currentJob).toBeUndefined();
    expect(migrated.trackedJobs).toEqual([
      expect.objectContaining({
        workerId: "worker-node-id",
        jobId: "job_1",
        lastSeq: 0,
        state: "active",
        seen: false,
        source: "window",
      }),
    ]);
  });

  it("migrates a null currentJob into an empty trackedJobs list", () => {
    const migrated = migrateConnectPersisted(
      { pairedWorkers: [], selectedWorkerId: null, currentJob: null },
      1,
    ) as { trackedJobs: TrackedJob[] };

    expect(migrated.trackedJobs).toEqual([]);
  });

  it("leaves already-v2 persisted state untouched", () => {
    const existing = { pairedWorkers: [], selectedWorkerId: null, trackedJobs: [makeTracked()] };
    const migrated = migrateConnectPersisted(existing, 2) as typeof existing;
    expect(migrated.trackedJobs).toEqual([makeTracked()]);
  });
});

describe("capTrackedJobs", () => {
  it("keeps active jobs and drops the oldest non-active ones beyond the cap", () => {
    const active = Array.from({ length: 5 }, (_, i) =>
      makeTracked({ jobId: `active_${i}`, submittedAt: i }),
    );
    const nonActive = Array.from({ length: 50 }, (_, i) =>
      makeTracked({ jobId: `done_${i}`, state: "completed", submittedAt: 1000 + i }),
    );

    const capped = capTrackedJobs([...nonActive, ...active]);

    expect(capped).toHaveLength(50);
    expect(capped.filter((j) => j.state === "active")).toHaveLength(5);
    // The 5 oldest non-active jobs (done_0..done_4) were dropped first.
    expect(capped.some((j) => j.jobId === "done_0")).toBe(false);
    expect(capped.some((j) => j.jobId === "done_49")).toBe(true);
  });

  it("never evicts an active job even if active jobs alone exceed the cap", () => {
    const active = Array.from({ length: 51 }, (_, i) =>
      makeTracked({ jobId: `active_${i}`, submittedAt: i }),
    );

    expect(capTrackedJobs(active)).toHaveLength(51);
  });
});
