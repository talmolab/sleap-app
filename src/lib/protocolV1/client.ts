/**
 * Typed client for the sleap-connect protocol v1
 * (docs/plans/2026-09-26-sleap-connect-protocol-v1-spec.md).
 *
 * Owns one WebSocket connection to a worker: exchanges `hello`, pairs or
 * re-authenticates (§3), correlates `req`/`res` frames by a per-connection
 * monotonic ID, and fans out `event` frames (§5) to per-job subscribers.
 * Mirrors the worker's own implementation
 * (`sleap_rtc/protocol_v1/{envelope,server,job_methods,auth}.py` in
 * `talmolab/sleap-connect`) closely enough that reading one explains the
 * other.
 *
 * This replaces `sleapConnect.ts`'s `::`-delimited strings and
 * `transport.ts`'s `RelayTransport` re-parser for talking to a protocol v1
 * worker — it is not a `Transport` implementation, it dials the worker
 * directly and exposes a typed method surface instead of raw string
 * send/onMessage.
 */

import {
  buildHello,
  buildReq,
  parseEnvelope,
  PROTOCOL_VERSION,
  type AgentInfo,
  type Envelope,
  type EventFrame,
  type HelloFrame,
  type ResFrame,
} from "./envelope";
import {
  BLOB_HASH_MISMATCH,
  BLOB_INCOMPLETE,
  BLOB_UNKNOWN,
  CLIENT_CLOSED,
  CLIENT_PROTO_MISMATCH,
  CLIENT_TIMEOUT,
  CLIENT_WORKER_UNVERIFIED,
  FS_FORBIDDEN,
  FS_IO_ERROR,
  FS_NOT_FOUND,
  INTERNAL,
  WorkerProtocolError,
} from "./errors";
import type { ClientIdentity } from "./identity";

/**
 * The subset of the `WebSocket` interface this client needs. Lets tests
 * inject an in-memory fake instead of opening a real socket; defaults to
 * the global `WebSocket` in the app.
 */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

const WS_OPEN = 1;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

export type ConnectionState = "connecting" | "unauthenticated" | "authenticated" | "closed";

export interface JobSummary {
  jobId: string;
  state: string;
  createdAt: string;
}

export interface JobStatus {
  jobId: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  result: Record<string, unknown> | null;
  error: string | null;
}

export interface Mount {
  path: string;
  label?: string;
}

export interface FsEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
}

export interface FsListResult {
  entries: FsEntry[];
  totalCount: number;
  hasMore: boolean;
}

export interface FsStatResult {
  path: string;
  type: "file" | "directory";
  size: number;
  modified: number;
}

export interface FsReadResult {
  path: string;
  /** Raw bytes, already base64-decoded. */
  content: Uint8Array;
  offset: number;
  size: number;
  totalSize: number;
  /** True if this read reached the end of the file. */
  eof: boolean;
}

/** Maps the worker's `file_manager.py` `error_code` strings to this client's `fs.*` codes. */
function _fsErrorCode(workerCode: unknown): string {
  switch (workerCode) {
    case "PATH_NOT_FOUND":
      return FS_NOT_FOUND;
    case "ACCESS_DENIED":
      return FS_FORBIDDEN;
    default:
      return FS_IO_ERROR;
  }
}

/**
 * `fs.stat`/`fs.read` report failure as an `{error, error_code}` pair
 * embedded in an otherwise-normal `res` (not an envelope-level `res.error`)
 * — see `file_manager.py`'s `stat_path`/`read_file`. Left unchecked, every
 * caller silently gets a bogus zero-valued "success" instead of a thrown
 * error.
 */
function _throwIfFsError(result: Record<string, unknown>, context: string): void {
  if (typeof result.error === "string") {
    throw new WorkerProtocolError(_fsErrorCode(result.error_code), `${context}: ${result.error}`);
  }
}

export interface WorkerEvent {
  topic: string;
  seq: number;
  jobId?: string;
  data: Record<string, unknown>;
}

/**
 * Reported to `onClose` listeners once per close: `intentional: true` for a
 * caller-initiated `close()`, `false` for anything else (a dropped socket, a
 * failed handshake, a protocol error) — `error` carries the cause in that
 * case.
 */
export interface CloseInfo {
  intentional: boolean;
  error?: WorkerProtocolError;
}

