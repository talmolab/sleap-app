/**
 * Connection to a sleap-connect worker (protocol v1, pairing model).
 *
 * Replaces the old room/WebRTC/GitHub-OAuth model — see
 * docs/plans/2026-09-26-sleap-connect-protocol-v1-spec.md §3. There is no
 * signaling server and no account: the app persists a small list of workers
 * it has paired with (keyed by `node_id`, Syncthing/Plex-style), and talks
 * to at most one of them at a time via `WorkerClient` (src/lib/protocolV1).
 *
 * **Known interim gaps** (both already accepted/deferred at the worker
 * side — see talmolab/sleap-connect PRs #84-#88 — not new limitations
 * introduced here):
 * - The worker doesn't wire `job.metric` (structured epoch/loss ZMQ events)
 *   yet — only raw `job.log` lines. Anything relying on the old
 *   `__PROGRESS_REPORT__` sentinel (wandb URL, epoch/loss charts) only
 *   works for remote jobs to the extent it can be scraped back out of raw
 *   log text (same regex/JSON fallbacks `trainingStore.ts`'s `onProgress`
 *   already has for local jobs). Also, `job.log` can't distinguish a `\r`
 *   (tqdm in-place update) from a `\n` (a new line) the way the old
 *   `CR::`-tagged messages could — every `job.log` line is forwarded as a
 *   normal appended line here.
 * - The worker's `CommandBuilder.build_command` only ever runs
 *   `config_contents[0]` — it doesn't support a multi-model pipeline
 *   (top-down centroid + centered-instance) as a single job. This store
 *   reproduces the old one-`JOB_COMPLETE`-per-model UX by submitting one
 *   job per model sequentially instead (see `submitJob`/`submitSingleJob`).
 * - `job.result` only ever carries `{ blobs: {} }` — the worker doesn't
 *   implement `blobs.*` yet (that's stage 1.10). A submitted job's
 *   `JobResult.outputPath` is therefore always `undefined` for now; there
 *   is no way yet to fetch a remote job's output/predictions back to this
 *   client. Submission, live log, and cancel/stop all work today.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { FileEntry, JobResult, JobSpec, TrainJobSpec } from "@/lib/sleapConnect";
import { APP_VERSION } from "@/lib/version";
import { isTauri } from "@/platform/index";
import type { AgentInfo } from "@/lib/protocolV1/envelope";
import type { Mount, WorkerClient, WorkerEvent } from "@/lib/protocolV1/client";

const AGENT_INFO: AgentInfo = {
  name: "sleap-app",
  version: APP_VERSION,
  platform: isTauri ? "tauri" : "web",
};

// ── Types ─────────────────────────────────────────────────────────

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

/** A worker this device has paired with — persisted, Syncthing/Plex-style. */
export interface PairedWorker {
  nodeId: string;
  label: string;
  addrs: string[];
  pairedAt: string;
}

/** The JSON a worker's `sleap-rtc pair` command prints (spec §3.2). */
export interface PairingTicket {
  node_id: string;
  addrs: string[];
  secret: string;
  expires_at?: string;
}

interface ConnectState {
  // ── Persisted ──────────────────────────────────────────────────
  pairedWorkers: PairedWorker[];
  selectedWorkerId: string | null;
  currentJobId: string | null;

  // ── Runtime (not persisted) ─────────────────────────────────────
  connectionStatus: ConnectionStatus;
  connectionError: string | null;
  workerMounts: Mount[];
  _client: WorkerClient | null;

