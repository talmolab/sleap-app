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

import { sleapCmd } from "@/lib/sleapPlugin";

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

// ── RustTransport (Tauri native WebRTC via Rust backend) ─────

export class RustTransport implements Transport {
  private _ready = false;
  private _handler: ((data: string) => void) | null = null;

  readonly mode = "direct" as const;

  get ready(): boolean {
    return this._ready;
  }

  send(msg: string): void {
    if (!this._ready) {
      console.warn("[transport:rust] Cannot send — not connected");
      return;
    }
    import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke(sleapCmd("rtc_send"), { msg }).catch((err: unknown) => {
        console.error("[transport:rust] Send failed:", err);
      });
    });
  }

  onMessage(handler: (data: string) => void): void {
    this._handler = handler;
  }

  close(): void {
    import("@tauri-apps/api/core").then(({ invoke }) => {
      invoke(sleapCmd("rtc_disconnect_worker")).catch(() => {});
    });
    this._ready = false;
    this._handler = null;
  }

  _setReady(): void {
    this._ready = true;
  }

  _dispatchMessage(data: string): void {
    if (this._handler) {
      this._handler(data);
    }
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

  // E2E encryption state
  private _e2eSessionId: string | null = null;
  private _e2eSharedKey: CryptoKey | null = null;
  private _e2eReady = false;

  readonly mode = "relay" as const;

  constructor(config: RelayTransportConfig) {
    this._config = config;
  }

  get ready(): boolean {
    return this._ready;
  }

  /**
   * Open worker SSE channel, perform E2E key exchange, and mark as ready.
   * Key exchange uses ECDH P-256 + HKDF + AES-256-GCM.
   * Throws if key exchange fails after 2 attempts.
   */
  async open(): Promise<void> {
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

    // Perform E2E key exchange before marking ready
    await this._initKeyExchange();

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
        if (this._e2eReady) {
          this._sendWorkerMessage({ type: "fs_list_req", path, req_id: reqId, offset });
        } else {
          this._postFsList(path, reqId, offset);
        }
        break;
      }

      case "JOB_SUBMIT": {
        // JOB_SUBMIT::clientJobId::{specJson}
        const firstSep = payload.indexOf("::");
        const specJson = payload.substring(firstSep + 2);
        if (this._e2eReady) {
          this._postJobSubmitEncrypted(specJson);
        } else {
          this._postJobSubmit(specJson);
        }
        break;
      }

      case "JOB_CANCEL": {
        // JOB_CANCEL::jobId
        const jobId = this._serverJobId || payload;
        if (this._e2eReady) {
          this._sendWorkerMessage({ type: "job_cancel", job_id: jobId, mode: "cancel" });
        } else {
          this._postJobCancel(jobId);
        }
        break;
      }

      case "JOB_STOP":
        if (this._e2eReady && this._serverJobId) {
          this._sendWorkerMessage({ type: "job_cancel", job_id: this._serverJobId, mode: "stop" });
        } else {
          this._sendWorkerMessage({ type: "job_stop" });
        }
        break;

      case "CONTROL_COMMAND": {
        // In relay mode, the worker's WebSocket handler doesn't support
        // CONTROL_COMMAND. Use job_cancel instead — the worker's
        // _handle_job_cancel sends ZMQ "stop" to sleap-nn (graceful
        // early stop, same as CONTROL_COMMAND::{"command":"stop"}).
        if (this._serverJobId) {
          if (this._e2eReady) {
            this._sendWorkerMessage({ type: "job_cancel", job_id: this._serverJobId, mode: "stop" });
          } else {
            this._postJobCancel(this._serverJobId);
          }
        } else {
          console.warn("[relay] Cannot send CONTROL_COMMAND — no server job ID");
        }
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

    // Encrypt if E2E is active (but not the key_exchange itself)
    let outMessage: Record<string, unknown> = message;
    if (this._e2eReady && this._e2eSharedKey && msgType !== "key_exchange") {
      const { encrypt } = await import("./e2e");
      const { nonce, ciphertext } = await encrypt(this._e2eSharedKey, message);
      outMessage = {
        type: "encrypted_relay",
        session_id: this._e2eSessionId,
        nonce,
        ciphertext,
      };
      console.log(`[relay] send: ${msgType} -> encrypted -> POST /api/worker/message`);
    } else {
      console.log(`[relay] send: ${msgType} -> POST /api/worker/message`);
    }

    try {
      const res = await fetch(`${SIGNALING_HTTP}/api/worker/message`, {
        method: "POST",
        headers: this._authHeaders,
        body: JSON.stringify({ ...this._baseBody, message: outMessage }),
      });
      if (!res.ok) {
        console.error(`[relay] ERROR: POST /api/worker/message failed: ${res.status}`);
      }
    } catch (err) {
      console.error("[relay] ERROR: POST /api/worker/message failed:", err);
    }
  }

  /**
   * Submit a job with E2E encryption — generates job_id client-side since
   * the dedicated /api/jobs/submit endpoint is bypassed.
   */
  private async _postJobSubmitEncrypted(specJson: string): Promise<void> {
    console.log("[relay] send: JOB_SUBMIT -> encrypted -> POST /api/worker/message");
    try {
      const spec = JSON.parse(specJson);
      const jobId = `job_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
      this._serverJobId = jobId;

      await this._sendWorkerMessage({
        type: "job_assigned",
        job_id: jobId,
        config: spec,
      });

      console.log(`[relay] Job submitted (encrypted), client job_id: ${jobId}`);
      this._handler?.(`JOB_ACCEPTED::${jobId}`);
      this._openJobSSE(jobId);
    } catch (err) {
      console.error("[relay] ERROR: encrypted job submit failed:", err);
      this._handler?.(
        `JOB_FAILED::{"error":"${err instanceof Error ? err.message : String(err)}"}`,
      );
    }
  }

  // ── E2E key exchange ─────────────────────────────────────────

  private async _initKeyExchange(): Promise<void> {
    const { generateKeypair, deriveSharedKey, publicKeyToB64, publicKeyFromB64 } =
      await import("./e2e");

    this._e2eSessionId = crypto.randomUUID();
    const { privateKey, publicKeyRaw } = await generateKeypair();
    const pubB64 = publicKeyToB64(publicKeyRaw);

    const attempt = (): Promise<void> =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Key exchange timeout")), 5000);

        // Temporarily intercept SSE to catch key_exchange_response
        const originalHandler = this._workerSSE?.onmessage;
        if (this._workerSSE) {
          this._workerSSE.onmessage = async (event) => {
            let data: Record<string, unknown>;
            try {
              data = JSON.parse(event.data);
            } catch {
              return;
            }

            if (
              data.type === "key_exchange_response" &&
              data.session_id === this._e2eSessionId
            ) {
              clearTimeout(timeout);

              try {
                const workerPubRaw = publicKeyFromB64(data.public_key as string);
                this._e2eSharedKey = await deriveSharedKey(privateKey, workerPubRaw);
                this._e2eReady = true;
                console.log(
                  `[E2E] Key exchange complete (session ${this._e2eSessionId!.slice(0, 8)}...)`,
                );

                // Restore original handler
                if (this._workerSSE) this._workerSSE.onmessage = originalHandler ?? null;
                resolve();
              } catch (e) {
                reject(e);
              }
              return;
            }

            // Forward other messages to original handler
            if (originalHandler && this._workerSSE) originalHandler.call(this._workerSSE, event);
          };
        }

        // Send key exchange request
        this._sendWorkerMessage({
          type: "key_exchange",
          session_id: this._e2eSessionId!,
          public_key: pubB64,
        }).catch(reject);
      });

    // Try twice
    for (let i = 0; i < 2; i++) {
      try {
        await attempt();
        return;
      } catch (e) {
        console.warn(
          `[E2E] Key exchange attempt ${i + 1} failed: ${e instanceof Error ? e.message : e}`,
        );
        if (i === 0) continue;
      }
    }

    throw new Error(
      "Could not establish secure connection with worker. The worker may need to be updated.",
    );
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

  private async _handleSSEEvent(raw: string): Promise<void> {
    if (!this._handler) return;

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    // Decrypt encrypted relay messages
    if (data.type === "encrypted_relay") {
      if (!this._e2eReady || !this._e2eSharedKey) return;
      if (data.session_id !== this._e2eSessionId) return;
      const { decrypt } = await import("./e2e");
      const decrypted = await decrypt(
        this._e2eSharedKey,
        data.nonce as string,
        data.ciphertext as string,
      );
      if (!decrypted) return;
      data = decrypted;
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

        if (status === "complete" || status === "completed" || status === "success") {
          this._handler(`JOB_COMPLETE::${JSON.stringify(data)}`);
        } else if (status === "failed" || status === "error") {
          this._handler(`JOB_FAILED::${JSON.stringify(data)}`);
        }
        // "submitted", "accepted", "running" — informational
        break;
      }

      case "job_progress": {
        // RelayChannel sends epoch-level events:
        //   {type: "job_progress", event: "train_begin", wandb_url: "..."}
        //   {type: "job_progress", event: "epoch_end", epoch: N, logs: {"train/loss": ..., "val/loss": ...}}
        //   {type: "job_progress", event: "train_end"}
        const event = data.event as string;
        console.log(`[relay] SSE: received job_progress (event: ${event})`);

        // Forward as __PROGRESS_REPORT__ for trainingStore to handle
        this._handler(`PROGRESS_REPORT::${JSON.stringify(data)}`);

        // Also generate a log line for epoch_end so the user sees progress
        if (event === "epoch_end") {
          const logs = (data.logs ?? {}) as Record<string, number>;
          const epoch = data.epoch as number;
          const trainLoss = logs["train/loss"];
          const valLoss = logs["val/loss"];
          const logLine = `[Epoch ${epoch}] loss: ${trainLoss?.toFixed(4) ?? "?"} | val_loss: ${valLoss?.toFixed(4) ?? "?"}`;
          // Send as a regular log line (not CR::, not PROGRESS_REPORT::)
          this._handler(logLine);
        }
        break;
      }

      default:
        console.log(`[relay] SSE: unhandled event type: ${type}`);
    }
  }
}
