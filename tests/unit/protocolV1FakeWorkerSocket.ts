/**
 * A minimal, scriptable fake of a protocol v1 worker's WebSocket endpoint —
 * NOT a mock of `WorkerClient` itself. Implements just enough of the real
 * wire behavior (`sleap_rtc/protocol_v1/server.py` in `talmolab/sleap-connect`)
 * for `protocolV1Client.test.ts` to drive `WorkerClient` against real request/
 * response/event framing, including real Ed25519 signature checks for
 * `auth.prove` AND `hello.proof` (symmetric auth) — no crypto is faked away.
 *
 * Test-only helper — intentionally not a `*.test.ts` file so bun's test
 * runner doesn't pick it up as a suite.
 */
import type { WebSocketLike } from "@/lib/protocolV1/client";

// A real Ed25519 keypair every `FakeWorkerSocket` signs `hello.proof` with by
// default, so `workerNodeId` is a real public key `WorkerClient._verifyWorkerProof`
// can actually verify against — not an arbitrary placeholder string. Generated
// lazily (first use, memoized) rather than via top-level await, which hit a
// TDZ error under bun's --isolate test runner; `workerNodeId` is set once this
// resolves (see `_respond`'s hello branch), which is always before anything
// reads it in practice (only after a real `connect()` round-trip completes).
let _defaultWorkerKeyPairPromise: Promise<{ privateKey: CryptoKey; nodeId: string }> | null = null;
function getDefaultWorkerKeyPair(): Promise<{ privateKey: CryptoKey; nodeId: string }> {
  if (!_defaultWorkerKeyPairPromise) {
    _defaultWorkerKeyPairPromise = (async () => {
      const pair = (await crypto.subtle.generateKey("Ed25519", true, [
        "sign",
        "verify",
      ])) as CryptoKeyPair;
      const nodeId = bytesToB64(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
      return { privateKey: pair.privateKey, nodeId };
    })();
  }
  return _defaultWorkerKeyPairPromise;
}

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

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
  /**
   * Overrides `hello.proof` (symmetric auth). Default (omit this entirely):
   * a real signature over the client's nonce, using the module's shared
   * default worker keypair — matches a correctly-configured real worker.
   * `null`: omit `proof` from the hello entirely (an old/misconfigured
   * worker with no `sign_nonce` wired in). A string: send that literal
   * value instead (a forged/garbage proof, for the negative-verification
   * test cases `WorkerClient._verifyWorkerProof` needs to catch).
   */
  proofOverride?: string | null;
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

  /** A custom `workerNodeId` is known synchronously; the default (real,
   *  signable) one resolves lazily — see `_resolveWorkerNodeId`. Either
   *  way, this is always set by the time a real `connect()` round-trip
   *  (the only way anything reads it) has completed. */
  workerNodeId: string;
  readonly workerNonce: string;
  readonly protoMin: number;
  readonly protoMax: number;
  readonly blobPort: number | undefined;
  private readonly _usingDefaultKeyPair: boolean;
  private readonly _proofOverride: string | null | undefined;
  private readonly _handleRequest: FakeRequestHandler;

  constructor(opts: FakeWorkerOptions = {}) {
    this._usingDefaultKeyPair = opts.workerNodeId === undefined;
    this.workerNodeId = opts.workerNodeId ?? ""; // resolved before first use if default
    this._proofOverride = opts.proofOverride;
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
      let proof: string | null | undefined = this._proofOverride;
      if (proof === undefined && this._usingDefaultKeyPair) {
        const { privateKey, nodeId } = await getDefaultWorkerKeyPair();
        this.workerNodeId = nodeId;
        proof = await signWithWorkerKey(privateKey, frame.nonce as string);
      }
      // proof stays undefined here for a custom workerNodeId with no
      // matching private key to sign with, unless proofOverride set one.
      this.onmessage?.({
        data: JSON.stringify({
          v: 1,
          type: "hello",
          proto: { min: this.protoMin, max: this.protoMax },
          agent: { name: "sleap-connect-worker", version: "0.0.0", platform: "test" },
          node_id: this.workerNodeId,
          nonce: this.workerNonce,
          ...(this.blobPort !== undefined ? { blob_port: this.blobPort } : {}),
          ...(proof !== undefined && proof !== null ? { proof } : {}),
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

/** Signs `nonce` with `privateKey` — the fake-socket counterpart of a real
 *  worker's `WorkerIdentity.sign`. */
async function signWithWorkerKey(privateKey: CryptoKey, nonce: string): Promise<string> {
  const signature = await crypto.subtle.sign("Ed25519", privateKey, new TextEncoder().encode(nonce));
  return bytesToB64(new Uint8Array(signature));
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
