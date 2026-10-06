/**
 * Connect window §4b.3 — the left-column list of paired workers: a status
 * dot (idle/busy/offline, or a flagged identity mismatch), the GPU specs
 * line (`worker.info`, refreshed by ConnectDialog on open), route, filter
 * chips, "+ Pair worker", and the empty state.
 *
 * Selecting a card only changes which worker THIS WINDOW shows (`onSelect`,
 * owned by `ConnectDialog`) — it never touches connectStore's
 * `selectedWorkerId` (the app's actual training/inference backend, owned by
 * `BackendPicker`).
 */
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import type { WorkerInfo } from "@/lib/protocolV1/client";
import type { LinkStatus } from "@/lib/protocolV1/managedConnection";
import { transportLabel, type TransportKind } from "@/lib/protocolV1/transport";
import { useConnectStore } from "@/stores/connectStore";
import { PairWorkerForm } from "./PairWorkerForm";

export type WorkerStatusBucket = "idle" | "busy" | "offline";

export interface WorkerStatusInfo {
  bucket: WorkerStatusBucket;
  dotClass: string;
  label: string;
  identityMismatch: boolean;
}

const IDENTITY_MISMATCH_MARKER = "identified itself as a different node";

/** Pure classification of one worker's card status — directly unit-testable. */
export function classifyWorkerStatus(
  connection: { status: LinkStatus; route: TransportKind } | undefined,
  error: string | null | undefined,
  busy: boolean | undefined,
): WorkerStatusInfo {
  if (error?.includes(IDENTITY_MISMATCH_MARKER)) {
    return {
      bucket: "offline",
      dotClass: "bg-red-500",
      label: "has a new identity",
      identityMismatch: true,
    };
  }
  switch (connection?.status) {
    case "connected":
      return busy
        ? { bucket: "busy", dotClass: "bg-orange-500", label: "Busy", identityMismatch: false }
        : { bucket: "idle", dotClass: "bg-green-500", label: "Idle", identityMismatch: false };
    case "reconnecting":
      return { bucket: "offline", dotClass: "bg-amber-500", label: "Reconnecting…", identityMismatch: false };
    case "connecting":
      return { bucket: "offline", dotClass: "bg-yellow-500", label: "Connecting…", identityMismatch: false };
    default:
      return { bucket: "offline", dotClass: "bg-zinc-500", label: "Offline", identityMismatch: false };
  }
}

/** `gpuModel · N GB ×count · CUDA x · sleap-nn y`, or `null` while unknown (not yet refreshed). */
export function workerSpecsLine(info: WorkerInfo | undefined): string | null {
  if (!info) return null;
  const gb = info.gpuMemoryMb / 1024;
  const gbText = Number.isInteger(gb) ? gb.toFixed(0) : gb.toFixed(1);
  return `${info.gpuModel} · ${gbText} GB ×${info.gpuCount} · CUDA ${info.cudaVersion} · sleap-nn ${info.sleapNnVersion}`;
}

const FILTERS: Array<{ key: "all" | WorkerStatusBucket; label: string }> = [
  { key: "all", label: "All" },
  { key: "idle", label: "Idle" },
  { key: "busy", label: "Busy" },
  { key: "offline", label: "Offline" },
];

