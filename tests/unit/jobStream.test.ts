import { describe, it, expect } from "../bun-test";
import { initialJobStream, reduceJobEvents, type JobStreamState } from "@/lib/jobStream";
import type { WorkerEvent } from "@/lib/protocolV1/client";

function ev(seq: number, topic: string, data: Record<string, unknown>): WorkerEvent {
  return { topic, seq, jobId: "job_1", data };
}

describe("jobStream", () => {
  describe("initialJobStream", () => {
    it("starts unknown, empty, with a pending model labeled as given", () => {
      const state = initialJobStream("Train centroid");
      expect(state.status).toBe("unknown");
      expect(state.detail).toBeNull();
      expect(state.log).toEqual([]);
      expect(state.result).toBeNull();
      expect(state.lastSeq).toBe(0);
      expect(state.model.label).toBe("Train centroid");
      expect(state.model.status).toBe("pending");
      expect(state.model.epoch).toBe(0);
    });
  });

  describe("reduceJobEvents", () => {
    it("infers batches-per-epoch from the curve so epoch points line up with batches", () => {
      const curveTo = (last: number) =>
        Array.from({ length: last + 1 }, (_, x) => ({ x, y: 1 / (x + 1) }));
      const events: WorkerEvent[] = [];
      let seq = 0;
      // 5 epochs of 100 batches; the curve is sampled a bit before each epoch ends.
      for (let epoch = 0; epoch < 5; epoch++) {
        events.push(ev(++seq, "job.curve", { points: curveTo(epoch * 100 + 95) }));
        events.push(ev(++seq, "job.epoch", { epoch, train_loss: 0.1, val_loss: 0.1 }));
      }
      const mid = reduceJobEvents(initialJobStream("Train"), events);
      expect(mid.model.epochSize).toBeGreaterThan(90); // live estimate, not the default 1

      const done = reduceJobEvents(mid, [
        ev(++seq, "job.curve", { points: curveTo(499) }),
        ev(++seq, "job.status", { state: "completed" }),
      ]);
      expect(done.model.epochSize).toBe(100); // exact once the curve is complete
    });

    it("replays a full recorded sequence into the expected final state", () => {
      const events: WorkerEvent[] = [
        ev(1, "job.status", { state: "queued" }),
        ev(2, "job.status", { state: "running" }),
        ev(3, "job.log", { line: "Epoch 0:  40%|####", progress: true }),
        ev(4, "job.log", { line: "Epoch 0: 100%|####", progress: true }),
        ev(5, "job.epoch", { epoch: 0, train_loss: 0.5, val_loss: 0.4 }),
        ev(6, "job.curve", { points: [{ x: 0, y: 1 }, { x: 1, y: 0.8 }] }),
        ev(7, "job.metric", { epoch: 1, total_epochs: 50, latest_train_loss: 0.45 }),
        ev(8, "job.curve", { points: [{ x: 0, y: 1 }, { x: 1, y: 0.8 }, { x: 2, y: 0.6 }] }),
        ev(9, "job.result", { blobs: { predictions: { sha256: "abc", size: 1 } }, model_dir: "/m" }),
        ev(10, "job.status", { state: "completed" }),
      ];

      const state = reduceJobEvents(initialJobStream("Train centroid"), events);

      expect(state.status).toBe("completed");
      expect(state.detail).toBeNull();
      expect(state.lastSeq).toBe(10);
      // Both job.log lines are in-place progress-bar redraws — one line, not two.
      expect(state.log).toEqual(["Epoch 0: 100%|####"]);
      expect(state.model.epoch).toBe(1);
      expect(state.model.epochSamples).toEqual([{ epoch: 0, trainLoss: 0.5, valLoss: 0.4 }]);
      // job.metric's latest_train_loss (0.45) is the last word on `loss`.
      expect(state.model.loss).toBe(0.45);
      expect(state.model.valLoss).toBe(0.4);
      expect(state.model.bestValLoss).toBe(0.4);
      expect(state.model.maxEpochs).toBe(50);
      // The whole curve replaces each time — only the LAST job.curve's points remain.
      expect(state.model.batchSamples).toEqual([
        { globalBatch: 0, loss: 1 },
        { globalBatch: 1, loss: 0.8 },
        { globalBatch: 2, loss: 0.6 },
      ]);
      expect(state.result).toEqual({
        blobs: { predictions: { sha256: "abc", size: 1 } },
        model_dir: "/m",
      });
    });

    it("dedupes a reconnect backlog overlap by seq", () => {
      const first = reduceJobEvents(initialJobStream("Inference"), [
        ev(1, "job.epoch", { epoch: 0, train_loss: 0.5, val_loss: null }),
      ]);
      // A reconnect replays everything since lastSeq (exclusive) — a backlog
      // that repeats an already-applied seq (or an older one) must be a no-op.
      const replayed = reduceJobEvents(first, [
        ev(1, "job.epoch", { epoch: 0, train_loss: 0.5, val_loss: null }),
        ev(0, "job.status", { state: "running" }),
      ]);
      expect(replayed).toEqual(first);
      expect(replayed.model.epochSamples).toHaveLength(1);
    });

    it("ignores unparseable telemetry but still advances lastSeq", () => {
      const state = reduceJobEvents(initialJobStream("Inference"), [
        ev(1, "job.epoch", { train_loss: 1 }), // no epoch: parseJobTelemetry drops it
      ]);
      expect(state.lastSeq).toBe(1);
      expect(state.model.epochSamples).toEqual([]);
    });

    it("clears detail once the job reaches completed, keeps it for failed/canceled", () => {
      const failed = reduceJobEvents(initialJobStream("Inference"), [
        ev(1, "job.status", { state: "failed", detail: "exit code 1" }),
      ]);
      expect(failed.status).toBe("failed");
      expect(failed.detail).toBe("exit code 1");

      const completed = reduceJobEvents(failed, [
        ev(2, "job.status", { state: "completed", detail: "stale" }),
      ]);
      expect(completed.status).toBe("completed");
      expect(completed.detail).toBeNull();
    });

    it("forwards job.log's progress flag through mergeLogLines (plain lines append, don't collapse)", () => {
      const state = reduceJobEvents(initialJobStream("Inference"), [
        ev(1, "job.log", { line: "starting" }),
        ev(2, "job.log", { line: "still going" }),
      ]);
      expect(state.log).toEqual(["starting", "still going"]);
    });

    it("an event batch applied incrementally (as useJobStream would) matches one applied all at once", () => {
      const events: WorkerEvent[] = [
        ev(1, "job.status", { state: "running" }),
        ev(2, "job.epoch", { epoch: 0, train_loss: 0.9, val_loss: null }),
        ev(3, "job.epoch", { epoch: 1, train_loss: 0.7, val_loss: 0.6 }),
      ];
      const allAtOnce = reduceJobEvents(initialJobStream("Inference"), events);
      let incremental: JobStreamState = initialJobStream("Inference");
      for (const event of events) {
        incremental = reduceJobEvents(incremental, [event]);
      }
      expect(incremental).toEqual(allAtOnce);
    });
  });
});
