/**
 * Connection to a sleap-connect worker (protocol v1, pairing model).
 *
 * Replaces the old room/WebRTC/GitHub-OAuth model — see
 * docs/plans/2026-09-26-sleap-connect-protocol-v1-spec.md §3. There is no
 * signaling server and no account: the app persists a small list of workers
 * it has paired with (keyed by `node_id`, Syncthing/Plex-style), and talks
 * to at most one of them at a time via `WorkerClient` (src/lib/protocolV1).
 *
 * **Known interim gap** (already accepted/deferred at the worker side — see
 * talmolab/sleap-connect PRs #84-#88 — not a new limitation introduced here):
 * - The worker's `CommandBuilder.build_command` only ever runs
 *   `config_contents[0]` — it doesn't support a multi-model pipeline
 *   (top-down centroid + centered-instance) as a single job. This store
 *   reproduces the old one-`JOB_COMPLETE`-per-model UX by submitting one
 *   job per model sequentially instead (see `submitJob`/`submitSingleJob`).
 *
 * Training telemetry (`job.epoch`/`job.curve`/`job.metric`) is parsed by
 * `parseJobTelemetry` and handed to `submitJob`'s `onTelemetry` tagged with
 * the per-model job index, so the caller can route it to the right model.
 * `job.log`'s optional `progress: true` flag (an in-place tqdm redraw) is
 * forwarded as `onProgress`'s second argument.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  FileEntry,
  JobResult,
  JobResultBlobRef,
  JobSpec,
  TrainJobSpec,
} from "@/lib/sleapConnect";
import { APP_VERSION } from "@/lib/version";
import { isTauri } from "@/platform/index";
import type { AgentInfo } from "@/lib/protocolV1/envelope";
import type { Mount, WorkerClient, WorkerEvent } from "@/lib/protocolV1/client";
import { parseJobTelemetry, type JobTelemetry } from "@/lib/protocolV1/jobTelemetry";
import {
  irohTransportAvailable,
  parseTicketIroh,
  toIrohDialTarget,
  transportLabel,
  type IrohEndpointInfo,
  type TransportKind,
} from "@/lib/protocolV1/transport";

const AGENT_INFO: AgentInfo = {
  name: "sleap-app",
  version: APP_VERSION,
  platform: isTauri ? "tauri" : "web",
};

// ── Types ─────────────────────────────────────────────────────────

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

/** A worker this device has paired with — persisted, Syncthing/Plex-style. */
export interface PairedWorker {
  nodeId: string;
  label: string;
  addrs: string[];
  pairedAt: string;
  /** Direct-connect (iroh) reachability from the pairing ticket, if it had any (stage 2.1). */
  iroh?: IrohEndpointInfo;
  /** The transport last connected over, reused by one-click reconnects. Absent = "ws". */
  transport?: TransportKind;
}

/** The JSON a worker's `sleap-rtc pair` command prints (spec §3.2). */
export interface PairingTicket {
  node_id: string;
  addrs: string[];
  secret: string;
  expires_at?: string;
  /** Optional direct-connect info (stage 2.1): `{ node_id?, relay_url?, direct_addrs? }`. */
  iroh?: unknown;
}

/**
 * A remote job this device is tracking against a specific paired worker.
 * Superseded the old single-slot `(node_id, job_id)` pair (spec §3.4) once
 * the Connect window (PR2-5) needed to show several jobs at once — across
 * workers, across a sequential multi-model training run, and across app
 * restarts. `workerId` guards against checking a job's status against the
 * wrong worker after switching which one is selected; `source` distinguishes
 * a job this window submitted ("window", all PR2b ever produces) from one
 * discovered already running on a worker by PR5's job-file scan
 * ("worker-file").
 */
export interface TrackedJob {
  workerId: string;
  jobId: string;
  /** Highest event `seq` already applied — lets a reconnect catch up without reprocessing. */
  lastSeq: number;
  kind: "train" | "track";
  /** Human-readable summary, e.g. "Train centroid", "Inference". */
  label: string;
  source: "window" | "worker-file";
  state: "active" | "completed" | "failed" | "canceled";
  /** Whether the user has seen this job reach a terminal state (gates resume-on-launch toasts). */
  seen: boolean;
  submittedAt: number;
}

