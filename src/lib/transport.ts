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

// ── Config ───────────────────────────────────────────────────────

const SIGNALING_HTTP =
  import.meta.env?.VITE_SIGNALING_HTTP || "https://signaling.sleap.ai";

const RELAY_URL =
  import.meta.env?.VITE_RELAY_URL || "https://signaling.sleap.ai/relay";

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
  private _serverJobId: string | null = null;

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
    console.log("[relay] send: JOB_SUBMIT -> POST /api/jobs/submit");
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
        // Worker may send entries with either `type: "directory"` (from
        // FS_LIST_RESPONSE protocol) or `is_dir: true` (from other sources)
        const entries = (data.entries as Array<Record<string, unknown>>) || [];
        const translated = {
          path: data.path,
          entries: entries.map((e) => ({
            name: e.name,
            type: e.type === "directory" || e.is_dir ? "directory" : "file",
            size: e.size,
          })),
          total_count: data.total_count ?? entries.length,
          has_more: data.has_more ?? false,
        };
        console.log(`[relay] SSE: received fs_list_res (path: ${data.path}, ${entries.length} entries)`);
        this._handler(`FS_LIST_RESPONSE::${JSON.stringify(translated)}`);
        break;
      }

      case "fs_mounts_res": {
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
        console.log("[relay] SSE: received job_progress");
        this._handler(`PROGRESS_REPORT::${JSON.stringify(data)}`);
        break;
      }

      default:
        console.log(`[relay] SSE: unhandled event type: ${type}`);
    }
  }
}
