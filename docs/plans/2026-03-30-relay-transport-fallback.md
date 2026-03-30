# Relay Transport Fallback Design

**Goal:** When WebRTC ICE fails (e.g., home WiFi to institutional worker), automatically fall back to relay mode using the signaling server's REST + SSE infrastructure. The fallback is seamless — the user sees no difference, and the rest of the app (stores, panels) requires zero changes.

**Branch:** `amick/connect-training-windows` (off latest `main`)

**Motivation:** WebRTC direct P2P works on institutional networks (same LAN/VPN), but fails from home WiFi due to incompatible NATs and browser mDNS privacy. The signaling server already has a relay infrastructure (REST API + SSE fanout) that the sleap-RTC dashboard uses for all its worker communication. This design adds relay as a fallback transport for sleap-app, reusing that same infrastructure.

---

## Architecture

### Transport Interface

A `Transport` interface abstracts the communication layer. Two implementations:

- **`WebRTCTransport`** — wraps the existing `RTCDataChannel`. `send()` calls `dc.send()`, messages arrive via `dc.onmessage`. This is what the app uses today.
- **`RelayTransport`** — translates protocol messages to REST calls, receives responses via SSE, and feeds them back as protocol messages to the same handler.

```typescript
interface Transport {
  send(msg: string): void;
  onMessage(handler: (data: string) => void): void;
  close(): void;
  readonly ready: boolean;
}
```

The connectStore replaces `_dc: RTCDataChannel | null` with `_transport: Transport | null`. All existing message handling (`_handleDataChannelMessage`) stays identical — it receives protocol messages from either transport.

### New Files

- `src/lib/transport.ts` — `Transport` interface, `WebRTCTransport`, `RelayTransport`

### Modified Files

- `src/stores/connectStore.ts` — Replace `_dc` with `_transport`, add ICE timeout + relay fallback in `connectToWorker`

### Unchanged

- `src/stores/trainingStore.ts` — zero changes
- `src/stores/inferenceStore.ts` — zero changes
- All panel components — zero changes

---

## Connection Flow

### Current (WebRTC only)

1. Create `RTCPeerConnection` + data channel
2. Send SDP offer via signaling WebSocket
3. Receive SDP answer + ICE candidates
4. Wait for ICE to connect, data channel opens
5. Send `FS_GET_MOUNTS`

### New (WebRTC with relay fallback)

1. Create `RTCPeerConnection` + data channel (same)
2. Send SDP offer via signaling WebSocket (same)
3. **Start 10-second ICE timer**
4. **If ICE completes before timer:**
   - Cancel timer
   - `_transport = new WebRTCTransport(dc)`
   - `transportMode = "direct"`
   - Log: `[connect] ICE completed -> using WebRTC transport`
5. **If timer fires before ICE completes:**
   - Close `RTCPeerConnection`
   - `_transport = new RelayTransport({signalingUrl, relayUrl, jwt, roomId, peerId})`
   - `transportMode = "relay"`
   - Log: `[connect] ICE timeout after 10s -> falling back to relay transport`
6. Either way:
   - `_transport.onMessage(this._handleDataChannelMessage)`
   - Send `FS_GET_MOUNTS`
   - Set `connectionStatus = "connected"`

**Edge case:** If ICE succeeds after the timer fires, we ignore it and stay on relay. No transport switching mid-session.

### State Changes

- Replace `_dc: RTCDataChannel | null` with `_transport: Transport | null`
- Add `transportMode: "direct" | "relay" | null`
- Keep `_pc: RTCPeerConnection | null` (needed for WebRTC attempt)
- `connectionStatus` shows `"connected"` in both cases

---

## RelayTransport

### Constructor

```typescript
RelayTransport({
  signalingUrl: string,   // e.g., "https://signaling.sleap.ai"
  relayUrl: string,       // relay server URL (may be same as signaling)
  jwt: string,
  roomId: string,
  peerId: string,         // target worker's peer ID
})
```

### Lifecycle

1. **`open()`** — Opens `worker:{peerId}` SSE channel immediately via `new EventSource(relayUrl/stream/worker:{peerId})`. Registers handler that translates SSE events to protocol messages.

2. **`send(msg)`** — Parses the protocol message, determines which REST endpoint to call, makes the `fetch()`. For `JOB_SUBMIT`, captures the server-returned `job_id` and opens a second SSE channel on `job_{id}`.

3. **`close()`** — Closes all `EventSource` connections, clears state.

### Message Translation: Outgoing (send -> REST)

| Protocol Message | REST Call |
|---|---|
| `FS_GET_MOUNTS` | `POST /api/worker/message` with `{type: "fs_get_mounts"}` |
| `FS_LIST_DIR::path::offset` | `POST /api/fs/list` with `{path, offset, req_id}` |
| `JOB_SUBMIT::jobId::{spec}` | `POST /api/jobs/submit` with `{config: spec}` |
| `JOB_CANCEL::jobId` | `POST /api/jobs/{jobId}/cancel` |
| `JOB_STOP` | `POST /api/worker/message` with stop payload |
| `CONTROL_COMMAND::payload` | `POST /api/worker/message` with control payload |