/** A job found still active on a worker from a previous session (spec §3.4). */
export interface ReattachableJob {
  jobId: string;
  state: string;
}

/**
 * A `job.log` line. `isProgress` is the worker's `progress: true` flag: the
 * line is the current state of an in-place progress bar and should REPLACE
 * the previous progress line rather than append.
 */
export type JobLogHandler = (line: string, isProgress?: boolean) => void;

export interface SubmitJobOptions {
  /** Fires for every model's job of a split multi-model train spec except the last (whose result is the return value). */
  onModelComplete?: (result: JobResult) => void;
  /**
   * Structured training telemetry. `jobIndex` is the job's position in a
   * split multi-model train spec (= its `config_contents` index), 0 for a
   * single job.
   */
  onTelemetry?: (telemetry: JobTelemetry, jobIndex: number) => void;
}

export interface ConnectOptions {
  transport?: TransportKind;
}

const TERMINAL_JOB_STATES = new Set(["completed", "failed", "canceled"]);

interface ConnectState {
  // ── Persisted ──────────────────────────────────────────────────
  pairedWorkers: PairedWorker[];
  selectedWorkerId: string | null;
  trackedJobs: TrackedJob[];

  // ── Runtime (not persisted) ─────────────────────────────────────
  connectionStatus: ConnectionStatus;
  connectionError: string | null;
  workerMounts: Mount[];
  /** Set once per connect if the worker just connected to has an active tracked job. */
  reattachableJob: ReattachableJob | null;
  /** Transport of the current/most recent connection attempt; `null` when disconnected. */
  activeTransport: TransportKind | null;
  _client: WorkerClient | null;

  // ── Actions ──────────────────────────────────────────────────────
  /**
   * Claim a fresh pairing ticket (JSON from `sleap-rtc pair`) and connect.
   * `options.transport` picks the dial explicitly (default `"ws"`); `"iroh"`
   * needs the desktop app and an `iroh` section in the ticket.
   */
  pairWithTicket: (
    ticketJson: string,
    addrOverride?: string,
    options?: ConnectOptions,
  ) => Promise<void>;
  /**
   * Reconnect to an already-paired worker by node_id. Without an explicit
   * `options.transport`, reuses the transport last connected over (`"ws"`
   * if none, or if iroh is remembered but unavailable here).
   */
  connectToWorker: (nodeId: string, options?: ConnectOptions) => Promise<void>;
  /** Select (and connect to) a paired worker, or `null` to disconnect. */
  selectWorker: (nodeId: string | null, options?: ConnectOptions) => Promise<void>;
  disconnect: () => void;
  forgetWorker: (nodeId: string) => void;
  browseRemoteDir: (path: string) => Promise<FileEntry[]>;
  submitJob: (
    spec: JobSpec,
    onProgress: JobLogHandler,
    options?: SubmitJobOptions,
  ) => Promise<JobResult>;
  /** Hard-cancel the current job. */
  cancelJob: () => void;
  /** Gracefully early-stop the current job (checkpoint + finish). */
  stopJob: () => void;
  /** Fetch a result blob's bytes (e.g. `JobResult.resultBlobs.predictions`). */
  fetchResultBlob: (ref: JobResultBlobRef) => Promise<Uint8Array>;
}

// ── Helpers ───────────────────────────────────────────────────────

function upsertWorker(existing: PairedWorker[], next: PairedWorker): PairedWorker[] {
  return [...existing.filter((w) => w.nodeId !== next.nodeId), next];
}

function activeJobsFor(workerId: string, jobs: TrackedJob[]): TrackedJob[] {
  return jobs.filter((j) => j.workerId === workerId && j.state === "active");
}

/** The most recently submitted still-active job on a worker, or `null`. */
function latestActiveJobFor(workerId: string, jobs: TrackedJob[]): TrackedJob | null {
  const active = activeJobsFor(workerId, jobs);
  return active.length > 0 ? active[active.length - 1] : null;
}

const MAX_TRACKED_JOBS = 50;

/**
 * Caps the list at `MAX_TRACKED_JOBS`, oldest-first among non-active jobs
 * only — an active job is never evicted just to make room (if active jobs
 * alone exceed the cap, the list is left over-length rather than dropping
 * something still running). Exported for direct unit testing.
 */