  // ── Actions ──────────────────────────────────────────────────────
  /** Claim a fresh pairing ticket (JSON from `sleap-rtc pair`) and connect. */
  pairWithTicket: (ticketJson: string, addrOverride?: string) => Promise<void>;
  /** Reconnect to an already-paired worker by node_id. */
  connectToWorker: (nodeId: string) => Promise<void>;
  /** Select (and connect to) a paired worker, or `null` to disconnect. */
  selectWorker: (nodeId: string | null) => Promise<void>;
  disconnect: () => void;
  forgetWorker: (nodeId: string) => void;
  browseRemoteDir: (path: string) => Promise<FileEntry[]>;
  submitJob: (
    spec: JobSpec,
    onProgress: (line: string, isCarriageReturn?: boolean) => void,
    options?: { onModelComplete?: (result: JobResult) => void },
  ) => Promise<JobResult>;
  /** Hard-cancel the current job. */
  cancelJob: () => void;
  /** Gracefully early-stop the current job (checkpoint + finish). */
  stopJob: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────

function upsertWorker(existing: PairedWorker[], next: PairedWorker): PairedWorker[] {
  return [...existing.filter((w) => w.nodeId !== next.nodeId), next];
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

async function makeClient(url: string): Promise<WorkerClient> {
  const { getClientIdentity } = await import("@/lib/protocolV1/identity");
  const { WorkerClient: WorkerClientCtor } = await import("@/lib/protocolV1/client");
  const identity = await getClientIdentity();
  return new WorkerClientCtor({ url, identity, agent: AGENT_INFO });
}

/**
 * Submits one job and resolves once it reaches a terminal state, forwarding
 * `job.log` lines to `onProgress` as they arrive. `since_seq: 0` (full
 * history) is safe here since this always subscribes right after submitting
 * a brand-new job — there's no backlog to miss.
 */
async function submitSingleJob(
  client: WorkerClient,
  spec: JobSpec,
  onProgress: (line: string, isCarriageReturn?: boolean) => void,
  set: (partial: Partial<ConnectState>) => void,
): Promise<JobResult> {
  const { jobId } = await client.jobsSubmit(spec as unknown as Record<string, unknown>);
  set({ currentJobId: jobId });

  return new Promise<JobResult>((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    let settled = false;

    const finish = (result: JobResult) => {
      if (settled) return;
      settled = true;
      unsubscribe?.();
      resolve(result);
    };

    const handleEvent = (event: WorkerEvent) => {
      if (event.topic === "job.log") {
        onProgress((event.data.line as string) ?? "", false);
      } else if (event.topic === "job.status") {
        const state = event.data.state as string;
        if (state === "completed") {
          finish({ jobId, success: true });
        } else if (state === "failed" || state === "canceled") {
          finish({ jobId, success: false, error: (event.data.detail as string) ?? `Job ${state}` });
        }
      }
    };

    client
      .jobsSubscribe(jobId, 0, handleEvent)
      .then((unsub) => {
        if (settled) unsub();
        else unsubscribe = unsub;
      })
      .catch((err: unknown) => {
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
      currentJobId: null,

      connectionStatus: "disconnected",
      connectionError: null,
      workerMounts: [],
      _client: null,

      pairWithTicket: async (ticketJson, addrOverride) => {
        let ticket: PairingTicket;
        try {
          ticket = JSON.parse(ticketJson);
        } catch {
          throw new Error("That doesn't look like a valid pairing ticket (invalid JSON).");
        }
        if (!ticket.node_id || !ticket.secret) {
          throw new Error("Pairing ticket is missing node_id or secret.");
        }
        const addr = addrOverride || ticket.addrs?.[0];
        if (!addr) {
          throw new Error(
            "This ticket has no worker address — enter one (e.g. ws://192.168.1.42:9631).",
          );
        }

        get()._client?.close();
        set({ connectionStatus: "connecting", connectionError: null });

        try {
          const client = await makeClient(addr);
          await client.connect();
          await client.pairClaim(ticket.secret);
          const mounts = await client.fsMounts();

          const paired: PairedWorker = {
            nodeId: ticket.node_id,
            label: `Worker ${ticket.node_id.slice(0, 8)}`,
            addrs: [addr, ...(ticket.addrs ?? []).filter((a) => a !== addr)],
            pairedAt: new Date().toISOString(),
          };

          set((state) => ({
            pairedWorkers: upsertWorker(state.pairedWorkers, paired),
            selectedWorkerId: paired.nodeId,
            connectionStatus: "connected",
            connectionError: null,
            workerMounts: mounts,
            currentJobId: null,
            _client: client,
          }));
        } catch (err) {
          set({
            connectionStatus: "error",
            connectionError: err instanceof Error ? err.message : String(err),
            _client: null,
          });
          throw err;
        }
      },

      connectToWorker: async (nodeId) => {
        const worker = get().pairedWorkers.find((w) => w.nodeId === nodeId);
        if (!worker) {
          throw new Error("Unknown worker — pair with it first.");
        }
        const addr = worker.addrs[0];
        if (!addr) {
          throw new Error(`No known address for ${worker.label}.`);
        }

        get()._client?.close();
        set({ selectedWorkerId: nodeId, connectionStatus: "connecting", connectionError: null });

        try {
          const client = await makeClient(addr);
          await client.connect();
          await client.authProve();
          const mounts = await client.fsMounts();

          set({
            connectionStatus: "connected",
            connectionError: null,
            workerMounts: mounts,
            currentJobId: null,
            _client: client,
          });
        } catch (err) {
          set({
            connectionStatus: "error",
            connectionError: err instanceof Error ? err.message : String(err),
            _client: null,
          });
          throw err;
        }
      },

      selectWorker: async (nodeId) => {
        if (nodeId === null) {
          get().disconnect();
          return;
        }
        await get().connectToWorker(nodeId);
      },

      disconnect: () => {
        get()._client?.close();
        set({
          connectionStatus: "disconnected",
          connectionError: null,
          workerMounts: [],
          currentJobId: null,
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
        const { _client } = get();
        if (!_client || !_client.authenticated) {
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
            finalResult = await submitSingleJob(_client, perModelSpec, onProgress, set);
            if (!finalResult.success) return finalResult;
            // Only intermediate models fire onModelComplete — matching the
            // old JOB_COMPLETE-per-model semantics, the LAST model's
            // completion is just the resolved return value.
            if (i < n - 1) options?.onModelComplete?.(finalResult);
          }
          return finalResult;
        }

        return submitSingleJob(_client, spec, onProgress, set);
      },

      cancelJob: () => {
        const { _client, currentJobId } = get();
        if (_client && currentJobId) {
          _client
            .jobsCancel(currentJobId, "cancel")
            .catch((err: unknown) => console.warn("[connect] jobsCancel failed:", err));
        }
      },

      stopJob: () => {
        const { _client, currentJobId } = get();
        if (_client && currentJobId) {
          _client
            .jobsCancel(currentJobId, "stop")
            .catch((err: unknown) => console.warn("[connect] jobsCancel(stop) failed:", err));
        }
      },
    }),
    {
      name: "sleap-app-connect",
      partialize: (state) => ({
        pairedWorkers: state.pairedWorkers,
        selectedWorkerId: state.selectedWorkerId,
        currentJobId: state.currentJobId,
      }),
    },
  ),
);
