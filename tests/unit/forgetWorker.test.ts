import { describe, it, expect, beforeEach } from "../bun-test";
import { forgetWorkerConfirm, forgetWorkerWithConfirm } from "@/components/connect/forgetWorker";
import { useConnectStore, type PairedWorker } from "@/stores/connectStore";
import { useConfirmStore } from "@/stores/confirmStore";

const WORKER: PairedWorker = {
  nodeId: "w1",
  label: "GPU box",
  addrs: [],
  pairedAt: "2026-10-23T00:00:00Z",
};

describe("forgetWorkerConfirm", () => {
  it("warns that forgetting unpairs this device on the worker", () => {
    const req = forgetWorkerConfirm(WORKER);
    expect(req.destructive).toBe(true);
    expect(req.message).toContain("GPU box");
    expect(req.message).toContain("sleap-rtc pair");
  });

  it("for an already-unpaired worker, only mentions removing it locally", () => {
    const req = forgetWorkerConfirm({ ...WORKER, unpairedAt: "2026-10-23T01:00:00Z" });
    expect(req.message).not.toContain("sleap-rtc pair");
    expect(req.message).toContain("already unpaired");
  });
});

describe("forgetWorkerWithConfirm", () => {
  let forgotten: string[];

  beforeEach(() => {
    forgotten = [];
    useConnectStore.setState({
      pairedWorkers: [WORKER],
      forgetWorker: async (id: string) => {
        forgotten.push(id);
      },
    });
  });

  async function answer(ok: boolean) {
    const pending = forgetWorkerWithConfirm("w1");
    await Promise.resolve();
    expect(useConfirmStore.getState().request?.title).toBe("Forget worker?");
    useConfirmStore.getState().respond(ok);
    return pending;
  }

  it("does nothing when the user cancels", async () => {
    expect(await answer(false)).toBe(false);
    expect(forgotten).toEqual([]);
  });

  it("forgets when the user confirms", async () => {
    expect(await answer(true)).toBe(true);
    expect(forgotten).toEqual(["w1"]);
  });
});
