import { describe, it, expect } from "../bun-test";
import "fake-indexeddb/auto";
import { WorkerClient, type WorkerClientOptions, type WorkerEvent } from "@/lib/protocolV1/client";
import {
  BLOB_HASH_MISMATCH,
  BLOB_INCOMPLETE,
  BLOB_UNKNOWN,
  CLIENT_CLOSED,
  CLIENT_PROTO_MISMATCH,
  CLIENT_TIMEOUT,
  WorkerProtocolError,
} from "@/lib/protocolV1/errors";
import {
  getClientIdentity,
  clearClientIdentity,
  _resetClientIdentityCache,
  type ClientIdentity,
} from "@/lib/protocolV1/identity";
import { FakeWorkerSocket } from "./protocolV1FakeWorkerSocket";

async function freshIdentity(): Promise<ClientIdentity> {
  _resetClientIdentityCache();
  await clearClientIdentity();
  return getClientIdentity();
}

function makeClient(
  identity: ClientIdentity,
  socket: FakeWorkerSocket,
  overrides: Partial<Omit<WorkerClientOptions, "url" | "identity" | "createSocket">> = {},
): WorkerClient {
  return new WorkerClient({
    url: "ws://fake-worker",
    identity,
    createSocket: () => socket,
    requestTimeoutMs: 1000,
    ...overrides,
  });
}

/** Connects a client against a fake socket and returns once hello completes. */
async function connected(
  identity: ClientIdentity,
  socket: FakeWorkerSocket,
  overrides: Partial<Omit<WorkerClientOptions, "url" | "identity" | "createSocket">> = {},
): Promise<WorkerClient> {
  const client = makeClient(identity, socket, overrides);
  const connectPromise = client.connect();
  socket.simulateOpen();
  await connectPromise;
  return client;
}

async function rejection(promise: Promise<unknown>): Promise<WorkerProtocolError> {
  try {
    await promise;
  } catch (err) {
    return err as WorkerProtocolError;
  }
  throw new Error("expected promise to reject");
}