export function capTrackedJobs(jobs: TrackedJob[]): TrackedJob[] {
  let excess = jobs.length - MAX_TRACKED_JOBS;
  if (excess <= 0) return jobs;
  const dropIdx = new Set<number>();
  const byAge = jobs
    .map((j, i) => ({ j, i }))
    .filter(({ j }) => j.state !== "active")
    .sort((a, b) => a.j.submittedAt - b.j.submittedAt);
  for (const { i } of byAge) {
    if (excess <= 0) break;
    dropIdx.add(i);
    excess--;
  }
  return jobs.filter((_, i) => !dropIdx.has(i));
}

/** A tracked job's display label, derived from the spec that submitted it. */
function trackedJobLabel(spec: JobSpec): string {
  return spec.type === "track" ? "Inference" : `Train ${spec.model_types?.[0] ?? "model"}`;
}

/**
 * Migrates persisted state from before `trackedJobs` existed (v1, a single
 * `currentJob: {workerId, jobId} | null`) to v2's `TrackedJob[]`. Exported
 * for direct unit testing — the real `migrate` persist option below just
 * calls this.
 */
export function migrateConnectPersisted(persisted: unknown, version: number): unknown {
  const p = { ...(persisted as Record<string, unknown>) };
  if (version < 2) {
    const cj = p.currentJob as { workerId: string; jobId: string } | null | undefined;
    p.trackedJobs = cj
      ? [
          {
            ...cj,
            lastSeq: 0,
            kind: "train" as const,
            label: "Remote job",
            source: "window" as const,
            state: "active" as const,
            seen: false,
            submittedAt: Date.now(),
          },
        ]
      : [];
    delete p.currentJob;
  }
  return p;
}

function isMultiModelTrainSpec(
  spec: JobSpec,
): spec is TrainJobSpec & { config_contents: string[] } {
  return (
    spec.type === "train" &&
    Array.isArray(spec.config_contents) &&
    spec.config_contents.length > 1
  );
}

/** What to dial: `url` is a ws address, or the encoded iroh target for `"iroh"`. */
interface DialSpec {
  transport: TransportKind;
  url: string;
  /** Human-readable address for error messages. */
  display: string;
}

/** ws is the implicit default, so only a non-default choice is persisted on the worker. */
function rememberedTransport(t: TransportKind): TransportKind | undefined {
  return t === "iroh" ? "iroh" : undefined;
}

const IROH_DESKTOP_ONLY =
  "Direct (iroh) connections are only available in the desktop app — use the WebSocket address instead.";

async function irohDial(info: IrohEndpointInfo | undefined, nodeId: string): Promise<DialSpec> {
  if (!irohTransportAvailable()) throw new Error(IROH_DESKTOP_ONLY);
  if (!info) {
    throw new Error("This worker has no direct (iroh) connection info — use its WebSocket address.");
  }
  const { encodeIrohDialUrl } = await import("@/lib/protocolV1/tauriIrohSocket");
  const target = toIrohDialTarget(info, nodeId);
  return {
    transport: "iroh",
    url: encodeIrohDialUrl(target),
    display: `iroh endpoint ${target.nodeId.slice(0, 8)}…`,
  };
}

async function makeClient(dial: DialSpec): Promise<WorkerClient> {
  const { getClientIdentity } = await import("@/lib/protocolV1/identity");
  const { WorkerClient: WorkerClientCtor } = await import("@/lib/protocolV1/client");
  const identity = await getClientIdentity();
  if (dial.transport === "iroh") {
    const { createTauriIrohSocket } = await import("@/lib/protocolV1/tauriIrohSocket");
    return new WorkerClientCtor({
      url: dial.url,
      identity,
      agent: AGENT_INFO,
      createSocket: createTauriIrohSocket(),
    });
  }
  return new WorkerClientCtor({ url: dial.url, identity, agent: AGENT_INFO });
}

/**
 * If `trackedJob` belongs to `workerId` (the worker we just connected to)
 * and is still active there, returns it as a `ReattachableJob`; otherwise
 * `null` (nothing to reattach to — wrong worker, already finished, or the
 * worker no longer recognizes the job at all).
 */
