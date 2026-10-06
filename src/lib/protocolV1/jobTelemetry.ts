/**
 * Typed parsers for a training job's structured telemetry events
 * (`job.epoch`, `job.curve`, `job.metric`) — the worker → app contract from
 * talmolab/sleap-connect's feat/remote-training-telemetry. Each returns
 * `null` for a payload that doesn't match, so a malformed or future-shaped
 * event is dropped instead of corrupting the training monitor.
 */
import type { WorkerEvent } from "./client";

/** One completed epoch — maps 1:1 to local training's ZMQ `epoch_end`. */
export interface JobEpochTelemetry {
  kind: "epoch";
  /** 0-based, same as local `epoch_end`. */
  epoch: number;
  trainLoss: number | null;
  valLoss: number | null;
}

/** The WHOLE batch-loss curve so far (downsampled) — replaces, never appends. */
export interface JobCurveTelemetry {
  kind: "curve";
  points: Array<{ x: number; y: number }>;
}

/** Throttled summary — header numbers / ETA / W&B link, not for plotting. */
export interface JobMetricTelemetry {
  kind: "metric";
  epoch: number | null;
  totalEpochs: number | null;
  latestTrainLoss: number | null;
  latestValLoss: number | null;
  bestLoss: number | null;
  wandbUrl: string | null;
  etaSeconds: number | null;
}

export type JobTelemetry = JobEpochTelemetry | JobCurveTelemetry | JobMetricTelemetry;

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function parseJobTelemetry(event: Pick<WorkerEvent, "topic" | "data">): JobTelemetry | null {
  const d = event.data ?? {};
  switch (event.topic) {
    case "job.epoch": {
      const epoch = num(d.epoch);
      if (epoch === null) return null;
      return { kind: "epoch", epoch, trainLoss: num(d.train_loss), valLoss: num(d.val_loss) };
    }
    case "job.curve": {
      if (!Array.isArray(d.points)) return null;
      const points: Array<{ x: number; y: number }> = [];
      for (const p of d.points as unknown[]) {
        const x = num((p as { x?: unknown } | null)?.x);
        const y = num((p as { y?: unknown } | null)?.y);
        if (x !== null && y !== null) points.push({ x, y });
      }
      return { kind: "curve", points };
    }
    case "job.metric":
      return {
        kind: "metric",
        epoch: num(d.epoch),
        totalEpochs: num(d.total_epochs),
        latestTrainLoss: num(d.latest_train_loss),
        latestValLoss: num(d.latest_val_loss),
        bestLoss: num(d.best_loss),
        wandbUrl: typeof d.wandb_url === "string" && d.wandb_url ? d.wandb_url : null,
        etaSeconds: num(d.eta_seconds),
      };
    default:
      return null;
  }
}