describe("protocolV1 WorkerClient", () => {
  describe("hello handshake", () => {
    it("completes the handshake and becomes 'unauthenticated'", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket();
      const client = await connected(identity, socket);

      expect(client.state).toBe("unauthenticated");
      expect(client.authenticated).toBe(false);
      expect(client.peerNodeId).toBe(socket.workerNodeId);
      expect(socket.sent[0]).toMatchObject({ type: "hello", node_id: identity.nodeId });
    });

    it("rejects with client.proto_mismatch when proto ranges don't overlap", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({ protoMin: 5, protoMax: 5 });
      const client = makeClient(identity, socket, { protoMin: 1, protoMax: 1 });

      const connectPromise = client.connect();
      socket.simulateOpen();
      const err = await rejection(connectPromise);

      expect(err).toBeInstanceOf(WorkerProtocolError);
      expect(err.code).toBe(CLIENT_PROTO_MISMATCH);
      expect(client.state).toBe("closed");
    });

    it("throws if connect() is called on an already-open client", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket();
      const client = await connected(identity, socket);

      expect(() => client.connect()).toThrow(WorkerProtocolError);
    });

    it("rejects immediately if a method is called before connecting", async () => {
      const identity = await freshIdentity();
      const client = makeClient(identity, new FakeWorkerSocket());

      const err = await rejection(client.jobsList());
      expect(err.code).toBe(CLIENT_CLOSED);
    });

    it("ignores a duplicate hello frame after the handshake completed", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket();
      const client = await connected(identity, socket);
      const priorPeerNodeId = client.peerNodeId;

      socket.onmessage?.({
        data: JSON.stringify({
          v: 1,
          type: "hello",
          proto: { min: 1, max: 1 },
          agent: { name: "x", version: "0", platform: "y" },
          node_id: "different-node",
          nonce: "different-nonce",
        }),
      });

      expect(client.peerNodeId).toBe(priorPeerNodeId);
      expect(client.state).toBe("unauthenticated");
    });

    it("ignores unparseable frames without throwing", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket();
      const client = await connected(identity, socket);

      expect(() => socket.onmessage?.({ data: "not json" })).not.toThrow();
      expect(client.state).toBe("unauthenticated");
    });
  });

  describe("pairing and auth", () => {
    it("pairClaim authenticates using a one-time secret", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket();
      const client = await connected(identity, socket);

      await client.pairClaim("the-secret");

      expect(client.authenticated).toBe(true);
      const pairReq = socket.sent.find((f) => f.method === "pair.claim");
      expect(pairReq?.params).toEqual({ secret: "the-secret", node_id: identity.nodeId });
    });

    it("authProve signs the worker's hello nonce with real Ed25519 and authenticates", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({ workerNonce: "specific-nonce-xyz" });
      const client = await connected(identity, socket);

      await client.authProve();

      expect(client.authenticated).toBe(true);
      const proveReq = socket.sent.find((f) => f.method === "auth.prove");
      expect(typeof proveReq?.params).toBe("object");
      expect((proveReq?.params as Record<string, unknown>).sig).toBeDefined();
    });

    it("authProve surfaces the worker's error code on a bad signature", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: (method) => {
          if (method === "auth.prove") {
            return { error: { code: "auth.bad_signature", msg: "signature mismatch" } };
          }
          return { result: {} };
        },
      });
      const client = await connected(identity, socket);

      const err = await rejection(client.authProve());
      expect(err.code).toBe("auth.bad_signature");
      expect(client.authenticated).toBe(false);
    });
  });

  describe("requests", () => {
    it("rejects a request that never gets a response after requestTimeoutMs", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({ handleRequest: () => new Promise(() => {}) });
      const client = await connected(identity, socket, { requestTimeoutMs: 20 });

      const err = await rejection(client.pairClaim("secret"));
      expect(err.code).toBe(CLIENT_TIMEOUT);
    });

    it("close() rejects any in-flight request", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({ handleRequest: () => new Promise(() => {}) });
      const client = await connected(identity, socket);

      const pending = client.pairClaim("secret");
      client.close();

      const err = await rejection(pending);
      expect(err.code).toBe(CLIENT_CLOSED);
    });

    it("a remote close rejects in-flight requests and marks the client closed", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({ handleRequest: () => new Promise(() => {}) });
      const client = await connected(identity, socket);

      const pending = client.jobsList();
      socket.close();

      const err = await rejection(pending);
      expect(err.code).toBe(CLIENT_CLOSED);
      expect(client.state).toBe("closed");
    });
  });

  describe("jobs.* / fs.* methods", () => {
    async function pairedClient(
      identity: ClientIdentity,
      socket: FakeWorkerSocket,
    ): Promise<WorkerClient> {
      const client = await connected(identity, socket);
      await client.pairClaim("secret");
      return client;
    }

    it("jobsSubmit sends spec + client_job_id and returns the worker-assigned job_id", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: (method) => {
          if (method === "pair.claim") return { result: {} };
          if (method === "jobs.submit") return { result: { job_id: "job_abc" } };
          return { error: { code: "proto.unknown_method", msg: "?" } };
        },
      });
      const client = await pairedClient(identity, socket);

      const { jobId } = await client.jobsSubmit(
        { type: "train", labels_path: "x.slp" },
        "cj_1",
      );

      expect(jobId).toBe("job_abc");
      const submitReq = socket.sent.find((f) => f.method === "jobs.submit");
      expect(submitReq?.params).toEqual({
        spec: { type: "train", labels_path: "x.slp" },
        client_job_id: "cj_1",
      });
    });

    it("jobsCancel sends job_id + mode, defaulting to 'cancel'", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: (method) => {
          if (method === "pair.claim") return { result: {} };
          return { result: {} };
        },
      });
      const client = await pairedClient(identity, socket);

      await client.jobsCancel("job_abc");
      await client.jobsCancel("job_def", "stop");

      const cancelReqs = socket.sent.filter((f) => f.method === "jobs.cancel");
      expect(cancelReqs.map((f) => f.params)).toEqual([
        { job_id: "job_abc", mode: "cancel" },
        { job_id: "job_def", mode: "stop" },
      ]);
    });

    it("jobsStatus maps the snake_case result to a typed JobStatus", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: (method) => {
          if (method === "pair.claim") return { result: {} };
          if (method === "jobs.status") {
            return {
              result: {
                job_id: "job_abc",
                state: "completed",
                created_at: "2026-09-27T00:00:00Z",
                updated_at: "2026-09-27T01:00:00Z",
                result: { blobs: {} },
                error: null,
              },
            };
          }
          return { error: { code: "proto.unknown_method", msg: "?" } };
        },
      });
      const client = await pairedClient(identity, socket);

      const status = await client.jobsStatus("job_abc");
      expect(status).toEqual({
        jobId: "job_abc",
        state: "completed",
        createdAt: "2026-09-27T00:00:00Z",
        updatedAt: "2026-09-27T01:00:00Z",
        result: { blobs: {} },
        error: null,
      });
    });

    it("jobsList maps the summary array", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: (method) => {
          if (method === "pair.claim") return { result: {} };
          if (method === "jobs.list") {
            return {
              result: {
                jobs: [
                  { job_id: "job_1", state: "running", created_at: "t1" },
                  { job_id: "job_2", state: "completed", created_at: "t2" },
                ],
              },
            };
          }
          return { error: { code: "proto.unknown_method", msg: "?" } };
        },
      });
      const client = await pairedClient(identity, socket);

      const jobs = await client.jobsList();
      expect(jobs).toEqual([
        { jobId: "job_1", state: "running", createdAt: "t1" },
        { jobId: "job_2", state: "completed", createdAt: "t2" },
      ]);
    });

    it("fsMounts maps the mounts array", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: (method) => {
          if (method === "pair.claim") return { result: {} };
          if (method === "fs.mounts") {
            return { result: { mounts: [{ path: "/mnt/data", label: "Lab data" }] } };
          }
          return { error: { code: "proto.unknown_method", msg: "?" } };
        },
      });
      const client = await pairedClient(identity, socket);

      const mounts = await client.fsMounts();
      expect(mounts).toEqual([{ path: "/mnt/data", label: "Lab data" }]);
    });

    it("fsList sends path + offset and maps entries/total_count/has_more", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({
        handleRequest: (method) => {
          if (method === "pair.claim") return { result: {} };
          if (method === "fs.list") {
            return {
              result: {
                entries: [{ name: "a.slp", type: "file", size: 123 }],
                total_count: 1,
                has_more: false,
              },
            };
          }
          return { error: { code: "proto.unknown_method", msg: "?" } };
        },
      });
      const client = await pairedClient(identity, socket);

      const result = await client.fsList("/mnt/data", 10);
      expect(result).toEqual({
        entries: [{ name: "a.slp", type: "file", size: 123 }],
        totalCount: 1,
        hasMore: false,
      });
      const listReq = socket.sent.find((f) => f.method === "fs.list");
      expect(listReq?.params).toEqual({ path: "/mnt/data", offset: 10 });
    });
  });

  describe("jobsSubscribe / events", () => {
    async function pairedClient(
      identity: ClientIdentity,
      socket: FakeWorkerSocket,
    ): Promise<WorkerClient> {
      const client = await connected(identity, socket);
      await client.pairClaim("secret");
      return client;
    }

    it("registers the listener before sending the request, so backlog events emitted synchronously during the request handler are never missed", async () => {
      const identity = await freshIdentity();
      const received: WorkerEvent[] = [];
      const socket = new FakeWorkerSocket({
        handleRequest: (method, params, sock) => {
          if (method === "pair.claim") return { result: {} };
          if (method === "jobs.subscribe") {
            const jobId = params.job_id as string;
            // Mirrors the real worker: backlog events are pushed to the
            // wire BEFORE the subscribe request itself is acked.
            sock.emitEvent("job.status", jobId, 1, { state: "running" });
            sock.emitEvent("job.status", jobId, 2, { state: "completed" });
            return { result: {} };
          }
          return { error: { code: "proto.unknown_method", msg: "?" } };
        },
      });
      const client = await pairedClient(identity, socket);

      const unsubscribe = await client.jobsSubscribe("job_abc", 0, (event) =>
        received.push(event),
      );

      expect(received).toEqual([
        { topic: "job.status", seq: 1, jobId: "job_abc", data: { state: "running" } },
        { topic: "job.status", seq: 2, jobId: "job_abc", data: { state: "completed" } },
      ]);

      unsubscribe();
      socket.emitEvent("job.status", "job_abc", 3, { state: "ignored" });
      expect(received.length).toBe(2);
    });

    it("fans out events to multiple subscribers of the same job independently", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({ handleRequest: () => ({ result: {} }) });
      const client = await pairedClient(identity, socket);

      const a: WorkerEvent[] = [];
      const b: WorkerEvent[] = [];
      const unsubA = await client.jobsSubscribe("job_abc", 0, (e) => a.push(e));
      await client.jobsSubscribe("job_abc", 0, (e) => b.push(e));

      socket.emitEvent("job.log", "job_abc", 1, { line: "hello" });
      expect(a.length).toBe(1);
      expect(b.length).toBe(1);

      unsubA();
      socket.emitEvent("job.log", "job_abc", 2, { line: "world" });
      expect(a.length).toBe(1);
      expect(b.length).toBe(2);
    });

    it("ignores events for jobs nothing has subscribed to", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket();
      await pairedClient(identity, socket);

      expect(() => socket.emitEvent("job.log", "some-other-job", 1, {})).not.toThrow();
    });
  });

  describe("peerBlobPort", () => {
    it("is null when the worker doesn't announce a blob port", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket();
      const client = await connected(identity, socket);

      expect(client.peerBlobPort).toBeNull();
    });

    it("is set once the worker announces one in its hello", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({ blobPort: 9632 });
      const client = await connected(identity, socket);

      expect(client.peerBlobPort).toBe(9632);
    });
  });

  describe("fetchBlob", () => {
    async function sha256Hex(bytes: Uint8Array): Promise<string> {
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }

    it("throws blob.unknown if the worker never announced a blob port", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket(); // no blobPort
      const client = await connected(identity, socket);

      const err = await rejection(client.fetchBlob("abc123", 3));
      expect(err.code).toBe(BLOB_UNKNOWN);
    });

    it("fetches from http://<dialed host>:<blob_port>/blobs/<sha256>", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({ blobPort: 9632 });
      const content = new TextEncoder().encode("hello blob");
      const hash = await sha256Hex(content);
      let requestedUrl: string | undefined;
      const fetchImpl = (async (input: RequestInfo | URL) => {
        requestedUrl = String(input);
        return new Response(content, { status: 200 });
      }) as unknown as typeof fetch;
      const client = await connected(identity, socket, { fetchImpl });

      const bytes = await client.fetchBlob(hash, content.byteLength);

      expect(requestedUrl).toBe(`http://fake-worker:9632/blobs/${hash}`);
      expect(bytes).toEqual(content);
    });

    it("derives https for a wss:// dial URL", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({ blobPort: 9632 });
      const content = new TextEncoder().encode("secure blob");
      const hash = await sha256Hex(content);
      let requestedUrl: string | undefined;
      const fetchImpl = (async (input: RequestInfo | URL) => {
        requestedUrl = String(input);
        return new Response(content, { status: 200 });
      }) as unknown as typeof fetch;
      const client = new WorkerClient({
        url: "wss://fake-worker",
        identity,
        createSocket: () => socket,
        fetchImpl,
      });
      const connectPromise = client.connect();
      socket.simulateOpen();
      await connectPromise;

      await client.fetchBlob(hash, content.byteLength);

      expect(requestedUrl).toBe(`https://fake-worker:9632/blobs/${hash}`);
    });

    it("throws blob.unknown on a non-ok HTTP response", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({ blobPort: 9632 });
      const fetchImpl = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
      const client = await connected(identity, socket, { fetchImpl });

      const err = await rejection(client.fetchBlob("abc123"));
      expect(err.code).toBe(BLOB_UNKNOWN);
    });

    it("throws blob.unknown if the fetch itself fails", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({ blobPort: 9632 });
      const fetchImpl = (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch;
      const client = await connected(identity, socket, { fetchImpl });

      const err = await rejection(client.fetchBlob("abc123"));
      expect(err.code).toBe(BLOB_UNKNOWN);
    });

    it("throws blob.incomplete when the response size doesn't match", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({ blobPort: 9632 });
      const content = new TextEncoder().encode("short");
      const hash = await sha256Hex(content);
      const fetchImpl = (async () => new Response(content, { status: 200 })) as unknown as typeof fetch;
      const client = await connected(identity, socket, { fetchImpl });

      const err = await rejection(client.fetchBlob(hash, content.byteLength + 100));
      expect(err.code).toBe(BLOB_INCOMPLETE);
    });

    it("throws blob.hash_mismatch when the content doesn't match the claimed hash", async () => {
      const identity = await freshIdentity();
      const socket = new FakeWorkerSocket({ blobPort: 9632 });
      const content = new TextEncoder().encode("tampered content");
      const fetchImpl = (async () => new Response(content, { status: 200 })) as unknown as typeof fetch;
      const client = await connected(identity, socket, { fetchImpl });

      const err = await rejection(client.fetchBlob("not-the-real-hash", content.byteLength));
      expect(err.code).toBe(BLOB_HASH_MISMATCH);
    });

  });
});