### Message Translation: Incoming (SSE -> protocol message)

| SSE Event (channel) | Protocol Message |
|---|---|
| `fs_list_res` on `worker:{peerId}` | `FS_LIST_RESPONSE::{json}` |
| `fs_mounts_res` on `worker:{peerId}` | `FS_MOUNTS_RESPONSE::{json}` |
| `fs_error` / `worker_path_error` on `worker:{peerId}` | `FS_ERROR::error::message` |
| `job_status` with `status:"completed"` on `job_{id}` | `JOB_COMPLETE::{json}` |
| `job_status` with `status:"failed"` on `job_{id}` | `JOB_FAILED::{json}` |
| `job_progress` on `job_{id}` | Progress data forwarded to handler |
| `CR::` prefixed events on `job_{id}` | `CR::{line}` (tqdm progress) |
| `PROGRESS_REPORT::` events on `job_{id}` | `PROGRESS_REPORT::{payload}` |

### Authentication

All REST calls include `Authorization: Bearer {jwt}` header, same as the dashboard.

### SSE Reconnection

`EventSource` auto-reconnects on connection drop (browser built-in). The relay server replays buffered events (up to 200 per channel). No custom retry logic needed.

### Error Handling

REST failures are translated to protocol error messages:
- 401 Unauthorized -> re-auth needed
- 404 (worker offline) -> `FS_ERROR::not_found::Worker not available`
- 500 -> `FS_ERROR::server_error::message`

---

## Logging

### Transport Decision

```
[connect] Attempting WebRTC connection to worker: runai-1
[connect] ICE state: checking...
[connect] ICE state: completed -> using WebRTC transport
```

or:

```
[connect] Attempting WebRTC connection to worker: runai-1
[connect] ICE state: checking...
[connect] ICE timeout after 10s -> falling back to relay transport
[connect] Relay: opened SSE channel worker:worker-acct_VX9-amick-tr-8323e8
[connect] Relay: FS_GET_MOUNTS -> POST /api/worker/message
[connect] Relay: received FS_MOUNTS_RESPONSE via SSE
```

### Per-Operation (RelayTransport)

```
[relay] send: FS_LIST_DIR::/root/vast -> POST /api/fs/list
[relay] send: JOB_SUBMIT::job_abc::{...} -> POST /api/jobs/submit (job_id: job_a1b2c3d4)
[relay] send: CONTROL_COMMAND::{"command":"stop"} -> POST /api/worker/message
[relay] SSE: received fs_list_res (req_id: uuid-123)
[relay] SSE: received job_status (status: completed)
[relay] SSE: opened job channel job_a1b2c3d4
```

### Errors

```
[relay] ERROR: POST /api/fs/list failed: 401 Unauthorized
[relay] ERROR: SSE connection lost on worker:xyz -> reconnecting...
```

---

## Data Flow Diagram

```
sleap-app (browser)          Signaling Server              Worker
   |                              |                          |
   |-- EventSource --------------->| (SSE: listen for         |
   |   /stream/worker:xyz         |  worker responses)       |
   |                              |                          |
   |-- POST /api/fs/list -------->|-- WebSocket ------------->|
   |                              |                          |
   |                              |<-- WebSocket response ---|
   |                              |   (publishes to relay)   |
   |<-- SSE event ----------------|                          |
   |   fs_list_res                |                          |
```

The worker's code doesn't change. It already handles WebSocket messages from the signaling server (the dashboard uses this today). The relay fallback is purely a client-side change in sleap-app.

---

## Key Design Decisions

1. **Automatic fallback** — no user interaction needed. ICE timeout triggers silent switch.
2. **Transport interface** — clean abstraction, same `_handleDataChannelMessage` for both transports.
3. **Protocol translation in RelayTransport** — connectStore speaks the same protocol regardless of transport.
4. **SSE open on connect** — `worker:{peerId}` channel opened immediately so `FS_GET_MOUNTS` response is received.
5. **Job SSE opened per-job** — `job_{id}` channel opened when `JOB_SUBMIT` is sent, since the channel name includes the job ID returned by the server.
6. **10-second ICE timeout** — long enough for legitimate slow NAT traversal, short enough to not frustrate users.

## Future Considerations

- **Relay-only filesystem browsing** — currently, browsing the worker filesystem requires a full peer connection (WebRTC or relay to a specific worker). With relay, filesystem browsing could use the signaling server without "occupying" a worker, since the worker just handles the request and responds without a dedicated connection.
- **PyQt client relay fallback** — the same pattern can be backported to the PyQt SLEAP client, which currently has no fallback when ICE fails (retries 5 times then gives up).
- **Tailscale integration** — could be a third `Transport` implementation for users who prefer VPN-based connectivity.
