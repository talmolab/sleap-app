/**
 * Pure replay/live reducer for one worker job's event stream — the Connect
 * window's per-job viewer (`JobViewerDialog`, PR4b §4b.6), fed by
 * `useJobStream` (PR4a §4a.6). Unlike `trainingStore`'s `applyRemoteTelemetry`
 * (a THIS-WINDOW-submitted job, live, with wall-clock runtime metrics via
 * `computeRuntimeMetrics`), this reducer only ever sees whatever the worker
 * replays from its own history plus whatever arrives live afterward — there
 * are no timestamps to compute "Epoch Runtime"/ETA from, so `ModelProgress`'s
 * `metrics`/`epochStartedAt` are left at their empty defaults throughout.
 *
 * `reduceJobEvents` is a plain fold: no zustand, no `Date.now()`, no module
 * state — a batch of events in, a new state out, in event order, deduped by
 * `seq` the same way `connectStore`'s own job subscriptions are (see
 * `submitSingleJob`/`resumeTrackedJobs`).
 */
import type { WorkerEvent } from "@/lib/protocolV1/client";
import { parseJobTelemetry } from "@/lib/protocolV1/jobTelemetry";
import {
  emptyModelProgress,
  mergeLogLines,
  type BatchSample,
  type EpochSample,
  type ModelProgress,
} from "@/stores/trainingStore";

export type JobStreamStatus =
  | "unknown"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "canceled";

const KNOWN_STATUSES = new Set<JobStreamStatus>([
  "queued",
  "running",
  "completed",
  "failed",
  "canceled",
]);

export interface JobStreamState {
  status: JobStreamStatus;
  /** The worker's failure/cancel detail, if any — cleared on "completed". */
  detail: string | null;
  log: string[];
  progressTail: string | null;
  /** For `LossPlot`/`LossViewerDialog` — timing fields stay empty (see module doc). */
  model: ModelProgress;
  result: Record<string, unknown> | null;
  /** Highest event `seq` applied so far — `reduceJobEvents` ignores anything at or below this. */
  lastSeq: number;
}

export function initialJobStream(label: string): JobStreamState {
  return {
    status: "unknown",
    detail: null,
    log: [],
    progressTail: null,
    model: emptyModelProgress(label),
    result: null,
    lastSeq: 0,
  };
}

function parseStatus(raw: unknown): JobStreamStatus | null {
  return typeof raw === "string" && KNOWN_STATUSES.has(raw as JobStreamStatus)
    ? (raw as JobStreamStatus)
    : null;
}

function applyTelemetry(
  model: ModelProgress,
  telemetry: NonNullable<ReturnType<typeof parseJobTelemetry>>,
): ModelProgress {
  switch (telemetry.kind) {
    case "epoch": {
      const sample: EpochSample = {
        epoch: telemetry.epoch,
        trainLoss: telemetry.trainLoss,
        valLoss: telemetry.valLoss,
      };
      return {
        ...model,
        epochSamples: [...model.epochSamples, sample],
        epoch: telemetry.epoch + 1,
        loss: telemetry.trainLoss ?? model.loss,
        valLoss: telemetry.valLoss ?? model.valLoss,
        bestValLoss:
          telemetry.valLoss != null &&
          (model.bestValLoss === null || telemetry.valLoss < model.bestValLoss)
            ? telemetry.valLoss
            : model.bestValLoss,
      };
    }
    case "curve": {
      // The whole curve every time, same as trainingStore's applyRemoteTelemetry: replace, never append.
      const batchSamples: BatchSample[] = telemetry.points.map((p) => ({
        globalBatch: p.x,
        loss: p.y,
      }));
      return { ...model, batchSamples };
    }
    case "metric":
      return {
        ...model,
        maxEpochs:
          telemetry.totalEpochs != null && telemetry.totalEpochs > 0
            ? telemetry.totalEpochs
            : model.maxEpochs,
        loss: telemetry.latestTrainLoss ?? model.loss,
      };
  }
}

/**
 * Batches per epoch, inferred from the curve: `LossPlot` places epoch points
 * at `epoch * epochSize` on the batch axis, and remote telemetry carries no
 * batch index (same inference as `trainingStore.applyRemoteTelemetry`).
 * `exact` (the job finished, so the curve ends at the last epoch's end)
 * replaces the running estimate instead of only ever growing it.
 */
function withEpochSize(model: ModelProgress, exact = false): ModelProgress {
  const lastX = model.batchSamples[model.batchSamples.length - 1]?.globalBatch;
  const lastEpoch = model.epochSamples[model.epochSamples.length - 1]?.epoch;
  if (lastX === undefined || lastEpoch === undefined) return model;
  const estimate = Math.max(1, Math.round((lastX + 1) / (lastEpoch + 1)));
  if (exact) return estimate === model.epochSize ? model : { ...model, epochSize: estimate };
  return estimate > model.epochSize ? { ...model, epochSize: estimate } : model;
}

function reduceOne(state: JobStreamState, event: WorkerEvent): JobStreamState {
  if (event.seq <= state.lastSeq) return state; // reconnect backlog overlap / out-of-order
  const lastSeq = event.seq;

  switch (event.topic) {
    case "job.log": {
      const { log, progressTail } = mergeLogLines(
        state.log,
        [{ line: (event.data.line as string) ?? "", progress: event.data.progress === true }],
        state.progressTail,
      );
      return { ...state, log, progressTail, lastSeq };
    }
    case "job.status": {
      const status = parseStatus(event.data.state) ?? state.status;
      const detail = (event.data.detail as string | undefined) ?? null;
      const model = status === "completed" ? withEpochSize(state.model, true) : state.model;
      return { ...state, status, model, detail: status === "completed" ? null : detail, lastSeq };
    }
    case "job.result":
      return { ...state, result: event.data, lastSeq };
    default: {
      const telemetry = parseJobTelemetry(event);
      if (!telemetry) return { ...state, lastSeq };
      const model = applyTelemetry(state.model, telemetry);
      return { ...state, model: telemetry.kind === "epoch" ? withEpochSize(model) : model, lastSeq };
    }
  }
}

/** Folds `events` (in order) into `state` — pure, batch-safe, dedupes by `seq`. */
export function reduceJobEvents(state: JobStreamState, events: WorkerEvent[]): JobStreamState {
  return events.reduce(reduceOne, state);
}