async function checkReattach(
  client: WorkerClient,
  workerId: string,
  trackedJob: TrackedJob | null,
): Promise<ReattachableJob | null> {
  if (!trackedJob || trackedJob.workerId !== workerId) return null;
  try {
    const status = await client.jobsStatus(trackedJob.jobId);
    if (TERMINAL_JOB_STATES.has(status.state)) return null;
    return { jobId: trackedJob.jobId, state: status.state };
  } catch {
    return null;
  }
}

/**
 * One job's live event subscription, tracked at module level (NOT persisted
 * — it's rebuilt fresh every session) so a reconnect can re-attach it to a
 * new `WorkerClient` without the submitting `submitJob` promise ever
 * knowing its connection was replaced underneath it. Keyed by `jobId`.
 */
interface ActiveSubscription {
  workerId: string;
  jobId: string;
  handle: (event: WorkerEvent) => void;
  unsubscribe: (() => void) | null;
}
const activeSubscriptions = new Map<string, ActiveSubscription>();

/** (Re)subscribes `sub` on `client` starting from `sinceSeq`, dropping any prior subscription first. */
async function attachSubscription(
  client: WorkerClient,
  sub: ActiveSubscription,
  sinceSeq: number,
): Promise<void> {
  sub.unsubscribe?.();
  sub.unsubscribe = await client.jobsSubscribe(sub.jobId, sinceSeq, sub.handle);
}

/** The persisted `lastSeq` for one tracked job — the catch-up point after a reconnect. */
function trackedLastSeq(jobId: string): number {
  return useConnectStore.getState().trackedJobs.find((j) => j.jobId === jobId)?.lastSeq ?? 0;
}

/**
 * Re-attaches every active subscription belonging to `workerId` onto a newly
 * (re)connected `client`, resuming each from its last-applied seq. Called by
 * `ManagedConnection`'s `onConnected` (§2b.4) for every reconnect/route
 * switch, not just the selected worker's — a background job on an
 * unselected-but-tracked worker still needs to keep receiving events.
 */
export function resubscribeWorker(workerId: string, client: WorkerClient): void {
  for (const sub of activeSubscriptions.values()) {
    if (sub.workerId !== workerId) continue;
    void attachSubscription(client, sub, trackedLastSeq(sub.jobId));
  }
}

const LAST_SEQ_PERSIST_THROTTLE_MS = 2000;

/**
 * Submits one job and resolves once it reaches a terminal state, forwarding
 * `job.log` lines to `onProgress` as they arrive. The subscription survives
 * a reconnect (registered in `activeSubscriptions`, re-attached by
 * `resubscribeWorker`): `since_seq: 0` is safe for the very first subscribe
 * since there's no backlog yet, and every event is deduped by seq so a
 * reconnect's backlog replay can never double-apply one already seen live.
 */