export interface WorkerClientOptions {
  url: string;
  identity: ClientIdentity;
  agent?: AgentInfo;
  protoMin?: number;
  protoMax?: number;
  requestTimeoutMs?: number;
  /** Overridable for tests; defaults to `(url) => new WebSocket(url)`. */
  createSocket?: (url: string) => WebSocketLike;
  /** Overridable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

interface PendingRequest {
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class WorkerClient {
  private readonly _url: string;
  private readonly _identity: ClientIdentity;
  private readonly _agent: AgentInfo;
  private readonly _protoMin: number;
  private readonly _protoMax: number;
  private readonly _requestTimeoutMs: number;
  private readonly _createSocket: (url: string) => WebSocketLike;
  private readonly _fetch: typeof fetch;

  private _socket: WebSocketLike | null = null;
  private _state: ConnectionState = "closed";
  private _nextRequestId = 1;
  private readonly _pending = new Map<number, PendingRequest>();
  private readonly _jobListeners = new Map<string, Set<(event: WorkerEvent) => void>>();
  private readonly _closeListeners = new Set<(info: CloseInfo) => void>();
  private _closeNotified = false;

  private _peerNodeId: string | null = null;
  // The nonce the WORKER sent us in its hello — what auth.prove signs
  // (spec §3.3: each side signs the *other* side's nonce).
  private _peerNonce: string | null = null;
  // The nonce WE sent in our own hello — symmetric auth verifies the
  // worker's hello.proof against this value (the worker signs it right
  // back in the SAME hello exchange, no extra round-trip).
  private _ownNonce: string | null = null;
  // The worker's blob-serving HTTP port, if it announced one — see
  // fetchBlob(). null on a worker not running the blob HTTP server.
  private _peerBlobPort: number | null = null;

  private _connectWaiter: { resolve: () => void; reject: (e: Error) => void } | null = null;

  constructor(options: WorkerClientOptions) {
    this._url = options.url;
    this._identity = options.identity;
    this._agent = options.agent ?? { name: "sleap-app", version: "0.0.0", platform: "unknown" };
    this._protoMin = options.protoMin ?? PROTOCOL_VERSION;
    this._protoMax = options.protoMax ?? PROTOCOL_VERSION;
    this._requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this._createSocket =
      options.createSocket ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this._fetch = options.fetchImpl ?? fetch;
  }

  get state(): ConnectionState {
    return this._state;
  }

  get authenticated(): boolean {
    return this._state === "authenticated";
  }

  /** The worker's node_id, known once the `hello` handshake completes. */
  get peerNodeId(): string | null {
    return this._peerNodeId;
  }

  /** The worker's blob-serving HTTP port, if it announced one (spec §6.3). */
  get peerBlobPort(): number | null {
    return this._peerBlobPort;
  }

  /**
   * Open the connection and complete the `hello` handshake (spec §3.3
   * steps 1-2). Resolves once both sides have exchanged `hello` — the
   * connection is then "unauthenticated": only `pairClaim`/`authProve`
   * should be called until one of them succeeds.
   */
  connect(): Promise<void> {
    if (this._state !== "closed") {
      throw new WorkerProtocolError(CLIENT_CLOSED, "connect() called on an already-open client");
    }
    this._state = "connecting";

    return new Promise((resolve, reject) => {
      this._connectWaiter = { resolve, reject };
      const socket = this._createSocket(this._url);
      this._socket = socket;

      socket.onopen = () => {
        this._ownNonce = randomNonce();
        const hello = buildHello({
          nodeId: this._identity.nodeId,
          nonce: this._ownNonce,
          agent: this._agent,
          protoMin: this._protoMin,
          protoMax: this._protoMax,
        });
        socket.send(JSON.stringify(hello));
      };

      socket.onmessage = (ev) => this._handleMessage(ev.data);

      socket.onerror = () => {
        console.warn("[protocolV1] WebSocket error");
      };

      socket.onclose = () => {
        if (this._state !== "closed") {
          this._failNonIntentional(new WorkerProtocolError(CLIENT_CLOSED, "Connection closed"));
        }
      };
    });
  }

  /** Close the connection. Any in-flight requests reject with `client.closed`. */
  close(): void {
    if (this._state === "closed") return;
    this._fail(new WorkerProtocolError(CLIENT_CLOSED, "Client closed"));
    this._jobListeners.clear();
    this._notifyClose({ intentional: true });
  }

  /**
   * Subscribe to this client closing, exactly once — a dropped socket, a
   * failed handshake/protocol error, or a caller-initiated `close()` (see
   * `CloseInfo`). Returns an unsubscribe function.
   */
  onClose(cb: (info: CloseInfo) => void): () => void {
    this._closeListeners.add(cb);
    return () => this._closeListeners.delete(cb);
  }

