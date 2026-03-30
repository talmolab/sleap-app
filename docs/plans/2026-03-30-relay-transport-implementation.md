# Relay Transport Fallback Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add automatic relay fallback to connectStore so that when WebRTC ICE fails (10s timeout), the app seamlessly switches to REST + SSE communication via the signaling server — no user interaction needed.

**Architecture:** A `Transport` interface abstracts the communication layer. `WebRTCTransport` wraps the existing data channel. `RelayTransport` translates protocol messages to REST calls (`POST /api/fs/list`, `/api/jobs/submit`, `/api/worker/message`) and receives responses via SSE (`EventSource` on relay channels). The connectStore replaces `_dc` with `_transport` and all existing message handling stays identical.

**Tech Stack:** TypeScript, Zustand, browser `fetch` + `EventSource` APIs. No new dependencies.

**Design doc:** `docs/plans/2026-03-30-relay-transport-fallback.md`

**Branch:** `amick/connect-training-windows`

**Signaling server endpoints (already exist):**
- `POST /api/fs/list` — `{room_id, peer_id, path, req_id, offset}`
- `POST /api/jobs/submit` — `{room_id, peer_id, config}` → returns `{job_id}`
- `POST /api/jobs/{job_id}/cancel` — `{room_id, peer_id}`
- `POST /api/worker/message` — `{room_id, peer_id, message}` (generic)
- All require `Authorization: Bearer {jwt}` header

**Relay SSE channels (already exist):**
- `GET {RELAY_URL}/stream/worker:{peerId}` — filesystem responses (`fs_list_res`)
- `GET {RELAY_URL}/stream/{jobId}` — job events (`job_status`, `job_progress`)

**Relay URL:** `https://signaling.sleap.ai/relay`

**Note on mounts:** The dashboard gets mounts from `worker.properties.mounts` in the rooms API metadata, not via `FS_GET_MOUNTS`. The signaling server does NOT forward `fs_mounts_res` to the relay. For relay mode, we fetch mounts from the `/api/rooms/{roomId}/workers` endpoint or send `fs_get_mounts` via `/api/worker/message` and add `fs_mounts_res` forwarding to the signaling server. The simplest approach: use worker metadata from the rooms API (already fetched during `fetchRooms`).

---

## Task 1: Create Transport interface and WebRTCTransport

**Files:**
- Create: `src/lib/transport.ts`

### Step 1: Create the Transport interface and WebRTCTransport

Create `src/lib/transport.ts`:

```typescript
/**
 * Transport abstraction for worker communication.
 *
 * Two implementations:
 * - WebRTCTransport: wraps RTCDataChannel (direct P2P)
 * - RelayTransport: uses REST + SSE via signaling server
 *
 * The connectStore uses whichever is active — all message handling
 * (_handleDataChannelMessage) is identical for both.
 */

// ── Interface ────────────────────────────────────────────────────

export interface Transport {
  /** Send a protocol message (e.g., "FS_LIST_DIR::/path::0") */
  send(msg: string): void;
  /** Register handler for incoming protocol messages */
  onMessage(handler: (data: string) => void): void;
  /** Clean up connections */
  close(): void;
  /** Is the transport ready to send/receive? */
  readonly ready: boolean;
  /** Transport type for logging */
  readonly mode: "direct" | "relay";
}

// ── WebRTCTransport ──────────────────────────────────────────────

export class WebRTCTransport implements Transport {
  private _dc: RTCDataChannel;
  private _handler: ((data: string) => void) | null = null;

  readonly mode = "direct" as const;

  constructor(dc: RTCDataChannel) {
    this._dc = dc;
    dc.onmessage = (event) => {
      if (typeof event.data === "string" && this._handler) {
        this._handler(event.data);
      }
    };
  }

  get ready(): boolean {
    return this._dc.readyState === "open";
  }

  send(msg: string): void {
    if (!this.ready) {
      console.warn("[transport:webrtc] Cannot send — data channel not open");
      return;
    }
    this._dc.send(msg);
  }

  onMessage(handler: (data: string) => void): void {
    this._handler = handler;
  }

  close(): void {
    this._dc.close();
    this._handler = null;
  }
}
```

### Step 2: Run build to verify

Run: `cd /Users/amickl/repos/sleap-app && npm run build`
Expected: PASS

### Step 3: Commit

```bash
git add src/lib/transport.ts
git commit -m "feat: add Transport interface and WebRTCTransport"
```

---

## Task 2: Create RelayTransport

**Files:**
- Modify: `src/lib/transport.ts`

