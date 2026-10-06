/**
 * A minimal, scriptable fake of a protocol v1 worker's WebSocket endpoint —
 * NOT a mock of `WorkerClient` itself. Implements just enough of the real
 * wire behavior (`sleap_rtc/protocol_v1/server.py` in `talmolab/sleap-connect`)
 * for `protocolV1Client.test.ts` to drive `WorkerClient` against real request/
 * response/event framing, including a real Ed25519 signature check for
 * `auth.prove` (no crypto is faked away).
 *
 * Test-only helper — intentionally not a `*.test.ts` file so bun's test
 * runner doesn't pick it up as a suite.
 */
import type { WebSocketLike } from "@/lib/protocolV1/client";

export interface FakeResponse {
  result?: Record<string, unknown>;
  error?: { code: string; msg: string; data?: unknown };
}

export type FakeRequestHandler = (
  method: string,
  params: Record<string, unknown>,
  socket: FakeWorkerSocket,
) => FakeResponse | Promise<FakeResponse>;

export interface FakeWorkerOptions {
  workerNodeId?: string;
  workerNonce?: string;
  protoMin?: number;
  protoMax?: number;
  /** Announced as `hello.blob_port`; omit to leave it unset (like a worker not running the blob HTTP server). */
  blobPort?: number;
  handleRequest?: FakeRequestHandler;
}

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

export class FakeWorkerSocket implements WebSocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  readyState: number = CONNECTING;
  /** Every frame the client sent, in order — for assertions. */
  readonly sent: Array<Record<string, unknown>> = [];
  /** Captured from the client's `hello.node_id` once it arrives. */
  clientNodeId: string | null = null;

  readonly workerNodeId: string;
  readonly workerNonce: string;
  readonly protoMin: number;
  readonly protoMax: number;
  readonly blobPort: number | undefined;
  private readonly _handleRequest: FakeRequestHandler;

  constructor(opts: FakeWorkerOptions = {}) {
    this.workerNodeId = opts.workerNodeId ?? "worker-node-id";
    this.workerNonce = opts.workerNonce ?? "worker-nonce";
    this.protoMin = opts.protoMin ?? 1;
    this.protoMax = opts.protoMax ?? 1;
    this.blobPort = opts.blobPort;
    this._handleRequest = opts.handleRequest ?? defaultHandleRequest;
  }

  /** Simulates the transport finishing its connect handshake. */
  simulateOpen(): void {
    this.readyState = OPEN;
    this.onopen?.(undefined);
  }

  send(data: string): void {
    const frame = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(frame);
    void this._respond(frame);
  }

  close(): void {
    this.readyState = CLOSED;
    this.onclose?.(undefined);
  }

  /** Push an `event` frame to the client, as if the worker emitted it. */
  emitEvent(topic: string, jobId: string, seq: number, data: Record<string, unknown>): void {
    this.onmessage?.({
      data: JSON.stringify({ v: 1, type: "event", topic, seq, job_id: jobId, data }),
    });
  }

  private async _respond(frame: Record<string, unknown>): Promise<void> {
    if (frame.type === "hello") {
      this.clientNodeId = frame.node_id as string;
      this.onmessage?.({
        data: JSON.stringify({
          v: 1,
          type: "hello",
          proto: { min: this.protoMin, max: this.protoMax },
          agent: { name: "sleap-connect-worker", version: "0.0.0", platform: "test" },
          node_id: this.workerNodeId,
          nonce: this.workerNonce,
          ...(this.blobPort !== undefined ? { blob_port: this.blobPort } : {}),
        }),
      });
      return;
    }

    if (frame.type === "req") {
      const outcome = await this._handleRequest(
        frame.method as string,
        (frame.params as Record<string, unknown>) ?? {},
        this,
      );
      this.onmessage?.({
        data: JSON.stringify({ v: 1, type: "res", id: frame.id, ...outcome }),
      });
    }
  }
}

async function defaultHandleRequest(
  method: string,
  params: Record<string, unknown>,
  socket: FakeWorkerSocket,
): Promise<FakeResponse> {
  if (method === "pair.claim") return { result: {} };

  if (method === "auth.prove") {
    if (!socket.clientNodeId) {
      return { error: { code: "internal", msg: "no client node_id captured" } };
    }
    const ok = await verifyEd25519(socket.clientNodeId, socket.workerNonce, params.sig as string);
    return ok ? { result: {} } : { error: { code: "auth.bad_signature", msg: "bad signature" } };
  }

  return { error: { code: "proto.unknown_method", msg: `no handler for ${method}` } };
}

function b64ToBytes(b64: string): Uint8Array {
  let std = b64.replace(/-/g, "+").replace(/_/g, "/");
  while (std.length % 4) std += "=";
  return Uint8Array.from(atob(std), (c) => c.charCodeAt(0));
}

async function verifyEd25519(nodeIdB64: string, nonce: string, sigB64: string): Promise<boolean> {
  try {
    const publicKey = await crypto.subtle.importKey(
      "raw",
      b64ToBytes(nodeIdB64),
      "Ed25519",
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      publicKey,
      b64ToBytes(sigB64),
      new TextEncoder().encode(nonce),
    );
  } catch {
    return false;
  }
}