async function submitSingleJob(
  client: WorkerClient,
  workerId: string,
  spec: JobSpec,
  onProgress: JobLogHandler,
  set: (partial: Partial<ConnectState> | ((state: ConnectState) => Partial<ConnectState>)) => void,
  onTelemetry?: (telemetry: JobTelemetry) => void,
): Promise<JobResult> {
  const { jobId } = await client.jobsSubmit(spec as unknown as Record<string, unknown>);
  const tracked: TrackedJob = {
    workerId,
    jobId,
    lastSeq: 0,
    kind: spec.type,
    label: trackedJobLabel(spec),
    source: "window",
    state: "active",
    seen: false,
    submittedAt: Date.now(),
  };
  set((state) => ({ trackedJobs: capTrackedJobs([...state.trackedJobs, tracked]) }));

  return new Promise<JobResult>((resolve, reject) => {
    let settled = false;
    // job.result arrives before job.status: completed (the worker emits
    // them in that order specifically so this is never missed) — captured
    // here so it's already in hand by the time `finish` resolves.
    let resultBlobs: JobResult["resultBlobs"];
    let modelDir: string | undefined;
    let labelsPath: string | undefined;
    let lastSeq = 0;
    let lastPersistedAt = 0;

    // Throttled so a fast stream of job.log/telemetry events doesn't write
    // to the store on every single one; always caught up on terminal below.
    const persistLastSeq = () => {
      const now = Date.now();
      if (now - lastPersistedAt < LAST_SEQ_PERSIST_THROTTLE_MS) return;
      lastPersistedAt = now;
      set((state) => ({
        trackedJobs: state.trackedJobs.map((j) => (j.jobId === jobId ? { ...j, lastSeq } : j)),
      }));
    };

    const finish = (result: JobResult, trackedState: TrackedJob["state"]) => {
      if (settled) return;
      settled = true;
      sub.unsubscribe?.();
      activeSubscriptions.delete(jobId);
      // Keep the tracked entry (it's the Connect window's job history) and
      // just record its terminal state, rather than clearing it the way the
      // old single-slot `currentJob` did. `seen: true` here because this
      // window is live and watching it finish; resume-on-launch's toast
      // (§2b.5) only fires for a job that reaches terminal while unwatched.
      set((state) => ({
        trackedJobs: state.trackedJobs.map((j) =>
          j.jobId === jobId ? { ...j, state: trackedState, seen: true, lastSeq } : j,
        ),
      }));
      resolve(result);
    };

    const sub: ActiveSubscription = {
      workerId,
      jobId,
      unsubscribe: null,
      handle: (event) => {
        // The worker's `since_seq` is exclusive, but a live event can still
        // arrive both live (before a drop) and again in a reconnect's
        // backlog replay — drop anything already applied.
        if (event.seq <= lastSeq) return;
        lastSeq = event.seq;
        persistLastSeq();

        if (event.topic === "job.log") {
          onProgress((event.data.line as string) ?? "", event.data.progress === true);
        } else if (event.topic === "job.result") {
          const blobs = event.data.blobs as Record<string, JobResultBlobRef> | undefined;
          if (blobs && Object.keys(blobs).length > 0) resultBlobs = blobs;
          // Train jobs only: the trained model folder + the labels file it
          // trained on, both worker-side paths (inputs to a follow-up track job).
          if (typeof event.data.model_dir === "string") modelDir = event.data.model_dir;
          if (typeof event.data.labels_path === "string") labelsPath = event.data.labels_path;
        } else if (event.topic === "job.status") {
          const state = event.data.state as string;
          if (state === "completed") {
            const result: JobResult = { jobId, success: true, resultBlobs };
            if (modelDir !== undefined) result.modelDir = modelDir;
            if (labelsPath !== undefined) result.labelsPath = labelsPath;
            finish(result, "completed");
          } else if (state === "failed" || state === "canceled") {
            finish(
              { jobId, success: false, error: (event.data.detail as string) ?? `Job ${state}` },
              state,
            );
          }
        } else if (onTelemetry) {
          const telemetry = parseJobTelemetry(event);
          if (telemetry) onTelemetry(telemetry);
        }
      },
    };

    activeSubscriptions.set(jobId, sub);
    attachSubscription(client, sub, 0).catch((err: unknown) => {
      activeSubscriptions.delete(jobId);
      if (!settled) {
        settled = true;
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  });
}

// ── Store ─────────────────────────────────────────────────────────

export const useConnectStore = create<ConnectState>()(
  persist(
    (set, get) => ({
      pairedWorkers: [],
      selectedWorkerId: null,
      trackedJobs: [],

      connectionStatus: "disconnected",
      connectionError: null,
      workerMounts: [],
      reattachableJob: null,
      activeTransport: null,
      _client: null,

      pairWithTicket: async (ticketJson, addrOverride, options) => {
        let ticket: PairingTicket;
        try {
          ticket = JSON.parse(ticketJson);
        } catch {
          throw new Error("That doesn't look like a valid pairing ticket (invalid JSON).");
        }
        if (!ticket.node_id || !ticket.secret) {
          throw new Error("Pairing ticket is missing node_id or secret.");
        }
        const irohInfo = parseTicketIroh(ticket.iroh);
        const transport = options?.transport ?? "ws";
        let dial: DialSpec;
        let addr: string | undefined;
        if (transport === "iroh") {
          dial = await irohDial(irohInfo, ticket.node_id);
        } else {
          addr = addrOverride || ticket.addrs?.[0];
          if (!addr) {
            throw new Error(
              "This ticket has no worker address — enter one (e.g. ws://192.168.1.42:9631).",
            );
          }
          dial = { transport: "ws", url: addr, display: addr };
        }

        get()._client?.close();
        set({ connectionStatus: "connecting", connectionError: null, activeTransport: transport });

        let client: WorkerClient | null = null;
        try {
          client = await makeClient(dial);
          await client.connect();
          if (client.peerNodeId !== ticket.node_id) {
            throw new Error(
              `Worker at ${dial.display} identified itself as a different node than this ticket ` +
                `claims (expected ${ticket.node_id}, got ${client.peerNodeId}) — check the ` +
                "address, or get a fresh ticket from the worker you meant to pair with.",
            );
          }
          await client.pairClaim(ticket.secret);
          const mounts = await client.fsMounts();
          const reattachableJob = await checkReattach(
            client,
            ticket.node_id,
            latestActiveJobFor(ticket.node_id, get().trackedJobs),
          );

          const paired: PairedWorker = {
            nodeId: ticket.node_id,
            label: `Worker ${ticket.node_id.slice(0, 8)}`,
            addrs: addr
              ? [addr, ...(ticket.addrs ?? []).filter((a) => a !== addr)]
              : [...(ticket.addrs ?? [])],
            pairedAt: new Date().toISOString(),
            iroh: irohInfo,
            transport: rememberedTransport(transport),
          };

          set((state) => ({
            pairedWorkers: upsertWorker(state.pairedWorkers, paired),
            selectedWorkerId: paired.nodeId,
            connectionStatus: "connected",
            connectionError: null,
            workerMounts: mounts,
            reattachableJob,
            activeTransport: transport,
            _client: client,
          }));
        } catch (err) {
          // client.connect() may have already opened a real socket even
          // though a later step (pairClaim/fsMounts) failed — close it so
          // it isn't leaked, unreachable from store state but still live.
          client?.close();
          set({
            connectionStatus: "error",
            connectionError: err instanceof Error ? err.message : String(err),
            _client: null,
          });
          throw err;
        }
      },

      connectToWorker: async (nodeId, options) => {
        const worker = get().pairedWorkers.find((w) => w.nodeId === nodeId);
        if (!worker) {
          throw new Error("Unknown worker — pair with it first.");
        }
        const transport: TransportKind =
          options?.transport ??
          (worker.transport === "iroh" && worker.iroh && irohTransportAvailable() ? "iroh" : "ws");
        let dial: DialSpec;
        if (transport === "iroh") {
          dial = await irohDial(worker.iroh, nodeId);
        } else {
          const addr = worker.addrs[0];
          if (!addr) {
            throw new Error(`No known address for ${worker.label}.`);
          }
          dial = { transport: "ws", url: addr, display: addr };
        }

        get()._client?.close();
        set({
          selectedWorkerId: nodeId,
          connectionStatus: "connecting",
          connectionError: null,
          activeTransport: transport,
        });

        let client: WorkerClient | null = null;
        try {
          client = await makeClient(dial);
          await client.connect();
          if (client.peerNodeId !== nodeId) {
            throw new Error(
              `Worker at ${dial.display} identified itself as a different node than expected ` +
                `(expected ${nodeId}, got ${client.peerNodeId}) — the address may now point ` +
                "at a different worker. Forget and re-pair if this persists.",
            );
          }
          await client.authProve();
          const mounts = await client.fsMounts();
          const reattachableJob = await checkReattach(
            client,
            nodeId,
            latestActiveJobFor(nodeId, get().trackedJobs),
          );

          set((state) => ({
            pairedWorkers: state.pairedWorkers.map((w) =>
              w.nodeId === nodeId ? { ...w, transport: rememberedTransport(transport) } : w,
            ),
            connectionStatus: "connected",
            connectionError: null,
            workerMounts: mounts,
            reattachableJob,
            activeTransport: transport,
            _client: client,
          }));
        } catch (err) {
          // See the matching comment in pairWithTicket — same leak risk.
          client?.close();
          set({
            connectionStatus: "error",
            connectionError: err instanceof Error ? err.message : String(err),
            _client: null,
          });
          throw err;
        }
      },

      selectWorker: async (nodeId, options) => {
        if (nodeId === null) {
          get().disconnect();
          return;
        }
        await get().connectToWorker(nodeId, options);
      },

      disconnect: () => {
        get()._client?.close();
        set({
          connectionStatus: "disconnected",
          connectionError: null,
          workerMounts: [],
          reattachableJob: null,
          activeTransport: null,
          _client: null,
        });
      },

      forgetWorker: (nodeId) => {
        if (get().selectedWorkerId === nodeId) {
          get().disconnect();
        }
        set((state) => ({
          pairedWorkers: state.pairedWorkers.filter((w) => w.nodeId !== nodeId),
          selectedWorkerId: state.selectedWorkerId === nodeId ? null : state.selectedWorkerId,
          trackedJobs: state.trackedJobs.filter((j) => j.workerId !== nodeId),
        }));
      },

      browseRemoteDir: async (path) => {
        const allEntries: FileEntry[] = [];
        let offset = 0;
        const MAX_PAGES = 200; // safety cap (200 pages * ~25 = ~5000 entries)

        for (let page = 0; page < MAX_PAGES; page++) {
          const { _client } = get();
          if (!_client || !_client.authenticated) {
            throw new Error("Not connected to worker");
          }
          const result = await _client.fsList(path, offset);
          const entries: FileEntry[] = result.entries.map((e) => ({
            name: e.name,
            isDir: e.type === "directory",
            size: e.size,
          }));
          allEntries.push(...entries);
          if (!result.hasMore || entries.length === 0) break;
          offset += entries.length;
        }

        return allEntries;
      },

      submitJob: async (spec, onProgress, options) => {
        const { _client, selectedWorkerId } = get();
        if (!_client || !_client.authenticated || !selectedWorkerId) {
          throw new Error("Not connected to a worker");
        }

        if (isMultiModelTrainSpec(spec)) {
          const modelTypes = spec.model_types ?? [];
          const n = spec.config_contents.length;
          let finalResult: JobResult = { jobId: "", success: true };
          for (let i = 0; i < n; i++) {
            const perModelSpec: TrainJobSpec = {
              ...spec,
              config_contents: [spec.config_contents[i]],
              model_types: modelTypes[i] ? [modelTypes[i]] : [],
            };
            finalResult = await submitSingleJob(
              _client,
              selectedWorkerId,
              perModelSpec,
              onProgress,
              set,
              options?.onTelemetry && ((t) => options.onTelemetry!(t, i)),
            );
            if (!finalResult.success) return finalResult;
            // Only intermediate models fire onModelComplete — matching the
            // old JOB_COMPLETE-per-model semantics, the LAST model's
            // completion is just the resolved return value.
            if (i < n - 1) options?.onModelComplete?.(finalResult);
          }
          return finalResult;
        }

        return submitSingleJob(
          _client,
          selectedWorkerId,
          spec,
          onProgress,
          set,
          options?.onTelemetry && ((t) => options.onTelemetry!(t, 0)),
        );
      },

      cancelJob: () => {
        const { _client, selectedWorkerId, trackedJobs } = get();
        const job = selectedWorkerId ? latestActiveJobFor(selectedWorkerId, trackedJobs) : null;
        if (_client && job) {
          _client
            .jobsCancel(job.jobId, "cancel")
            .catch((err: unknown) => console.warn("[connect] jobsCancel failed:", err));
        }
        set({ reattachableJob: null });
      },

      stopJob: () => {
        const { _client, selectedWorkerId, trackedJobs } = get();
        const job = selectedWorkerId ? latestActiveJobFor(selectedWorkerId, trackedJobs) : null;
        if (_client && job) {
          _client
            .jobsCancel(job.jobId, "stop")
            .catch((err: unknown) => console.warn("[connect] jobsCancel(stop) failed:", err));
        }
        set({ reattachableJob: null });
      },

      fetchResultBlob: async (ref) => {
        const { _client, activeTransport } = get();
        if (!_client || !_client.authenticated) {
          throw new Error("Not connected to a worker");
        }
        if (activeTransport === "iroh") {
          // Blob downloads dial the worker's HTTP blob port derived from a
          // ws:// URL, which a direct iroh connection doesn't have (stage 2.4
          // decides how blobs travel over iroh).
          throw new Error(
            `Result files can't be downloaded over a ${transportLabel("iroh")} connection yet — ` +
              "reconnect over the WebSocket address to fetch them.",
          );
        }
        return _client.fetchBlob(ref.sha256, ref.size);
      },
    }),
    {
      name: "sleap-app-connect",
      version: 2,
      partialize: (state) => ({
        pairedWorkers: state.pairedWorkers,
        selectedWorkerId: state.selectedWorkerId,
        trackedJobs: state.trackedJobs,
      }),
      migrate: migrateConnectPersisted as (persisted: unknown, version: number) => ConnectState,
    },
  ),
);
