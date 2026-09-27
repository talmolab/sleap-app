/**
 * Shared "Backend: Local | Worker" picker for Train/Inference — replaces
 * the inline, duplicated Room+Worker selector blocks each panel/dialog had
 * right after stage 1.8's mechanical connectStore rewire. A single control
 * choosing among "Local" and each paired sleap-connect worker; picking a
 * worker connects to it. Also surfaces a reattach banner if the worker just
 * connected to still has a job this device submitted from a previous
 * session (protocol spec §3.4 — "app persists (node_id, job_id)").
 *
 * Deliberately doesn't try to resume a reattached job's live log/progress
 * into the panel — that needs deeper trainingStore/inferenceStore
 * integration than this picker owns. It only shows that the job exists and
 * lets the user cancel it.
 */
import { Button } from "@/components/ui/button";
import { HintBubble } from "@/components/HintBubble";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConnectStore } from "@/stores/connectStore";

export const LOCAL_VALUE = "__local__";

/** The Select's current value, derived from the panel's own remote/worker state. */
export function backendSelectValue(
  remoteEnabled: boolean,
  selectedWorkerId: string | null,
): string {
  return remoteEnabled && selectedWorkerId ? selectedWorkerId : LOCAL_VALUE;
}

export interface BackendChangeEffect {
  remoteEnabled: boolean;
  /** A worker to connect to, or `null` when the change was just "go local". */
  workerIdToConnect: string | null;
}

/** Pure decision logic behind picking a Select value — kept separate from
 * the Radix Select interaction so it's directly unit-testable. */
export function resolveBackendChange(value: string): BackendChangeEffect {
  if (value === LOCAL_VALUE) return { remoteEnabled: false, workerIdToConnect: null };
  return { remoteEnabled: true, workerIdToConnect: value };
}

export interface BackendPickerProps {
  /** What kind of run this is, for copy — e.g. "training job", "inference job". */
  jobLabel: string;
  remoteEnabled: boolean;
  onRemoteEnabledChange: (enabled: boolean) => void;
}

export function BackendPicker({
  jobLabel,
  remoteEnabled,
  onRemoteEnabledChange,
}: BackendPickerProps) {
  const pairedWorkers = useConnectStore((s) => s.pairedWorkers);
  const selectedWorkerId = useConnectStore((s) => s.selectedWorkerId);
  const selectWorker = useConnectStore((s) => s.selectWorker);
  const connectionStatus = useConnectStore((s) => s.connectionStatus);
  const connectionError = useConnectStore((s) => s.connectionError);
  const reattachableJob = useConnectStore((s) => s.reattachableJob);
  const cancelJob = useConnectStore((s) => s.cancelJob);

  const value = backendSelectValue(remoteEnabled, selectedWorkerId);

  const handleChange = (v: string) => {
    const effect = resolveBackendChange(v);
    onRemoteEnabledChange(effect.remoteEnabled);
    if (effect.workerIdToConnect) void selectWorker(effect.workerIdToConnect);
  };

  return (
    <div className="space-y-1.5">
      <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1">
        Backend
        <HintBubble
          text={`Run this ${jobLabel} on this machine, or send it to a paired sleap-connect worker.`}
        />
      </label>
      <Select value={value} onValueChange={handleChange}>
        <SelectTrigger className="h-7 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={LOCAL_VALUE}>Local (this machine)</SelectItem>
          {pairedWorkers.map((w) => (
            <SelectItem key={w.nodeId} value={w.nodeId}>
              {w.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {pairedWorkers.length === 0 && (
        <p className="text-[10px] text-muted-foreground">
          Pair with a worker in the Connect tab to run a {jobLabel} remotely.
        </p>
      )}

      {remoteEnabled && selectedWorkerId && (
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              connectionStatus === "connected"
                ? "bg-green-500"
                : connectionStatus === "connecting"
                  ? "bg-yellow-500"
                  : "bg-zinc-500"
            }`}
          />
          <span className="truncate">
            {connectionStatus === "connected"
              ? "Connected"
              : connectionStatus === "connecting"
                ? "Connecting…"
                : connectionStatus === "error"
                  ? `Connection failed${connectionError ? `: ${connectionError}` : ""}`
                  : "Not connected"}
          </span>
        </div>
      )}

      {remoteEnabled && reattachableJob && (
        <div className="bg-blue-500/8 border border-blue-500/20 rounded-md p-2 text-[10px] text-blue-300 space-y-1.5">
          <p>
            A {jobLabel} (<code className="font-mono">{reattachableJob.jobId}</code>) is still{" "}
            <b>{reattachableJob.state}</b> on this worker from a previous session.
          </p>
          <Button size="xs" variant="outline" className="h-6 text-[10px]" onClick={cancelJob}>
            Cancel it
          </Button>
        </div>
      )}
    </div>
  );
}