  private _notifyClose(info: CloseInfo): void {
    if (this._closeNotified) return;
    this._closeNotified = true;
    for (const cb of [...this._closeListeners]) {
      try {
        cb(info);
      } catch (e) {
        console.warn("[protocolV1] onClose listener threw", e);
      }
    }
  }

  /**
   * `_fail` plus an `onClose` notification for a condition this client
   * detected itself (dropped socket, protocol mismatch, failed peer
   * verification) rather than a caller-initiated `close()` — including one
   * raised while still inside `connect()` (a failed dial), so a caller
   * managing reconnection (e.g. `ManagedConnection`) can learn about that
   * failure the same way it learns about a later drop.
   */
  private _failNonIntentional(err: Error): void {
    this._fail(err);
    this._notifyClose({
      intentional: false,
      error: err instanceof WorkerProtocolError ? err : undefined,
    });
  }

  /** First-contact trust via a pairing ticket's one-time secret (spec §3.2). */
  async pairClaim(secret: string): Promise<void> {
    await this._request("pair.claim", { secret, node_id: this._identity.nodeId });
    this._state = "authenticated";
  }

  /** Re-prove identity on an already-paired connection (spec §3.3 step 3). */
  async authProve(): Promise<void> {
    if (this._peerNonce === null) {
      throw new WorkerProtocolError(
        INTERNAL,
        "authProve() called before the hello handshake completed",
      );
    }
    const sig = await this._identity.sign(this._peerNonce);
    await this._request("auth.prove", { sig });
    this._state = "authenticated";
  }

  async jobsSubmit(spec: Record<string, unknown>, clientJobId?: string): Promise<{ jobId: string }> {
    const params: Record<string, unknown> = { spec };
    if (clientJobId !== undefined) params.client_job_id = clientJobId;
    const result = await this._request("jobs.submit", params);
    return { jobId: result.job_id as string };
  }

  async jobsCancel(jobId: string, mode: "cancel" | "stop" = "cancel"): Promise<void> {
    await this._request("jobs.cancel", { job_id: jobId, mode });
  }

  async jobsStatus(jobId: string): Promise<JobStatus> {
    const result = await this._request("jobs.status", { job_id: jobId });
    return {
      jobId: result.job_id as string,
      state: result.state as string,
      createdAt: result.created_at as string,
      updatedAt: result.updated_at as string,
      result: (result.result as Record<string, unknown>) ?? null,
      error: (result.error as string) ?? null,
    };
  }

  async jobsList(): Promise<JobSummary[]> {
    const result = await this._request("jobs.list", {});
    const jobs = (result.jobs as Array<Record<string, unknown>>) ?? [];
    return jobs.map((j) => ({
      jobId: j.job_id as string,
      state: j.state as string,
      createdAt: j.created_at as string,
    }));
  }

  /**
   * Subscribe to a job's events, replaying everything since `sinceSeq`
   * (0 = full history) before switching to live events (spec §5.2). The
   * local listener is registered *before* the `jobs.subscribe` request is
   * sent, so a backlog event the worker pushes while handling that request
   * can never arrive before anything is listening for it.
   *
   * Returns an unsubscribe function.
   */
  async jobsSubscribe(
    jobId: string,
    sinceSeq: number,
    onEvent: (event: WorkerEvent) => void,
  ): Promise<() => void> {
    let listeners = this._jobListeners.get(jobId);
    if (!listeners) {
      listeners = new Set();
      this._jobListeners.set(jobId, listeners);
    }
    listeners.add(onEvent);

    try {
      await this._request("jobs.subscribe", { job_id: jobId, since_seq: sinceSeq });
    } catch (err) {
      listeners.delete(onEvent);
      throw err;
    }

    return () => {
      listeners.delete(onEvent);
    };
  }

  async fsMounts(): Promise<Mount[]> {
    const result = await this._request("fs.mounts", {});
    const mounts = (result.mounts as Array<Record<string, unknown>>) ?? [];
    return mounts.map((m) => ({
      path: m.path as string,
      label: m.label as string | undefined,
    }));
  }

  async fsList(path: string, offset = 0): Promise<FsListResult> {
    const result = await this._request("fs.list", { path, offset });
    return {
      entries: (result.entries as FsEntry[]) ?? [],
      totalCount: (result.total_count as number) ?? 0,
      hasMore: !!result.has_more,
    };
  }

