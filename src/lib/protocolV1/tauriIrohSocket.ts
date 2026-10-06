/**
 * A `WebSocketLike` (see `client.ts`) backed by a Tauri-owned iroh QUIC
 * connection (item 2.3), for use on desktop instead of a browser
 * `WebSocket`. Rust owns the actual connection — mirrors `rtc.rs`'s role
 * for the legacy WebRTC transport — but unlike `rtc.rs` it's a dumb byte
 * pipe: this file just translates between `WebSocketLike`'s
 * WebSocket-shaped callbacks and the `iroh_connect`/`iroh_send`/
 * `iroh_disconnect` Tauri commands (`src-tauri/src/iroh_client.rs`). All
 * hello/auth/job dispatch logic stays in `WorkerClient`, unchanged and
 * shared with the browser transport — that's the point of `client.ts`'s
 * injectable `createSocket` (built in item 1.7 for exactly this purpose).
 *
 * `WorkerClientOptions.url` stays a plain string (client.ts itself is not
 * touched) — the dial target (node_id + optional relay/direct addresses)
 * is packed into that string as JSON by `encodeIrohDialUrl` and unpacked
 * here. Item 2.1 (how a live worker's iroh reachability info gets embedded
 * in a *pairing ticket*) is a separate, still-unimplemented concern;
 * whatever wire format it eventually settles on should decode into an
 * `IrohDialTarget` before being handed to `WorkerClient`, not be assumed
 * here.
 *
 * Known gap (flagged, not fixed here — item 2.4, "decide how blobs travel
 * over iroh"): `client.ts`'s `fetchBlob()`/`_blobHttpOrigin()` assumes
 * `this._url` parses as a real `ws(s)://` URL to derive the blob HTTP
 * origin. A `WorkerClient` constructed with an iroh dial target will throw
 * a raw `TypeError` (not a `WorkerProtocolError`) if `fetchBlob` is ever
 * called on it — a completed track job's result blob isn't fetchable over
 * an iroh connection yet.
 */

import { sleapCmd } from "@/lib/sleapPlugin";
import type { WebSocketLike } from "./client";

export interface IrohDialTarget {
  nodeId: string;
  relayUrl?: string;
  directAddrs?: string[];
}

/** Packs a dial target into the opaque string `WorkerClientOptions.url` carries. */
export function encodeIrohDialUrl(target: IrohDialTarget): string {
  return JSON.stringify(target);
}

function decodeIrohDialUrl(url: string): IrohDialTarget {
  let parsed: Partial<IrohDialTarget>;
  try {
    parsed = JSON.parse(url) as Partial<IrohDialTarget>;
  } catch (err) {
    throw new Error(
      `Not a valid iroh dial target (expected JSON from encodeIrohDialUrl): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (typeof parsed.nodeId !== "string" || parsed.nodeId.length === 0) {
    throw new Error("iroh dial target is missing nodeId");
  }
  return {
    nodeId: parsed.nodeId,
    relayUrl: parsed.relayUrl,
    directAddrs: parsed.directAddrs,
  };
}

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

type IrohClientEvent =
  | { kind: "message"; data: string }
  | { kind: "closed" }
  | { kind: "error"; message: string };

interface ChannelLike<T> {
  onmessage: ((payload: T) => void) | null;
}

/**
 * The slice of `@tauri-apps/api/core` this adapter needs. Injectable so
 * tests don't need a real Tauri runtime — mirrors `WorkerClientOptions`'s
 * own `createSocket`/`fetchImpl` injection points in `client.ts`.
 */
export interface TauriIpc {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  createChannel: <T>() => ChannelLike<T>;
}

async function defaultTauriIpc(): Promise<TauriIpc> {
  const { invoke, Channel } = await import("@tauri-apps/api/core");
  return {
    invoke,
    createChannel: <T>() => new Channel<T>(),
  };
}

/**
 * Returns a `createSocket` function for `WorkerClientOptions` — the same
 * shape as `(url) => new WebSocket(url)`, but dialing a worker over iroh
 * via the Tauri backend instead. `getIpc` is overridable for tests.
 */
export function createTauriIrohSocket(getIpc: () => Promise<TauriIpc> = defaultTauriIpc) {
  return (url: string): WebSocketLike => new TauriIrohSocket(url, getIpc);
}

class TauriIrohSocket implements WebSocketLike {
  readyState = WS_CONNECTING;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  private _ipc: TauriIpc | null = null;
  private _closedByUs = false;

  constructor(url: string, getIpc: () => Promise<TauriIpc>) {
    void this._connect(url, getIpc);
  }

  private async _connect(url: string, getIpc: () => Promise<TauriIpc>): Promise<void> {
    // Ensure nothing here ever runs synchronously during construction — a
    // real `WebSocket` never calls `onerror`/`onclose` before its
    // constructor returns either, and `WorkerClient.connect()` only
    // attaches those handlers right after `createSocket(url)` returns.
    // Without this, a target that fails to decode synchronously (below)
    // would fire onerror/onclose before anything is listening.
    await Promise.resolve();

    let target: IrohDialTarget;
    try {
      target = decodeIrohDialUrl(url);
    } catch (err) {
      this._failToConnect(err);
      return;
    }

    let ipc: TauriIpc;
    try {
      ipc = await getIpc();
    } catch (err) {
      this._failToConnect(err);
      return;
    }

    const channel = ipc.createChannel<IrohClientEvent>();
    channel.onmessage = (event) => this._handleEvent(event);

    try {
      await ipc.invoke(sleapCmd("iroh_connect"), {
        target: {
          nodeId: target.nodeId,
          relayUrl: target.relayUrl,
          directAddrs: target.directAddrs,
        },
        onMessage: channel,
      });
    } catch (err) {
      this._failToConnect(err);
      return;
    }

    this._ipc = ipc;
    if (this._closedByUs) {
      // close() arrived while iroh_connect was still in flight. The
      // underlying Rust connection did complete, so it must be torn down
      // rather than left open with nothing tracking it.
      void this._disconnect();
      return;
    }
    this.readyState = WS_OPEN;
    this.onopen?.({});
  }

  private _failToConnect(err: unknown): void {
    if (this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSED;
    this.onerror?.(err);
    this.onclose?.(err);
  }

  private _handleEvent(event: IrohClientEvent): void {
    switch (event.kind) {
      case "message":
        this.onmessage?.({ data: event.data });
        break;
      case "closed":
        if (this.readyState !== WS_CLOSED) {
          this.readyState = WS_CLOSED;
          this.onclose?.(event);
        }
        break;
      case "error":
        this.onerror?.(new Error(event.message));
        break;
    }
  }

  send(data: string): void {
    if (this.readyState !== WS_OPEN || !this._ipc) return;
    void this._ipc
      .invoke(sleapCmd("iroh_send"), { msg: data })
      .catch((err) => this.onerror?.(err));
  }

  close(): void {
    if (this.readyState === WS_CLOSED || this._closedByUs) return;
    this._closedByUs = true;
    if (this.readyState !== WS_OPEN) {
      // Still connecting — _connect's own completion will notice
      // _closedByUs and disconnect once (if) it actually establishes.
      this.readyState = WS_CLOSING;
      return;
    }
    this.readyState = WS_CLOSING;
    void this._disconnect();
  }

  private async _disconnect(): Promise<void> {
    try {
      if (this._ipc) {
        await this._ipc.invoke(sleapCmd("iroh_disconnect"));
      }
    } finally {
      if (this.readyState !== WS_CLOSED) {
        this.readyState = WS_CLOSED;
        this.onclose?.({});
      }
    }
  }
}
