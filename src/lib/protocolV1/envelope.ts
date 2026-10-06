/**
 * Wire envelope for the sleap-connect protocol v1.
 *
 * Mirrors `sleap_rtc/protocol_v1/envelope.py` (sleap-connect worker repo) and
 * docs/plans/2026-09-26-sleap-connect-protocol-v1-spec.md §2: every message
 * on the wire is one JSON object shaped `{ v, type: "hello" | "req" | "res"
 * | "event", ... }`. This module only handles frame (de)serialization;
 * dispatch and transport live in `client.ts`.
 */

export const PROTOCOL_VERSION = 1;

export interface AgentInfo {
  name: string;
  version: string;
  platform: string;
}

export interface HelloFrame {
  v: number;
  type: "hello";
  proto: { min: number; max: number };
  agent: AgentInfo;
  node_id: string;
  nonce: string;
  /**
   * The worker's blob-serving HTTP port (spec §6.3), on the same host the
   * client dialed for this WS connection. Additive per §2.4; only ever
   * present on a worker's own hello (never the client's, and never on a
   * worker not running the blob HTTP server).
   */
  blob_port?: number;
  /**
   * Symmetric auth: the WORKER's signature over the CLIENT's own `nonce`
   * (the one THIS side just sent in its own hello), proving the worker
   * genuinely holds the private key for the `node_id` it claimed in this
   * same frame. Verified in `WorkerClient._handleHello` before the
   * connection is trusted with anything else. Only ever present on a
   * worker's own hello (never the client's — see `client.ts`'s verification
   * for why the reverse direction doesn't need this).
   */
  proof?: string;
}

export interface ReqFrame {
  v: number;
  type: "req";
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface ResError {
  code: string;
  msg: string;
  data?: unknown;
}

export interface ResFrame {
  v: number;
  type: "res";
  id: number;
  result?: Record<string, unknown>;
  error?: ResError;
}

export interface EventFrame {
  v: number;
  type: "event";
  topic: string;
  seq: number;
  data: Record<string, unknown>;
  job_id?: string;
}

export type Envelope = HelloFrame | ReqFrame | ResFrame | EventFrame;

/** Raised when a raw wire message doesn't parse as a valid envelope frame. */
export class EnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeError";
  }
}

export function buildHello(params: {
  nodeId: string;
  nonce: string;
  agent: AgentInfo;
  protoMin?: number;
  protoMax?: number;
}): HelloFrame {
  return {
    v: PROTOCOL_VERSION,
    type: "hello",
    proto: {
      min: params.protoMin ?? PROTOCOL_VERSION,
      max: params.protoMax ?? PROTOCOL_VERSION,
    },
    agent: params.agent,
    node_id: params.nodeId,
    nonce: params.nonce,
  };
}

export function buildReq(
  id: number,
  method: string,
  params: Record<string, unknown> = {},
): ReqFrame {
  return { v: PROTOCOL_VERSION, type: "req", id, method, params };
}

/**
 * Parse a raw wire message into the appropriate frame type.
 *
 * Throws `EnvelopeError` if `raw` isn't valid JSON, has an unrecognized or
 * missing `type`, or is missing a field required for its type — matching
 * the Python `parse_envelope`'s error behavior exactly.
 */
export function parseEnvelope(raw: string): Envelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new EnvelopeError(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new EnvelopeError("Envelope frame must be a JSON object");
  }

  const frame = parsed as Record<string, unknown>;
  const v = typeof frame.v === "number" ? frame.v : PROTOCOL_VERSION;

  switch (frame.type) {
    case "hello":
      requireFields(frame, ["proto", "agent", "node_id", "nonce"]);
      return {
        v,
        type: "hello",
        proto: frame.proto as { min: number; max: number },
        agent: frame.agent as AgentInfo,
        node_id: frame.node_id as string,
        nonce: frame.nonce as string,
        blob_port: frame.blob_port as number | undefined,
        proof: frame.proof as string | undefined,
      };

    case "req":
      requireFields(frame, ["id", "method"]);
      return {
        v,
        type: "req",
        id: frame.id as number,
        method: frame.method as string,
        params: (frame.params as Record<string, unknown>) ?? {},
      };

    case "res":
      requireFields(frame, ["id"]);
      return {
        v,
        type: "res",
        id: frame.id as number,
        result: frame.result as Record<string, unknown> | undefined,
        error: frame.error as ResError | undefined,
      };

    case "event":
      requireFields(frame, ["topic", "seq"]);
      return {
        v,
        type: "event",
        topic: frame.topic as string,
        seq: frame.seq as number,
        data: (frame.data as Record<string, unknown>) ?? {},
        job_id: frame.job_id as string | undefined,
      };

    default:
      throw new EnvelopeError(`Unknown or missing envelope type: ${JSON.stringify(frame.type)}`);
  }
}

function requireFields(frame: Record<string, unknown>, fields: string[]): void {
  for (const field of fields) {
    if (frame[field] === undefined) {
      throw new EnvelopeError(
        `Missing required field '${field}' for type ${JSON.stringify(frame.type)}`,
      );
    }
  }
}
