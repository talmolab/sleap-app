import { describe, it, expect, afterEach, vi } from "../bun-test";
import { renderHook, act, cleanup, waitFor } from "@testing-library/react";
import type { WorkerEvent } from "@/lib/protocolV1/client";

// useJobStream reaches the worker only through connectStore.clientFor — this
// fake stands in for the connected WorkerClient it resolves to, matching
// this repo's "class tests + thin integration" default for wiring code
// (connectStore's own clientFor behavior is covered by connectStore.test.ts).
class FakeJobClient {
  jobsSubscribeCalls: Array<[string, number]> = [];
  unsubscribeCalls = 0;
  /** Delivered to the listener synchronously inside jobsSubscribe, before it
   *  resolves — mirrors the real WorkerClient's replay-then-respond order. */
  backlog: WorkerEvent[] = [];
  private handler: ((event: WorkerEvent) => void) | null = null;

  async jobsSubscribe(jobId: string, sinceSeq: number, onEvent: (event: WorkerEvent) => void) {
    this.jobsSubscribeCalls.push([jobId, sinceSeq]);
    this.handler = onEvent;
    for (const event of this.backlog) onEvent(event);
    return () => {
      this.unsubscribeCalls++;
      this.handler = null;
    };
  }

  emit(event: WorkerEvent): void {
    this.handler?.(event);
  }
}

let clientForImpl: (workerId: string) => Promise<FakeJobClient> = () => {
  throw new Error("clientForImpl not configured for this test");
};

vi.mock("@/stores/connectStore", () => ({
  useConnectStore: {
    getState: () => ({
      clientFor: (workerId: string) => clientForImpl(workerId),
    }),
  },
}));

const { useJobStream } = await import("@/hooks/useJobStream");

function ev(seq: number, topic: string, data: Record<string, unknown> = {}): WorkerEvent {
  return { topic, seq, jobId: "job_1", data };
}

describe("useJobStream", () => {
  afterEach(() => cleanup());

  it("flushes the replay backlog once jobsSubscribe resolves, without waiting for an interval tick", async () => {
    const client = new FakeJobClient();
    client.backlog = [
      ev(1, "job.status", { state: "running" }),
      ev(2, "job.epoch", { epoch: 0, train_loss: 0.5, val_loss: null }),
    ];
    clientForImpl = async () => client;

    const { result } = renderHook(() => useJobStream("worker-1", "job_1", "Train centroid"));

    await waitFor(() => expect(client.jobsSubscribeCalls).toEqual([["job_1", 0]]));
    await waitFor(() => expect(result.current.status).toBe("running"));
    expect(result.current.model.epochSamples).toEqual([
      { epoch: 0, trainLoss: 0.5, valLoss: null },
    ]);
  });

  it("buffers live events and only applies them on the injected interval tick", async () => {
    const client = new FakeJobClient();
    clientForImpl = async () => client;
    let flushTick: (() => void) | null = null;
    const setIntervalImpl = (cb: () => void) => {
      flushTick = cb;
      return "handle";
    };

    const { result } = renderHook(() =>
      useJobStream("worker-1", "job_1", "Inference", { setIntervalImpl }),
    );
    await waitFor(() => expect(flushTick).not.toBeNull());

    client.emit(ev(1, "job.status", { state: "running" }));
    // Buffered, not yet applied — the (empty) initial-backlog flush already
    // ran, and nothing else has ticked the interval.
    expect(result.current.status).toBe("unknown");

    act(() => flushTick?.());
    expect(result.current.status).toBe("running");
  });

  it("unsubscribes and clears the interval on unmount", async () => {
    const client = new FakeJobClient();
    clientForImpl = async () => client;
    const clearIntervalCalls: unknown[] = [];

    const { unmount } = renderHook(() =>
      useJobStream("worker-1", "job_1", "Inference", {
        setIntervalImpl: () => "the-handle",
        clearIntervalImpl: (handle) => clearIntervalCalls.push(handle),
      }),
    );
    await waitFor(() => expect(client.jobsSubscribeCalls).toHaveLength(1));

    unmount();
    expect(client.unsubscribeCalls).toBe(1);
    expect(clearIntervalCalls).toEqual(["the-handle"]);
  });

  it("resubscribes when jobId changes, unsubscribing the old job first", async () => {
    const clientA = new FakeJobClient();
    const clientB = new FakeJobClient();
    clientForImpl = async () => clientA;

    const { rerender } = renderHook(({ jobId }: { jobId: string }) => useJobStream("worker-1", jobId, "Inference"), {
      initialProps: { jobId: "job_1" },
    });
    await waitFor(() => expect(clientA.jobsSubscribeCalls).toEqual([["job_1", 0]]));

    clientForImpl = async () => clientB;
    rerender({ jobId: "job_2" });

    await waitFor(() => expect(clientB.jobsSubscribeCalls).toEqual([["job_2", 0]]));
    expect(clientA.unsubscribeCalls).toBe(1);
  });

  it("a failed connect/subscribe lands in status unknown with the error as detail", async () => {
    clientForImpl = async () => {
      throw new Error("worker unreachable");
    };

    const { result } = renderHook(() => useJobStream("worker-1", "job_1", "Inference"));

    await waitFor(() => expect(result.current.detail).toBe("worker unreachable"));
    expect(result.current.status).toBe("unknown");
  });
});