### Step 1: Add relay config constant

In `src/lib/transport.ts`, add after the imports:

```typescript
const SIGNALING_HTTP =
  import.meta.env?.VITE_SIGNALING_HTTP || "https://signaling.sleap.ai";

const RELAY_URL =
  import.meta.env?.VITE_RELAY_URL || "https://signaling.sleap.ai/relay";
```

### Step 2: Add RelayTransport class

Add to `src/lib/transport.ts`:

```typescript
// ── RelayTransport ───────────────────────────────────────────────

export interface RelayTransportConfig {
  jwt: string;
  roomId: string;
  peerId: string; // target worker's peer ID
}

export class RelayTransport implements Transport {
  private _config: RelayTransportConfig;
  private _handler: ((data: string) => void) | null = null;
  private _workerSSE: EventSource | null = null;
  private _jobSSEs: Map<string, EventSource> = new Map();
  private _ready = false;
  private _serverJobId: string | null = null; // server-assigned job ID

  readonly mode = "relay" as const;

  constructor(config: RelayTransportConfig) {
    this._config = config;
  }

  get ready(): boolean {
    return this._ready;
  }

  /** Open worker SSE channel and mark as ready */
  open(): void {
    const channel = `worker:${this._config.peerId}`;
    const url = `${RELAY_URL}/stream/${encodeURIComponent(channel)}`;
    console.log(`[relay] Opening SSE channel: ${channel}`);

    this._workerSSE = new EventSource(url);
    this._workerSSE.onmessage = (event) => {
      this._handleSSEEvent(event.data);
    };
    this._workerSSE.onerror = () => {
      console.warn("[relay] SSE connection error on worker channel — will auto-reconnect");
    };

    this._ready = true;
  }

  onMessage(handler: (data: string) => void): void {
    this._handler = handler;
  }

  send(msg: string): void {
    if (!this._handler) {
      console.warn("[relay] No message handler registered");
      return;
    }

    // Parse the protocol message and route to appropriate REST endpoint
    const separatorIdx = msg.indexOf("::");
    const msgType = separatorIdx === -1 ? msg : msg.substring(0, separatorIdx);
    const payload = separatorIdx === -1 ? "" : msg.substring(separatorIdx + 2);

    switch (msgType) {
      case "FS_GET_MOUNTS":
        this._sendWorkerMessage({ type: "fs_get_mounts" });
        break;

      case "FS_LIST_DIR": {
        // FS_LIST_DIR::path::offset
        const parts = payload.split("::");
        const path = parts[0];
        const offset = parseInt(parts[1] || "0");
        const reqId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        this._postFsList(path, reqId, offset);
        break;
      }

      case "JOB_SUBMIT": {
        // JOB_SUBMIT::clientJobId::{specJson}
        const firstSep = payload.indexOf("::");
        const specJson = payload.substring(firstSep + 2);
        this._postJobSubmit(specJson);
        break;
      }

      case "JOB_CANCEL": {
        // JOB_CANCEL::jobId
        const jobId = this._serverJobId || payload;
        this._postJobCancel(jobId);
        break;
      }

      case "JOB_STOP":
        this._sendWorkerMessage({ type: "job_stop" });
        break;

      case "CONTROL_COMMAND": {
        // CONTROL_COMMAND::{jsonPayload}
        // Forward as worker message — the signaling server pushes to
        // worker WebSocket, worker routes to ZMQ controller
        this._sendWorkerMessage({
          type: "control_command",
          payload: payload,
        });
        break;
      }

      default:
        console.warn(`[relay] Unknown outgoing message type: ${msgType}`);
    }
  }

  close(): void {
    if (this._workerSSE) {
      this._workerSSE.close();
      this._workerSSE = null;
    }
    for (const [id, sse] of this._jobSSEs) {
      sse.close();
      console.log(`[relay] Closed job SSE channel: ${id}`);
    }
    this._jobSSEs.clear();
    this._handler = null;
    this._ready = false;
    this._serverJobId = null;
  }

  // ── REST helpers ─────────────────────────────────────────────

  private get _authHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this._config.jwt}`,
    };
  }

  private get _baseBody() {
    return {
      room_id: this._config.roomId,
      peer_id: this._config.peerId,
    };
  }

  private async _postFsList(path: string, reqId: string, offset: number): Promise<void> {
    console.log(`[relay] send: FS_LIST_DIR::${path} -> POST /api/fs/list`);
    try {
      const res = await fetch(`${SIGNALING_HTTP}/api/fs/list`, {
        method: "POST",
        headers: this._authHeaders,
        body: JSON.stringify({ ...this._baseBody, path, req_id: reqId, offset }),
      });
      if (!res.ok) {
        console.error(`[relay] ERROR: POST /api/fs/list failed: ${res.status}`);
        this._handler?.(`FS_ERROR::http_error::Failed to list directory (${res.status})`);
      }
    } catch (err) {
      console.error("[relay] ERROR: POST /api/fs/list failed:", err);
      this._handler?.(`FS_ERROR::network_error::${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async _postJobSubmit(specJson: string): Promise<void> {
    console.log(`[relay] send: JOB_SUBMIT -> POST /api/jobs/submit`);
    try {
      const spec = JSON.parse(specJson);
      const res = await fetch(`${SIGNALING_HTTP}/api/jobs/submit`, {
        method: "POST",
        headers: this._authHeaders,
        body: JSON.stringify({ ...this._baseBody, config: spec }),
      });
      if (!res.ok) {
        console.error(`[relay] ERROR: POST /api/jobs/submit failed: ${res.status}`);
        this._handler?.(`JOB_FAILED::{"error":"Job submission failed (${res.status})"}`);
        return;
      }
      const data = await res.json();
      const serverJobId = data.job_id as string;
      this._serverJobId = serverJobId;
      console.log(`[relay] Job submitted, server job_id: ${serverJobId}`);

      // Emit JOB_ACCEPTED so connectStore tracks it
      this._handler?.(`JOB_ACCEPTED::${serverJobId}`);

      // Open SSE channel for this job's progress/status
      this._openJobSSE(serverJobId);
    } catch (err) {
      console.error("[relay] ERROR: POST /api/jobs/submit failed:", err);
      this._handler?.(`JOB_FAILED::{"error":"${err instanceof Error ? err.message : String(err)}"}`);
    }
  }

  private async _postJobCancel(jobId: string): Promise<void> {
    console.log(`[relay] send: JOB_CANCEL -> POST /api/jobs/${jobId}/cancel`);
    try {
      await fetch(`${SIGNALING_HTTP}/api/jobs/${jobId}/cancel`, {
        method: "POST",
        headers: this._authHeaders,
        body: JSON.stringify(this._baseBody),
      });
    } catch (err) {
      console.error("[relay] ERROR: POST /api/jobs/cancel failed:", err);
    }
  }

  private async _sendWorkerMessage(message: Record<string, unknown>): Promise<void> {
    const msgType = message.type as string;
    console.log(`[relay] send: ${msgType} -> POST /api/worker/message`);
    try {
      const res = await fetch(`${SIGNALING_HTTP}/api/worker/message`, {
        method: "POST",
        headers: this._authHeaders,
        body: JSON.stringify({ ...this._baseBody, message }),
      });
      if (!res.ok) {
        console.error(`[relay] ERROR: POST /api/worker/message failed: ${res.status}`);
      }
    } catch (err) {
      console.error("[relay] ERROR: POST /api/worker/message failed:", err);
    }
  }

  // ── SSE handling ─────────────────────────────────────────────

  private _openJobSSE(jobId: string): void {
    const url = `${RELAY_URL}/stream/${encodeURIComponent(jobId)}`;
    console.log(`[relay] SSE: opened job channel ${jobId}`);
    const es = new EventSource(url);
    es.onmessage = (event) => {
      this._handleSSEEvent(event.data);
    };
    es.onerror = () => {
      console.warn(`[relay] SSE connection error on job channel ${jobId} — will auto-reconnect`);
    };
    this._jobSSEs.set(jobId, es);
  }

  private _handleSSEEvent(raw: string): void {
    if (!this._handler) return;

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    const type = data.type as string;

    switch (type) {
      case "fs_list_res": {
        // Translate to FS_LIST_RESPONSE::{json}
        // The connectStore expects {entries: [{name, type, size}]}
        const entries = (data.entries as Array<Record<string, unknown>>) || [];
        const translated = {
          path: data.path,
          entries: entries.map((e) => ({
            name: e.name,
            type: e.is_dir ? "directory" : "file",
            size: e.size,
          })),
          total_count: data.total_count ?? entries.length,
          has_more: data.has_more ?? false,
        };
        console.log(`[relay] SSE: received fs_list_res (path: ${data.path})`);
        this._handler(`FS_LIST_RESPONSE::${JSON.stringify(translated)}`);
        break;
      }

      case "fs_mounts_res": {
        // Translate to FS_MOUNTS_RESPONSE::{json}
        console.log("[relay] SSE: received fs_mounts_res");
        const mounts = data.mounts ?? data.entries ?? [];
        this._handler(`FS_MOUNTS_RESPONSE::${JSON.stringify(mounts)}`);
        break;
      }

      case "worker_path_error":
      case "fs_error": {
        const errorMsg = (data.error ?? data.message ?? "Unknown error") as string;
        console.log(`[relay] SSE: received ${type}: ${errorMsg}`);
        this._handler(`FS_ERROR::relay_error::${errorMsg}`);
        break;
      }

      case "status":
      case "job_status": {
        const status = data.status as string;
        const jobId = data.job_id as string;
        console.log(`[relay] SSE: received job_status (status: ${status}, job_id: ${jobId})`);

        if (status === "completed" || status === "success") {
          this._handler(`JOB_COMPLETE::${JSON.stringify(data)}`);
        } else if (status === "failed" || status === "error") {
          this._handler(`JOB_FAILED::${JSON.stringify(data)}`);
        }
        // "submitted", "running" — informational, no protocol message needed
        break;
      }

      case "job_progress": {
        // Forward as PROGRESS_REPORT for training store to handle
        console.log("[relay] SSE: received job_progress");
        this._handler(`PROGRESS_REPORT::${JSON.stringify(data)}`);
        break;
      }

      default:
        // Unknown SSE event — log but don't forward
        console.log(`[relay] SSE: unhandled event type: ${type}`);
    }
  }
}
```

### Step 3: Run build to verify

Run: `cd /Users/amickl/repos/sleap-app && npm run build`
Expected: PASS

### Step 4: Commit

```bash
git add src/lib/transport.ts
git commit -m "feat: add RelayTransport with REST + SSE message translation"
```

---

## Task 3: Refactor connectStore to use Transport

**Files:**
- Modify: `src/stores/connectStore.ts`

### Step 1: Update imports and state

Add import at top:
```typescript
import type { Transport } from "@/lib/transport";
import { WebRTCTransport, RelayTransport } from "@/lib/transport";
```

Update `ConnectState` interface:
- Replace `_dc: RTCDataChannel | null` with `_transport: Transport | null`
- Add `transportMode: "direct" | "relay" | null`

Update initial state:
- Replace `_dc: null` with `_transport: null`
- Add `transportMode: null`

### Step 2: Update disconnect

In `disconnect()`, replace:
```typescript
const { _ws, _pc, _dc } = get();
if (_dc) _dc.close();
```
with:
```typescript
const { _ws, _pc, _transport } = get();
if (_transport) _transport.close();
```

And in the `set()` call, replace `_dc: null` with `_transport: null, transportMode: null`.

### Step 3: Update connectToWorker with ICE timeout + relay fallback

Replace the entire `connectToWorker` implementation with:

1. Create `RTCPeerConnection` + data channel (same ICE servers)
2. Start 10s timeout timer
3. On `dc.onopen`:
   - Cancel timer
   - `_transport = new WebRTCTransport(dc)`
   - `_transport.onMessage(get()._handleDataChannelMessage)`
   - `_transport.send(MSG_FS_GET_MOUNTS)`
   - `set({ _transport, transportMode: "direct" })`
   - Log: `[connect] Data channel open → using WebRTC transport`
4. On timeout:
   - Close `pc`
   - `_transport = new RelayTransport({ jwt, roomId, peerId })`
   - `_transport.onMessage(get()._handleDataChannelMessage)`
   - `_transport.open()`
   - `_transport.send(MSG_FS_GET_MOUNTS)`
   - `set({ _transport, transportMode: "relay", _pc: null })`
   - Log: `[connect] ICE timeout after 10s → falling back to relay transport`

Keep ICE candidate handling and SDP offer the same (needed for the WebRTC attempt).

### Step 4: Update browseRemoteDir, submitJob, cancelJob, stopJob, sendControlCommand

Replace all `_dc` references with `_transport`:

```typescript
// browseRemoteDir
const { _transport } = get();
if (!_transport || !_transport.ready) {
  throw new Error("Not connected to worker");
}
// ... _transport.send(buildMessage(MSG_FS_LIST_DIR, path, "0"));

// submitJob
const { _transport } = get();
if (!_transport || !_transport.ready) {
  throw new Error("Not connected to worker");
}
// ... _transport.send(buildMessage(MSG_JOB_SUBMIT, jobId, JSON.stringify(spec)));

// cancelJob
const { _transport } = get();
if (_transport && _transport.ready) {
  _transport.send(buildMessage(MSG_JOB_CANCEL, jobId));
}

// stopJob
const { _transport } = get();
if (_transport && _transport.ready) {
  _transport.send(buildMessage(MSG_JOB_STOP));
}

// sendControlCommand
const { _transport } = get();
if (_transport && _transport.ready) {
  _transport.send(buildMessage(MSG_CONTROL_COMMAND, payload));
}
```

### Step 5: Run build and tests

Run: `cd /Users/amickl/repos/sleap-app && npm run build && npm test -- --run`
Expected: PASS

### Step 6: Commit

```bash
git add src/stores/connectStore.ts
git commit -m "refactor: replace _dc with Transport abstraction and add relay fallback"
```

---

## Task 4: Handle mounts in relay mode

The signaling server does NOT forward `fs_mounts_res` to the relay. The dashboard gets mounts from worker metadata in the rooms API. We need a solution for relay mode.

**Files:**
- Modify: `src/stores/connectStore.ts`

### Step 1: Fetch mounts from worker metadata during fetchRooms

The `/api/rooms/{roomId}/workers` endpoint already returns worker properties including mounts. When in relay mode, use this data instead of relying on `FS_GET_MOUNTS`.

In the `connectToWorker` relay fallback path, after creating the `RelayTransport`, populate the worker's mounts from the already-fetched worker data in `workers` state:

```typescript
// In relay fallback path, after setting transport:
const worker = get().workers.find((w) => w.peerId === workerId);
if (worker && worker.mounts.length > 0) {
  console.log("[connect] Using mounts from worker metadata:", worker.mounts);
  // Skip FS_GET_MOUNTS — we already have the data
} else {
  // Try FS_GET_MOUNTS via relay (may not work if server doesn't forward response)
  _transport.send(MSG_FS_GET_MOUNTS);
}
```

Alternatively, add `fs_mounts_res` forwarding to the signaling server (requires a one-line change in server.py). This is the cleaner long-term fix but requires a server deployment.

### Step 2: Run build

Run: `cd /Users/amickl/repos/sleap-app && npm run build`
Expected: PASS

### Step 3: Commit

```bash
git add src/stores/connectStore.ts
git commit -m "fix: handle mounts in relay mode using worker metadata"
```

---

## Task 5: Integration verification

### Step 1: Run full build

Run: `cd /Users/amickl/repos/sleap-app && npm run build`
Expected: No errors

### Step 2: Run all tests

Run: `cd /Users/amickl/repos/sleap-app && npm test -- --run`
Expected: All tests pass

### Step 3: Lint new files

Run: `npx eslint src/lib/transport.ts`
Expected: 0 errors

### Step 4: Verify WebRTC still works (institution WiFi)

Run: `npm run dev`
Expected:
- Connect to room, select worker
- Console shows: `[connect] ICE state: completed → using WebRTC transport`
- Filesystem browsing, training, inference all work normally
- `transportMode` is "direct"

### Step 5: Verify relay fallback (home WiFi or no TURN)

Remove TURN servers from `connectToWorker` ICE config temporarily, or test from home WiFi.
Expected:
- Connect to room, select worker
- Console shows: `[connect] ICE timeout after 10s → falling back to relay transport`
- Console shows: `[relay] Opening SSE channel: worker:{peerId}`
- Filesystem browsing works via REST + SSE
- Training submission works via REST, progress via SSE
- `transportMode` is "relay"

### Step 6: Commit any fixes

```bash
git add -A
git commit -m "fix: resolve integration issues from relay transport"
```

---

## Summary

| Task | Component | Files | Description |
|------|-----------|-------|-------------|
| 1 | Transport interface + WebRTCTransport | `transport.ts` | Interface + wrapper for existing data channel |
| 2 | RelayTransport | `transport.ts` | REST + SSE implementation with message translation |
| 3 | connectStore refactor | `connectStore.ts` | Replace `_dc` with `_transport`, add ICE timeout + fallback |
| 4 | Mounts handling | `connectStore.ts` | Use worker metadata for mounts in relay mode |
| 5 | Integration verification | — | Build, test, E2E on both transports |

**Total: 5 tasks**

---

## Conventions Reference

- **Path alias**: `@/` → `./src/` in imports
- **Logging prefix**: `[connect]` for transport decisions, `[relay]` for relay operations
- **Signaling server**: `SIGNALING_HTTP` env var or `https://signaling.sleap.ai`
- **Relay server**: `RELAY_URL` env var or `https://signaling.sleap.ai/relay`
- **Build**: `npm run build` for type checking + production build
- **Tests**: `npm test -- --run` for full test suite
