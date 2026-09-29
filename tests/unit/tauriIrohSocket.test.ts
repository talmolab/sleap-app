import { describe, it, expect } from "../bun-test";
import {
  createTauriIrohSocket,
  encodeIrohDialUrl,
  type TauriIpc,
} from "@/lib/protocolV1/tauriIrohSocket";

/** Awaits a handful of microtask ticks — enough to drain this module's
 * short, loop-free `async`/`await` chains without needing fake timers. */
async function flush(ticks = 20): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

interface RecordedInvoke {
  cmd: string;
  args?: Record<string, unknown>;
}

/** A controllable fake of the Tauri IPC surface `tauriIrohSocket.ts` needs. */
function makeFakeIpc(overrides: {
  onInvoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
} = {}) {
  const calls: RecordedInvoke[] = [];
  let channelOnMessage: ((payload: unknown) => void) | null = null;

  const ipc: TauriIpc = {
    invoke: async (cmd, args) => {
      calls.push({ cmd, args });
      if (overrides.onInvoke) return overrides.onInvoke(cmd, args);
      return undefined;
    },
    createChannel: () => {
      const channel = {
        get onmessage() {
          return channelOnMessage;
        },
        set onmessage(cb) {
          channelOnMessage = cb;
        },
      };
      return channel;
    },
  };

  return {
    ipc,
    calls,
    emit: (payload: unknown) => channelOnMessage?.(payload),
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("encodeIrohDialUrl", () => {
  it("round-trips through a real connect call", async () => {
    const { ipc, calls } = makeFakeIpc();
    const createSocket = createTauriIrohSocket(async () => ipc);
    const socket = createSocket(
      encodeIrohDialUrl({ nodeId: "abc123", relayUrl: "https://relay.example", directAddrs: ["1.2.3.4:5"] }),
    );
    await flush();

    expect(socket.readyState).toBe(1);
    const connectCall = calls.find((c) => c.cmd.endsWith("iroh_connect"));
    expect(connectCall?.args?.target).toEqual({
      nodeId: "abc123",
      relayUrl: "https://relay.example",
      directAddrs: ["1.2.3.4:5"],
    });
  });
});

describe("TauriIrohSocket connect", () => {
  it("fires onopen and reaches OPEN once iroh_connect resolves", async () => {
    const { ipc } = makeFakeIpc();
    const createSocket = createTauriIrohSocket(async () => ipc);
    const socket = createSocket(encodeIrohDialUrl({ nodeId: "node-1" }));

    let opened = false;
    socket.onopen = () => {
      opened = true;
    };
    await flush();

    expect(opened).toBe(true);
    expect(socket.readyState).toBe(1);
  });

  it("fails to connect (onerror + onclose, CLOSED) on invalid dial JSON", async () => {
    const { ipc } = makeFakeIpc();
    const createSocket = createTauriIrohSocket(async () => ipc);
    const socket = createSocket("not-json");

    let erroredWith: unknown;
    let closed = false;
    socket.onerror = (e) => {
      erroredWith = e;
    };
    socket.onclose = () => {
      closed = true;
    };
    await flush();

    expect(erroredWith).toBeInstanceOf(Error);
    expect(closed).toBe(true);
    expect(socket.readyState).toBe(3);
  });

  it("fails to connect when the worker's node_id is missing", async () => {
    const { ipc } = makeFakeIpc();
    const createSocket = createTauriIrohSocket(async () => ipc);
    const socket = createSocket(JSON.stringify({}));

    let closed = false;
    socket.onclose = () => {
      closed = true;
    };
    await flush();

    expect(closed).toBe(true);
    expect(socket.readyState).toBe(3);
  });

  it("fails to connect (onerror + onclose, CLOSED) when iroh_connect rejects", async () => {
    const { ipc } = makeFakeIpc({
      onInvoke: async (cmd) => {
        if (cmd.endsWith("iroh_connect")) throw new Error("iroh connect failed: timed out");
        return undefined;
      },
    });
    const createSocket = createTauriIrohSocket(async () => ipc);
    const socket = createSocket(encodeIrohDialUrl({ nodeId: "node-1" }));

    let erroredWith: unknown;
    let closed = false;
    socket.onerror = (e) => {
      erroredWith = e;
    };
    socket.onclose = () => {
      closed = true;
    };
    await flush();

    expect((erroredWith as Error).message).toContain("timed out");
    expect(closed).toBe(true);
    expect(socket.readyState).toBe(3);
  });
});

describe("TauriIrohSocket messages", () => {
  it("forwards a message event as { data }", async () => {
    const { ipc, emit } = makeFakeIpc();
    const createSocket = createTauriIrohSocket(async () => ipc);
    const socket = createSocket(encodeIrohDialUrl({ nodeId: "node-1" }));
    await flush();

    let received: { data: string } | undefined;
    socket.onmessage = (ev) => {
      received = ev;
    };
    emit({ kind: "message", data: '{"type":"hello"}' });

    expect(received?.data).toBe('{"type":"hello"}');
  });

  it("treats a closed event as a close, once", async () => {
    const { ipc, emit } = makeFakeIpc();
    const createSocket = createTauriIrohSocket(async () => ipc);
    const socket = createSocket(encodeIrohDialUrl({ nodeId: "node-1" }));
    await flush();

    let closeCount = 0;
    socket.onclose = () => {
      closeCount++;
    };
    emit({ kind: "closed" });
    emit({ kind: "closed" });

    expect(closeCount).toBe(1);
    expect(socket.readyState).toBe(3);
  });

  it("surfaces an error event as an Error via onerror, without closing", async () => {
    const { ipc, emit } = makeFakeIpc();
    const createSocket = createTauriIrohSocket(async () => ipc);
    const socket = createSocket(encodeIrohDialUrl({ nodeId: "node-1" }));
    await flush();

    let erroredWith: unknown;
    socket.onerror = (e) => {
      erroredWith = e;
    };
    emit({ kind: "error", message: "boom" });

    expect((erroredWith as Error).message).toBe("boom");
    expect(socket.readyState).toBe(1);
  });
});

describe("TauriIrohSocket send", () => {
  it("invokes iroh_send with the raw message once OPEN", async () => {
    const { ipc, calls } = makeFakeIpc();
    const createSocket = createTauriIrohSocket(async () => ipc);
    const socket = createSocket(encodeIrohDialUrl({ nodeId: "node-1" }));
    await flush();

    socket.send('{"type":"req"}');
    await flush();

    const sendCall = calls.find((c) => c.cmd.endsWith("iroh_send"));
    expect(sendCall?.args?.msg).toBe('{"type":"req"}');
  });

  it("silently drops a send before OPEN", async () => {
    const { ipc, calls } = makeFakeIpc();
    const createSocket = createTauriIrohSocket(async () => ipc);
    const socket = createSocket(encodeIrohDialUrl({ nodeId: "node-1" }));
    // Deliberately not flushed -- still CONNECTING.
    socket.send("too-early");

    expect(calls.some((c) => c.cmd.endsWith("iroh_send"))).toBe(false);
  });
});

describe("TauriIrohSocket close", () => {
  it("invokes iroh_disconnect and reaches CLOSED once", async () => {
    const { ipc, calls } = makeFakeIpc();
    const createSocket = createTauriIrohSocket(async () => ipc);
    const socket = createSocket(encodeIrohDialUrl({ nodeId: "node-1" }));
    await flush();

    let closeCount = 0;
    socket.onclose = () => {
      closeCount++;
    };
    socket.close();
    await flush();
    socket.close(); // idempotent

    expect(calls.filter((c) => c.cmd.endsWith("iroh_disconnect")).length).toBe(1);
    expect(closeCount).toBe(1);
    expect(socket.readyState).toBe(3);
  });

  it("disconnects the real connection instead of leaking it when closed mid-connect", async () => {
    const connectGate = deferred<unknown>();
    const { ipc, calls } = makeFakeIpc({
      onInvoke: async (cmd) => {
        if (cmd.endsWith("iroh_connect")) return connectGate.promise;
        return undefined;
      },
    });
    const createSocket = createTauriIrohSocket(async () => ipc);
    const socket = createSocket(encodeIrohDialUrl({ nodeId: "node-1" }));

    let opened = false;
    socket.onopen = () => {
      opened = true;
    };
    socket.close(); // before the underlying iroh_connect ever resolves
    connectGate.resolve(undefined); // Rust-side connection "succeeds" anyway
    await flush();

    expect(opened).toBe(false);
    expect(calls.some((c) => c.cmd.endsWith("iroh_disconnect"))).toBe(true);
    expect(socket.readyState).toBe(3);
  });
});