  /**
   * Metadata for one path within the worker's configured mounts.
   *
   * @throws {WorkerProtocolError} with an `fs.*` code if the worker's
   * `fs.stat` handler reports failure (path missing, outside configured
   * mounts, etc.) — these arrive as an `{error, error_code}` pair embedded
   * in an otherwise-successful `res`, not as an envelope-level `res.error`
   * (see `file_manager.py`'s `stat_path`/`read_file` docstrings), so they
   * must be checked explicitly rather than assumed absent.
   */
  async fsStat(path: string): Promise<FsStatResult> {
    const result = await this._request("fs.stat", { path });
    _throwIfFsError(result, `fs.stat('${path}')`);
    return {
      path: result.path as string,
      type: result.type as "file" | "directory",
      size: (result.size as number) ?? 0,
      modified: (result.modified as number) ?? 0,
    };
  }

  /**
   * A small direct byte-range read within the worker's configured mounts —
   * for inspecting a config/log/text file, NOT bulk transfer (see
   * `fetchBlob`/the blob API for that). The worker caps `length` server-side
   * (4 MiB per call as of `file_manager.py`'s `MAX_READ_BYTES`); page through
   * a larger file with repeated, offset-advancing calls.
   */
  async fsRead(path: string, offset = 0, length?: number): Promise<FsReadResult> {
    const params: Record<string, unknown> = { path, offset };
    if (length !== undefined) params.length = length;
    const result = await this._request("fs.read", params);
    _throwIfFsError(result, `fs.read('${path}')`);
    return {
      path: result.path as string,
      content: base64ToBytes((result.content_base64 as string) ?? ""),
      offset: (result.offset as number) ?? offset,
      size: (result.size as number) ?? 0,
      totalSize: (result.total_size as number) ?? 0,
      eof: !!result.eof,
    };
  }

