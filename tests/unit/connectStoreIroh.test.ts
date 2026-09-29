/**
 * connectStore iroh transport selection (stage 2.6) — desktop (Tauri) mode.
 * The web-mode/ws-default assertions live in connectStore.test.ts; WorkerClient
 * itself is faked, as there.
 */
import { describe, it, expect, beforeEach, vi } from "../bun-test";

vi.mock("@/platform/index", () => ({ isTauri: true }));

class FakeWorkerClient {
  static instances: FakeWorkerClient[] = [];
  peerNodeId = "worker-node-id";
  authenticated = false;
  fetchBlobCalls = 0;
  constructor(public opts: { url: string; createSocket?: (url: string) => unknown }) {
    FakeWorkerClient.instances.push(this);
  }
  async connect() {}
  async pairClaim() {
    this.authenticated = true;
  }
  async authProve() {
    this.authenticated = true;
  }
  async fsMounts() {
    return [];
  }
  async jobsStatus() {
    throw new Error("job.not_found");
  }
  async fetchBlob() {
    this.fetchBlobCalls++;
    return new Uint8Array([1]);
  }
  close() {}
}

vi.mock("@/lib/protocolV1/identity", () => ({
  getClientIdentity: async () => ({ nodeId: "client-node-id", sign: async () => "sig" }),
}));
vi.mock("@/lib/protocolV1/client", () => ({ WorkerClient: FakeWorkerClient }));

const TICKET_WITH_IROH = JSON.stringify({
  node_id: "worker-node-id",
  addrs: ["ws://192.168.1.42:9631"],
  secret: "s",
  iroh: { node_id: "iroh-id", relay_url: "https://relay.example", direct_addrs: ["1.2.3.4:5"] },
});
const TICKET_NO_IROH = JSON.stringify({
  node_id: "worker-node-id",
  addrs: ["ws://192.168.1.42:9631"],
  secret: "s",
});

function last(): FakeWorkerClient {
  return FakeWorkerClient.instances[FakeWorkerClient.instances.length - 1];
}

async function store() {
  return (await import("@/stores/connectStore")).useConnectStore;
}

describe("connectStore iroh transport (desktop)", () => {
  beforeEach(async () => {
    FakeWorkerClient.instances.length = 0;
    (await store()).setState({
      pairedWorkers: [],
      selectedWorkerId: null,
      currentJob: null,
      connectionStatus: "disconnected",
      connectionError: null,
      workerMounts: [],
      reattachableJob: null,
      activeTransport: null,
      _client: null,
    });
  });

  it("dials the iroh endpoint via the tauri iroh socket when explicitly requested", async () => {
    const s = await store();
    await s.getState().pairWithTicket(TICKET_WITH_IROH, undefined, { transport: "iroh" });

    const client = last();
    expect(typeof client.opts.createSocket).toBe("function");
    expect(JSON.parse(client.opts.url)).toEqual({
      nodeId: "iroh-id",
      relayUrl: "https://relay.example",
      directAddrs: ["1.2.3.4:5"],
    });
    const state = s.getState();
    expect(state.activeTransport).toBe("iroh");
    expect(state.connectionStatus).toBe("connected");
    expect(state.pairedWorkers[0].transport).toBe("iroh");
  });

  it("falls back to the protocol node_id when the iroh section omits one", async () => {
    const s = await store();
    const ticket = JSON.stringify({
      node_id: "worker-node-id",
      secret: "s",
      iroh: { relay_url: "https://relay.example" },
    });
    await s.getState().pairWithTicket(ticket, undefined, { transport: "iroh" });
    expect(JSON.parse(last().opts.url).nodeId).toBe("worker-node-id");
  });

  it("stays on ws by default even in the desktop app", async () => {
    const s = await store();
    await s.getState().pairWithTicket(TICKET_WITH_IROH);
    expect(last().opts.url).toBe("ws://192.168.1.42:9631");
    expect(last().opts.createSocket).toBeUndefined();
    expect(s.getState().activeTransport).toBe("ws");
  });

  it("rejects an iroh connect for a ticket without an iroh section", async () => {
    const s = await store();
    await expect(
      s.getState().pairWithTicket(TICKET_NO_IROH, undefined, { transport: "iroh" }),
    ).rejects.toThrow(/no direct \(iroh\)/);
    expect(FakeWorkerClient.instances).toHaveLength(0);
    expect(s.getState().connectionStatus).toBe("disconnected");
  });

  it("reconnect reuses the remembered iroh transport, and an explicit ws override wins", async () => {
    const s = await store();
    await s.getState().pairWithTicket(TICKET_WITH_IROH, undefined, { transport: "iroh" });

    await s.getState().connectToWorker("worker-node-id");
    expect(s.getState().activeTransport).toBe("iroh");
    expect(typeof last().opts.createSocket).toBe("function");

    await s.getState().connectToWorker("worker-node-id", { transport: "ws" });
    expect(s.getState().activeTransport).toBe("ws");
    expect(last().opts.url).toBe("ws://192.168.1.42:9631");
    expect(s.getState().pairedWorkers[0].transport).toBeUndefined();
  });

  it("an iroh-only pairing (no addresses) can reconnect over iroh", async () => {
    const s = await store();
    const ticket = JSON.stringify({
      node_id: "worker-node-id",
      secret: "s",
      iroh: { node_id: "iroh-id" },
    });
    await s.getState().pairWithTicket(ticket, undefined, { transport: "iroh" });
    expect(s.getState().pairedWorkers[0].addrs).toEqual([]);
    await s.getState().connectToWorker("worker-node-id");
    expect(s.getState().activeTransport).toBe("iroh");
  });

  it("fetchResultBlob gives a clear error over iroh instead of hitting the ws-only blob path", async () => {
    const s = await store();
    await s.getState().pairWithTicket(TICKET_WITH_IROH, undefined, { transport: "iroh" });
    await expect(
      s.getState().fetchResultBlob({ sha256: "abc", size: 1 } as never),
    ).rejects.toThrow(/iroh \(direct\).*WebSocket/);
    expect(last().fetchBlobCalls).toBe(0);
  });
});