export interface WorkerListProps {
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function WorkerList({ selectedId, onSelect }: WorkerListProps) {
  const pairedWorkers = useConnectStore((s) => s.pairedWorkers);
  const connections = useConnectStore((s) => s.connections);
  const workerErrors = useConnectStore((s) => s.workerErrors);
  const workerInfo = useConnectStore((s) => s.workerInfo);
  const forgetWorker = useConnectStore((s) => s.forgetWorker);

  const [filter, setFilter] = useState<"all" | WorkerStatusBucket>("all");
  const [showPairForm, setShowPairForm] = useState(false);
  // The worker whose "Re-pair" is currently showing its own PairWorkerForm —
  // at most one at a time (a second worker's identity changing while this is
  // open just replaces which card owns it).
  const [repairingId, setRepairingId] = useState<string | null>(null);

  const statuses = useMemo(() => {
    const map = new Map<string, WorkerStatusInfo>();
    for (const w of pairedWorkers) {
      map.set(
        w.nodeId,
        classifyWorkerStatus(connections[w.nodeId], workerErrors[w.nodeId], workerInfo[w.nodeId]?.busy),
      );
    }
    return map;
  }, [pairedWorkers, connections, workerErrors, workerInfo]);

  const counts = useMemo(() => {
    const c: Record<WorkerStatusBucket, number> = { idle: 0, busy: 0, offline: 0 };
    for (const s of statuses.values()) c[s.bucket]++;
    return c;
  }, [statuses]);

  const filtered =
    filter === "all"
      ? pairedWorkers
      : pairedWorkers.filter((w) => statuses.get(w.nodeId)?.bucket === filter);

  return (
    <div className="p-2 space-y-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
          Paired workers ({pairedWorkers.length})
        </span>
        <Button
          size="xs"
          variant="outline"
          className="h-6 text-[10px]"
          onClick={() => setShowPairForm((v) => !v)}
        >
          + Pair worker
        </Button>
      </div>

      {showPairForm && (
        <PairWorkerForm
          showCancel
          onPaired={() => setShowPairForm(false)}
          onCancel={() => setShowPairForm(false)}
        />
      )}

      {pairedWorkers.length === 0 ? (
        <div className="p-3 space-y-1.5 text-[11px] text-muted-foreground">
          <p>No workers paired yet. On the machine you want to train/infer on:</p>
          <code className="block bg-black/30 px-1.5 py-1 rounded font-mono text-[10px]">
            sleap-rtc serve --daemonize
          </code>
          <code className="block bg-black/30 px-1.5 py-1 rounded font-mono text-[10px]">
            sleap-rtc pair
          </code>
          <p>Then paste the one-line code it prints below.</p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-1 px-1">
            {FILTERS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFilter(f.key)}
                className={`px-2 py-0.5 rounded-full text-[10px] border transition-colors ${
                  filter === f.key
                    ? "bg-primary/10 border-primary text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                {f.label} ({f.key === "all" ? pairedWorkers.length : counts[f.key]})
              </button>
            ))}
          </div>

          <div className="space-y-1.5">
            {filtered.map((w) => {
              const status = statuses.get(w.nodeId)!;
              const specs = workerSpecsLine(workerInfo[w.nodeId]);
              const route = connections[w.nodeId]?.route;
              const isSelected = selectedId === w.nodeId;
              return (
                <div key={w.nodeId} className="space-y-1">
                  <button
                    type="button"
                    onClick={() => onSelect(w.nodeId)}
                    className={`w-full text-left rounded-md p-2 transition-colors ${
                      isSelected
                        ? "bg-primary/10 border border-primary"
                        : "border border-border bg-zinc-800/50"
                    }`}
                  >
                    <div className="flex items-center gap-1.5 text-xs font-medium">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${status.dotClass}`} />
                      <span className="truncate">{w.label}</span>
                      <span className="ml-auto text-[10px] text-muted-foreground shrink-0">
                        {status.label}
                      </span>
                    </div>
                    {specs && (
                      <div className="text-[10px] text-muted-foreground font-mono mt-0.5 truncate">
                        {specs}
                      </div>
                    )}
                    {route && status.bucket !== "offline" && (
                      <div className="text-[10px] text-muted-foreground mt-0.5">
                        via {transportLabel(route)}
                      </div>
                    )}
                  </button>

                  {status.identityMismatch && repairingId !== w.nodeId && (
                    <div className="px-2 flex items-center gap-2 text-[10px] text-red-400">
                      <span>{w.label} has a new identity.</span>
                      <Button
                        size="xs"
                        variant="outline"
                        className="h-5 text-[10px]"
                        onClick={() => setRepairingId(w.nodeId)}
                      >
                        Re-pair
                      </Button>
                    </div>
                  )}
                  {repairingId === w.nodeId && (
                    <PairWorkerForm
                      showCancel
                      onPaired={() => {
                        // The old (dead) identity's entry would otherwise
                        // linger forever alongside the freshly-paired one.
                        forgetWorker(w.nodeId);
                        setRepairingId(null);
                      }}
                      onCancel={() => setRepairingId(null)}
                    />
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