  /**
   * Fetch a result blob's bytes from the worker's blob HTTP endpoint (spec
   * §6.3), on the same host this client dialed for the WS connection.
   * Verifies both size and content hash before returning — this is bulk
   * data crossing a network boundary, worth checking rather than trusting
   * blindly. Only meaningful once `hello` has completed and the worker
   * announced a `blob_port` (a worker not running the blob HTTP server has
   * nothing to serve).
   */
  async fetchBlob(sha256: string, expectedSize?: number): Promise<Uint8Array> {
    if (this._peerBlobPort === null) {
      throw new WorkerProtocolError(
        BLOB_UNKNOWN,
        "Worker did not announce a blob port — it isn't running the blob HTTP server",
      );
    }
    const url = `${this._blobHttpOrigin()}/blobs/${sha256}`;

    let response: Response;
    try {
      response = await this._fetch(url);
    } catch (err) {
      throw new WorkerProtocolError(
        BLOB_UNKNOWN,
        `Failed to reach the blob server at ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!response.ok) {
      throw new WorkerProtocolError(
        BLOB_UNKNOWN,
        `Blob ${sha256} not found (HTTP ${response.status})`,
      );
    }

    const buffer = new Uint8Array(await response.arrayBuffer());
    if (expectedSize !== undefined && buffer.byteLength !== expectedSize) {
      throw new WorkerProtocolError(
        BLOB_INCOMPLETE,
        `Blob ${sha256}: expected ${expectedSize} bytes, got ${buffer.byteLength}`,
      );
    }

    const actualHash = await sha256Hex(buffer);
    if (actualHash !== sha256) {
      throw new WorkerProtocolError(
        BLOB_HASH_MISMATCH,
        `Blob content does not match its hash (expected ${sha256}, got ${actualHash})`,
      );
    }

    return buffer;
  }

  private _blobHttpOrigin(): string {
    // "ws://host:port" -> "http://host:<blob_port>"; "wss://" -> "https://"
    // (the regex only replaces the leading "ws", so wss's trailing "s"
    // combines with "http" to form "https" on its own).
    const dialUrl = new URL(this._url.replace(/^ws/, "http"));
    return `${dialUrl.protocol}//${dialUrl.hostname}:${this._peerBlobPort}`;
  }

  // ── internals ──────────────────────────────────────────────────────

  private _request(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (!this._socket || this._socket.readyState !== WS_OPEN) {
      return Promise.reject(new WorkerProtocolError(CLIENT_CLOSED, "Not connected"));
    }
    const socket = this._socket;
    const id = this._nextRequestId++;
    const frame = buildReq(id, method, params);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pending.delete(id);
        reject(new WorkerProtocolError(CLIENT_TIMEOUT, `Request '${method}' timed out`));
      }, this._requestTimeoutMs);

      this._pending.set(id, { resolve, reject, timeout });
      socket.send(JSON.stringify(frame));
    });
  }

  private _handleMessage(raw: string): void {
    let envelope: Envelope;
    try {
      envelope = parseEnvelope(raw);
    } catch (err) {
      console.warn("[protocolV1] Dropping unparseable frame:", err);
      return;
    }

    switch (envelope.type) {
      case "hello":
        this._handleHello(envelope);
        break;
      case "res":
        this._handleRes(envelope);
        break;
      case "event":
        this._handleEvent(envelope);
        break;
      case "req":
        // The worker never issues its own outgoing requests — symmetric
        // auth (worker proves identity to client) is implemented via
        // hello.proof instead (see _verifyWorkerProof), not a
        // worker-initiated req/res round-trip.
        console.warn("[protocolV1] Unexpected 'req' frame from worker, ignoring");
        break;
    }
  }

  private _handleHello(hello: HelloFrame): void {
    if (this._state !== "connecting") {
      console.warn("[protocolV1] Unexpected 'hello' frame after handshake, ignoring");
      return;
    }
    if (hello.proto.max < this._protoMin || hello.proto.min > this._protoMax) {
      this._failNonIntentional(
        new WorkerProtocolError(
          CLIENT_PROTO_MISMATCH,
          `Worker's protocol range [${hello.proto.min},${hello.proto.max}] does not overlap ` +
            `ours [${this._protoMin},${this._protoMax}]`,
        ),
      );
      return;
    }

    // Symmetric auth: verify the worker's proof BEFORE trusting anything
    // else this connection says. Web Crypto is async, so the rest of hello
    // processing (and resolving _connectWaiter) waits for it — nothing a
    // caller does with this client can run before that resolves anyway.
    void this._verifyWorkerProof(hello).then(
      (verified) => {
        if (this._state !== "connecting") return; // closed/failed while this was pending
        if (!verified) {
          this._failNonIntentional(
            new WorkerProtocolError(
              CLIENT_WORKER_UNVERIFIED,
              "Worker's hello.proof did not verify against the public key it claimed as its node_id",
            ),
          );
          return;
        }
        this._peerNodeId = hello.node_id;
        this._peerNonce = hello.nonce;
        this._peerBlobPort = hello.blob_port ?? null;
        this._state = "unauthenticated";
        this._connectWaiter?.resolve();
        this._connectWaiter = null;
      },
      (err) => this._failNonIntentional(err instanceof Error ? err : new Error(String(err))),
    );
  }

  /**
   * Checks `hello.proof` — the worker's signature over OUR OWN nonce
   * (`_ownNonce`, sent in our hello) — against the public key encoded in
   * `hello.node_id` from that SAME frame. `false` for a missing proof
   * (never silently treated as "not applicable" — an unproven peer is an
   * unverified peer), a malformed node_id/proof, or a genuinely bad
   * signature; these aren't distinguished further since the caller's only
   * next move is the same either way (fail the connection).
   */
  private async _verifyWorkerProof(hello: HelloFrame): Promise<boolean> {
    if (!hello.proof || this._ownNonce === null) return false;
    try {
      const publicKey = await crypto.subtle.importKey(
        "raw",
        base64UrlToBytes(hello.node_id),
        "Ed25519",
        false,
        ["verify"],
      );
      return await crypto.subtle.verify(
        "Ed25519",
        publicKey,
        base64UrlToBytes(hello.proof),
        new TextEncoder().encode(this._ownNonce),
      );
    } catch {
      return false;
    }
  }

  private _handleRes(res: ResFrame): void {
    const pending = this._pending.get(res.id);
    if (!pending) return;
    this._pending.delete(res.id);
    clearTimeout(pending.timeout);
    if (res.error) {
      pending.reject(new WorkerProtocolError(res.error.code, res.error.msg, res.error.data));
    } else {
      pending.resolve(res.result ?? {});
    }
  }

  private _handleEvent(event: EventFrame): void {
    if (!event.job_id) return; // connection-level events: none defined yet
    const listeners = this._jobListeners.get(event.job_id);
    if (!listeners || listeners.size === 0) return;
    const workerEvent: WorkerEvent = {
      topic: event.topic,
      seq: event.seq,
      jobId: event.job_id,
      data: event.data,
    };
    for (const listener of listeners) listener(workerEvent);
  }

  private _fail(err: Error): void {
    this._state = "closed";
    this._socket?.close();
    this._socket = null;
    this._connectWaiter?.reject(err);
    this._connectWaiter = null;
    for (const [, pending] of this._pending) {
      clearTimeout(pending.timeout);
      pending.reject(err);
    }
    this._pending.clear();
  }
}

function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Decodes URL-safe, unpadded base64 (the encoding `sleap_rtc.auth.keypair`
 *  and `identity.ts` both use for node IDs and signatures) to raw bytes. */
function base64UrlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
