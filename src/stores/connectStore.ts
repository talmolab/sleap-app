import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  WorkerInfo,
  Credentials,
  FileEntry,
  JobSpec,
  JobResult,
} from "@/lib/sleapConnect";
import {
  buildMessage,
  parseMessage,
  generateJobId,
  MSG_JOB_SUBMIT,
  MSG_JOB_CANCEL,
  MSG_JOB_STOP,
  MSG_JOB_LOG,
  MSG_CONTROL_COMMAND,
  MSG_JOB_ACCEPTED,
  MSG_JOB_REJECTED,
  MSG_JOB_PROGRESS,
  MSG_JOB_COMPLETE,
  MSG_JOB_FAILED,
  MSG_AUTH_CHALLENGE,
  MSG_AUTH_RESPONSE,
  MSG_AUTH_SUCCESS,
  MSG_AUTH_FAILURE,
  MSG_FS_GET_MOUNTS,
  MSG_FS_MOUNTS_RESPONSE,
  MSG_FS_LIST_DIR,
  MSG_FS_LIST_RESPONSE,
  MSG_FS_ERROR,
  MSG_SEPARATOR,
} from "@/lib/sleapConnect";
import { isTauri } from "@/platform/index";
import type { Transport } from "@/lib/transport";
import { WebRTCTransport, RelayTransport } from "@/lib/transport";

// ── Signaling server config ──────────────────────────────────────
const SIGNALING_WS =
  import.meta.env?.VITE_SIGNALING_WS || "wss://signaling.sleap.ai/ws";

const SIGNALING_HTTP =
  import.meta.env?.VITE_SIGNALING_HTTP || "https://signaling.sleap.ai";

// ── Types ─────────────────────────────────────────────────────────

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

export interface RoomInfo {
  roomId: string;
  name: string | null;
  role: string;
  workerCount?: number;
}

interface PendingFsRequest {
  resolve: (result: { entries: FileEntry[]; hasMore: boolean }) => void;
  reject: (err: Error) => void;
}

interface PendingJobCallbacks {
  onProgress: (line: string, isCarriageReturn?: boolean) => void;
  onComplete: (result: JobResult) => void;
  onModelComplete?: (result: JobResult) => void; // per-model completion for multi-model pipelines
  remainingCompletions: number; // resolve only when this reaches 0
}

interface ConnectState {
  // Auth
  credentials: Credentials | null;

  // Connection
  connectionStatus: ConnectionStatus;
  connectionError: string | null;
  roomId: string | null;
  availableRooms: RoomInfo[];

  // Workers
  workers: WorkerInfo[];
  selectedWorkerId: string | null;

  // Transport
  transportMode: "direct" | "relay" | null;

  // Internal (not persisted)
  _ws: WebSocket | null;
  _pc: RTCPeerConnection | null;
  _transport: Transport | null;
  _connectGeneration: number;
  _iceServers: RTCIceServer[];
  _pendingFs: Map<string, PendingFsRequest>;
  _pendingJobs: Map<string, PendingJobCallbacks>;

  // Actions
  setCredentials: (creds: Credentials | null) => void;
  connect: (roomId: string) => Promise<void>;
  disconnect: () => void;
  selectWorker: (workerId: string | null) => void;
  connectToWorker: (workerId: string) => Promise<void>;
  browseRemoteDir: (path: string) => Promise<FileEntry[]>;
  submitJob: (
    spec: JobSpec,
    onProgress: (line: string, isCarriageReturn?: boolean) => void,
    options?: { expectedCompletions?: number; onModelComplete?: (result: JobResult) => void },
  ) => Promise<JobResult>;
  cancelJob: (jobId: string) => void;
  stopJob: () => void;
  sendControlCommand: (command: string) => void;
  loadCredentialsFromDisk: () => Promise<void>;
  fetchRooms: () => Promise<void>;

  // Internal handlers
  _handleSignalingMessage: (msg: Record<string, unknown>) => void;
  _handleDataChannelMessage: (data: string) => void;
}

export const useConnectStore = create<ConnectState>()(
  persist(
    (set, get) => ({
      // ── Initial state ────────────────────────────────────────
      credentials: null,
      connectionStatus: "disconnected",
      connectionError: null,
      roomId: null,
      availableRooms: [],
      workers: [],
      selectedWorkerId: null,
      transportMode: null,
      _ws: null,
      _pc: null,
      _transport: null,
      _connectGeneration: 0,
      _iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
      _pendingFs: new Map(),
      _pendingJobs: new Map(),

      // ── Auth ─────────────────────────────────────────────────
      setCredentials: (creds) => set({ credentials: creds }),

      loadCredentialsFromDisk: async () => {
        if (!isTauri) return;
        try {
          const { readTextFile, exists } = await import(
            "@tauri-apps/plugin-fs"
          );
          const { homeDir } = await import("@tauri-apps/api/path");
          const home = await homeDir();
          const credPath = `${home}/.sleap-rtc/credentials.json`;
          const fileExists = await exists(credPath);
          if (!fileExists) return;
          const text = await readTextFile(credPath);
          const data = JSON.parse(text);
          if (data.jwt && data.user?.username) {
            set({
              credentials: {
                jwt: data.jwt,
                username: data.user.username,
                avatarUrl: data.user.avatar_url,
                defaultRoom: data.default_room,
                accountKey: data.account_key,
                privateKey: data.private_key,
              },
            });

            if (data.private_key) {
              try {
                const { importPrivateKey, storeSigningKey } = await import("@/lib/auth");
                const cryptoKey = await importPrivateKey(data.private_key);
                await storeSigningKey(cryptoKey);
                console.log("[connect] Private key imported into IndexedDB");
              } catch (err) {
                console.warn("[connect] Failed to import private key:", err);
              }
            }
          }
        } catch (err) {
          console.warn("[connect] Failed to load credentials:", err);
        }
      },

      fetchRooms: async () => {
        const { credentials } = get();
        if (!credentials) return;
        try {
          const res = await fetch(`${SIGNALING_HTTP}/api/auth/rooms`, {
            headers: { Authorization: `Bearer ${credentials.jwt}` },
          });
          if (!res.ok) {
            console.warn("[connect] Failed to fetch rooms:", res.status);
            return;
          }
          const data = await res.json();
          const now = Date.now() / 1000;
          const activeRooms = (data.rooms as Array<Record<string, unknown>>).filter((r) => {
            const expiresAt = r.expires_at as number | null;
            return !expiresAt || expiresAt > now;
          });
          const rooms: RoomInfo[] = await Promise.all(
            activeRooms.map(async (r) => {
              const roomId = r.room_id as string;
              // Fetch worker count for each room
              let workerCount = 0;
              try {
                const wRes = await fetch(
                  `${SIGNALING_HTTP}/api/rooms/${roomId}/workers`,
                  { headers: { Authorization: `Bearer ${credentials.jwt}` } },
                );
                if (wRes.ok) {
                  const wData = await wRes.json();
                  workerCount = wData.count ?? 0;
                }
              } catch {
                // Worker count fetch failed — non-critical
              }
              return {
                roomId,
                name: (r.name as string) || null,
                role: r.role as string,
                workerCount,
              };
            }),
          );
          set({ availableRooms: rooms });
        } catch (err) {
          console.warn("[connect] Failed to fetch rooms:", err);
        }
      },

      // ── Connection ───────────────────────────────────────────
      connect: async (roomId: string) => {
        const { credentials } = get();
        if (!credentials) {
          set({
            connectionStatus: "error",
            connectionError: "Not logged in",
          });
          return;
        }

        set({ connectionStatus: "connecting", connectionError: null, roomId });

        try {
          // Connect WebSocket to signaling server
          const wsUrl = `${SIGNALING_WS}?token=${encodeURIComponent(credentials.jwt)}`;
          const ws = new WebSocket(wsUrl);

          ws.onopen = () => {
            console.log("[connect] WebSocket connected");
            // Register as client
            ws.send(
              JSON.stringify({
                type: "register",
                peer_id: credentials.username,
                room_id: roomId,
                role: "app",
                jwt: credentials.jwt,
                metadata: {
                  tags: ["sleap-app"],
                  properties: {
                    platform: "sleap-app",
                  },
                },
              }),
            );
          };

          ws.onmessage = (event) => {
            try {
              const msg = JSON.parse(event.data);
              get()._handleSignalingMessage(msg);
            } catch {
              console.warn("[connect] Non-JSON signaling message:", event.data);
            }
          };

          ws.onerror = (err) => {
            console.error("[connect] WebSocket error:", err);
            set({
              connectionStatus: "error",
              connectionError: "WebSocket connection failed",
            });
          };

          ws.onclose = () => {
            console.log("[connect] WebSocket closed");
            const { connectionStatus } = get();
            if (connectionStatus !== "disconnected") {
              set({
                connectionStatus: "disconnected",
                workers: [],
                selectedWorkerId: null,
              });
            }
          };

          set({ _ws: ws });
        } catch (err) {
          set({
            connectionStatus: "error",
            connectionError:
              err instanceof Error ? err.message : String(err),
          });
        }
      },

      disconnect: () => {
        const { _ws, _pc, _transport, _connectGeneration } = get();
        if (_transport) _transport.close();
        if (_pc) _pc.close();
        if (_ws) _ws.close();
        set({
          connectionStatus: "disconnected",
          connectionError: null,
          roomId: null,
          workers: [],
          selectedWorkerId: null,
          transportMode: null,
          _ws: null,
          _pc: null,
          _transport: null,
          _connectGeneration: _connectGeneration + 1, // invalidate pending timeouts
        });
      },

      selectWorker: (workerId) => set({ selectedWorkerId: workerId }),

      connectToWorker: async (workerId: string) => {
        const { _ws, credentials, roomId, _connectGeneration } = get();
        if (!_ws || !credentials || !roomId) return;

        // Increment generation to invalidate any previous connectToWorker attempt
        const gen = _connectGeneration + 1;
        set({ selectedWorkerId: workerId, _connectGeneration: gen });

        console.log("[connect] Attempting WebRTC connection to worker:", workerId);

        // ── Helper to finalize connection with a transport ─────
        let settled = false;
        const finalize = (transport: Transport, mode: "direct" | "relay") => {
          if (settled) return;
          if (gen !== get()._connectGeneration) {
            console.log("[connect] Stale connection attempt (gen mismatch), ignoring");
            transport.close();
            return;
          }
          settled = true;
          transport.onMessage((data) => get()._handleDataChannelMessage(data));

          // For relay mode, the signaling server doesn't forward fs_mounts_res
          // to the relay. Use mounts from worker metadata (already in state
          // from peer_list). For WebRTC, request mounts as before.
          if (mode === "relay") {
            const worker = get().workers.find((w) => w.peerId === workerId);
            if (worker && worker.mounts.length > 0) {
              console.log("[connect] Using mounts from worker metadata:", worker.mounts);
            } else {
              // Fallback: try FS_GET_MOUNTS via relay (may not get a response)
              transport.send(MSG_FS_GET_MOUNTS);
            }
          } else {
            transport.send(MSG_FS_GET_MOUNTS);
          }

          set({ _transport: transport, transportMode: mode, connectionStatus: "connected" });
          console.log(`[connect] Connected to ${workerId} via ${mode} transport`);
        };

        // ── Create RTCPeerConnection ──────────────────────────
        const { _iceServers } = get();
        console.log("[connect] Using ICE servers:", _iceServers.length);
        const pc = new RTCPeerConnection({
          iceServers: _iceServers,
        });

        // Create data channel
        const dc = pc.createDataChannel("my-data-channel");
        dc.onopen = () => {
          console.log("[connect] Data channel open → performing auth handshake");
          const transport = new WebRTCTransport(dc);

          // Set a temporary message handler for the auth handshake
          const authTimeout = setTimeout(() => {
            // No AUTH_CHALLENGE after 10s → assume older worker without auth
            console.log("[connect] Auth timeout (10s) → assuming pre-auth worker, proceeding");
            finalize(transport, "direct");
          }, 10000);

          transport.onMessage(async (data: string) => {
            const parts = parseMessage(data);
            const msgType = parts[0];

            if (msgType === MSG_AUTH_CHALLENGE) {
              const nonce = parts[1];
              console.log("[connect] Received AUTH_CHALLENGE, signing nonce...");
              try {
                const { loadSigningKey, signNonce } = await import("@/lib/auth");
                const key = await loadSigningKey();
                if (!key) {
                  throw new Error("No signing key in IndexedDB");
                }
                const signature = await signNonce(key, nonce);
                transport.send(buildMessage(MSG_AUTH_RESPONSE, signature));
                console.log("[connect] Sent AUTH_RESPONSE");
              } catch (err) {
                clearTimeout(authTimeout);
                console.error("[connect] Auth handshake failed:", err);
                transport.close();
                set({
                  connectionStatus: "error",
                  connectionError: `Auth failed: ${err instanceof Error ? err.message : String(err)}`,
                });
              }
            } else if (msgType === MSG_AUTH_SUCCESS) {
              clearTimeout(authTimeout);
              console.log("[connect] AUTH_SUCCESS → connection authenticated");
              finalize(transport, "direct");
            } else if (msgType === MSG_AUTH_FAILURE) {
              clearTimeout(authTimeout);
              const reason = parts.slice(1).join(MSG_SEPARATOR) || "Authentication rejected";
              console.error("[connect] AUTH_FAILURE:", reason);
              transport.close();
              set({
                connectionStatus: "error",
                connectionError: `Auth rejected: ${reason}`,
              });
            }
          });
        };
        dc.onclose = () => {
          console.log("[connect] Data channel closed");
        };

        // Handle ICE candidates — send to worker via signaling
        pc.onicecandidate = (event) => {
          if (event.candidate && _ws.readyState === WebSocket.OPEN) {
            _ws.send(
              JSON.stringify({
                type: "candidate",
                sender: credentials.username,
                target: workerId,
                candidate: event.candidate,
              }),
            );
          }
        };

        pc.oniceconnectionstatechange = () => {
          console.log("[connect] ICE state:", pc.iceConnectionState);
          if (pc.iceConnectionState === "failed") {
            console.warn("[connect] ICE connection failed");
          }
        };

        set({ _pc: pc });

        // Create and send SDP offer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        _ws.send(
          JSON.stringify({
            type: "offer",
            sender: credentials.username,
            target: workerId,
            sdp: offer.sdp,
            role: "app",
          }),
        );

        console.log("[connect] SDP offer sent to worker:", workerId);

        // ── 10s ICE timeout → relay fallback ──────────────────
        setTimeout(async () => {
          if (settled) return;
          if (gen !== get()._connectGeneration) {
            console.log("[connect] Stale ICE timeout (gen mismatch), ignoring");
            try { pc.close(); } catch { /* ignore */ }
            return;
          }
          console.log("[connect] ICE timeout after 10s → falling back to relay transport");
          // Clean up failed WebRTC attempt
          try { pc.close(); } catch { /* ignore */ }
          set({ _pc: null });

          const relay = new RelayTransport({
            jwt: credentials.jwt,
            roomId,
            peerId: workerId,
          });
          try {
            await relay.open();
            finalize(relay, "relay");
          } catch (err) {
            console.error("[connect] Relay E2E key exchange failed:", err);
            set({ connectionStatus: "error" });
          }
        }, 10000);
      },

      // ── Remote filesystem ────────────────────────────────────
      browseRemoteDir: async (path: string): Promise<FileEntry[]> => {
        const { _transport } = get();
        if (!_transport || !_transport.ready) {
          throw new Error("Not connected to worker");
        }

        // Auto-paginate: keep requesting more pages until has_more is false.
        // Worker paginates fs_list responses (~25 entries per page by default).
        const allEntries: FileEntry[] = [];
        let offset = 0;
        const MAX_PAGES = 200; // safety cap (200 pages * ~25 = ~5000 entries)

        for (let page = 0; page < MAX_PAGES; page++) {
          const result = await new Promise<{
            entries: FileEntry[];
            hasMore: boolean;
          }>((resolve, reject) => {
            const { _pendingFs, _transport: t } = get();
            if (!t || !t.ready) {
              reject(new Error("Transport disconnected mid-request"));
              return;
            }
            _pendingFs.set("_current", { resolve, reject });

            t.send(buildMessage(MSG_FS_LIST_DIR, path, String(offset)));

            // Timeout after 10s per page
            setTimeout(() => {
              if (_pendingFs.has("_current")) {
                _pendingFs.delete("_current");
                reject(new Error("Filesystem request timed out"));
              }
            }, 10000);
          });

          allEntries.push(...result.entries);
          if (!result.hasMore || result.entries.length === 0) break;
          offset += result.entries.length;
        }

        return allEntries;
      },

      // ── Job submission ───────────────────────────────────────
      submitJob: async (
        spec: JobSpec,
        onProgress: (line: string, isCarriageReturn?: boolean) => void,
        options?: { expectedCompletions?: number; onModelComplete?: (result: JobResult) => void },
      ): Promise<JobResult> => {
        const { _transport } = get();
        if (!_transport || !_transport.ready) {
          throw new Error("Not connected to worker");
        }

        const jobId = generateJobId();

        return new Promise((resolve) => {
          const { _pendingJobs } = get();
          _pendingJobs.set(jobId, {
            onProgress,
            onComplete: resolve,
            onModelComplete: options?.onModelComplete,
            remainingCompletions: options?.expectedCompletions ?? 1,
          });

          _transport.send(buildMessage(MSG_JOB_SUBMIT, jobId, JSON.stringify(spec)));
        });
      },

      cancelJob: (jobId: string) => {
        const { _transport } = get();
        if (_transport && _transport.ready) {
          _transport.send(buildMessage(MSG_JOB_CANCEL, jobId));
        }
      },

      stopJob: () => {
        const { _transport } = get();
        if (_transport && _transport.ready) {
          _transport.send(buildMessage(MSG_JOB_STOP));
        }
      },

      sendControlCommand: (command: string) => {
        const { _transport } = get();
        if (_transport && _transport.ready) {
          const payload = JSON.stringify({ command });
          _transport.send(buildMessage(MSG_CONTROL_COMMAND, payload));
        }
      },

      // ── Internal: signaling message handler ──────────────────
      _handleSignalingMessage: (msg: Record<string, unknown>) => {
        const type = msg.type as string;

        switch (type) {
          case "registered_auth": {
            console.log("[connect] Registered in room:", msg.room_id);

            // Store ICE servers from signaling server (may include TURN credentials)
            const iceServers = msg.ice_servers as RTCIceServer[] | undefined;
            if (iceServers && iceServers.length > 0) {
              console.log(`[connect] Received ${iceServers.length} ICE server(s) from signaling`);
              set({ _iceServers: iceServers });
            }

            set({ connectionStatus: "connected" });

            // Request peer list to find workers
            const { _ws, credentials } = get();
            if (_ws && credentials) {
              _ws.send(
                JSON.stringify({
                  type: "discover_peers",
                  from_peer_id: credentials.username,
                  filters: { role: "worker" },
                }),
              );
            }
            break;
          }

          case "peer_list": {
            const peers = msg.peers as Array<Record<string, unknown>>;
            const workers: WorkerInfo[] = peers.map((p) => {
              const meta = (p.metadata as Record<string, unknown>) || {};
              const props =
                (meta.properties as Record<string, unknown>) || {};
              return {
                peerId: p.peer_id as string,
                name:
                  (props.worker_name as string) ||
                  (p.peer_id as string),
                status: (props.status as WorkerInfo["status"]) || "available",
                gpu: props.gpu_model
                  ? {
                      model: props.gpu_model as string,
                      memoryMb: (props.gpu_memory_mb as number) || 0,
                      cudaVersion: (props.cuda_version as string) || "",
                    }
                  : undefined,
                mounts: Array.isArray(props.mounts)
                  ? (props.mounts as Array<unknown>).map((m) =>
                      typeof m === "string" ? m : (m as Record<string, unknown>)?.path as string ?? "",
                    ).filter(Boolean)
                  : [],
              };
            });
            set({ workers });
            console.log("[connect] Workers discovered:", workers.length);
            break;
          }

          case "answer": {
            // WebRTC answer from worker
            const { _pc } = get();
            if (_pc && msg.sdp) {
              _pc.setRemoteDescription(
                new RTCSessionDescription({
                  type: "answer",
                  sdp: msg.sdp as string,
                }),
              );
            }
            break;
          }

          case "candidate":
          case "ice_candidate": {
            const { _pc } = get();
            if (_pc && msg.candidate) {
              _pc.addIceCandidate(
                new RTCIceCandidate(
                  msg.candidate as RTCIceCandidateInit,
                ),
              );
            }
            break;
          }

          default:
            console.log("[connect] Unhandled signaling message:", type);
        }
      },

      // ── Internal: data channel message handler ───────────────
      _handleDataChannelMessage: (data: string) => {
        const parts = parseMessage(data);
        const msgType = parts[0];

        switch (msgType) {
          case MSG_FS_LIST_RESPONSE: {
            // Worker sends: FS_LIST_RESPONSE::{json}
            // JSON: {path, entries: [{name, is_dir, size}], total_count, has_more}
            const responseJson = parts.slice(1).join(MSG_SEPARATOR);
            const { _pendingFs } = get();
            const pending = _pendingFs.get("_current");
            if (pending) {
              _pendingFs.delete("_current");
              try {
                const result = JSON.parse(responseJson);
                const entries: FileEntry[] = (result.entries || []).map(
                  (e: Record<string, unknown>) => ({
                    name: e.name as string,
                    isDir: e.type === "directory",
                    size: e.size as number | undefined,
                  }),
                );
                pending.resolve({ entries, hasMore: !!result.has_more });
              } catch {
                pending.reject(new Error("Invalid filesystem response"));
              }
            }
            break;
          }

          case MSG_FS_MOUNTS_RESPONSE: {
            // Worker sends: FS_MOUNTS_RESPONSE::{json}
            // JSON: [{path, label}, ...]
            const mountsJson = parts.slice(1).join(MSG_SEPARATOR);
            try {
              const mounts = JSON.parse(mountsJson) as Array<{ path: string; label?: string }>;
              const mountPaths = mounts.map((m) => m.path);
              console.log("[connect] Worker mounts:", mountPaths);
              // Update the selected worker's mounts
              const { workers, selectedWorkerId } = get();
              set({
                workers: workers.map((w) =>
                  w.peerId === selectedWorkerId
                    ? { ...w, mounts: mountPaths }
                    : w,
                ),
              });
            } catch {
              console.warn("[connect] Failed to parse mounts response");
            }
            break;
          }

          case MSG_FS_ERROR: {
            // Worker sends: FS_ERROR::error_code::message
            const errorCode = parts[1];
            const errorMsg = parts.slice(2).join(MSG_SEPARATOR);
            console.warn("[connect] FS error:", errorCode, errorMsg);
            const { _pendingFs } = get();
            const pendingFs = _pendingFs.get("_current");
            if (pendingFs) {
              _pendingFs.delete("_current");
              pendingFs.reject(new Error(`${errorCode}: ${errorMsg}`));
            }
            break;
          }

          case MSG_JOB_ACCEPTED: {
            const jobId = parts[1];
            console.log("[connect] Job accepted:", jobId);
            break;
          }

          case "CR": {
            // Worker sends \r-terminated tqdm lines as CR::{text}
            // These should overwrite the previous line (carriage return behavior)
            const line = parts.slice(1).join(MSG_SEPARATOR);
            const { _pendingJobs } = get();
            const crEntry = Array.from(_pendingJobs.entries())[0];
            if (crEntry) {
              const [, pending] = crEntry;
              pending.onProgress(line, true);
            }
            break;
          }

          case MSG_JOB_REJECTED: {
            const jobId = parts[1];
            const errorJson = parts[2];
            const { _pendingJobs } = get();
            const pending = _pendingJobs.get(jobId);
            if (pending) {
              _pendingJobs.delete(jobId);
              pending.onComplete({
                jobId,
                success: false,
                error: errorJson,
              });
            }
            break;
          }

          case MSG_JOB_PROGRESS: {
            // Intentionally ignored — matches PyQt client behavior.
            // Terminal output is handled via CR:: (tqdm) and regular log
            // lines. JOB_PROGRESS fires once per batch, which spams the
            // terminal with ~100 formatted lines per epoch.
            break;
          }

          case MSG_JOB_COMPLETE: {
            // Worker sends: JOB_COMPLETE::{json} per model in multi-model pipelines.
            // Only resolve the promise after all expected completions.
            const completePayload = parts.slice(1).join(MSG_SEPARATOR);
            const { _pendingJobs } = get();
            const completeEntry = Array.from(_pendingJobs.entries())[0];
            if (completeEntry) {
              const [jobId, pending] = completeEntry;
              let result: JobResult;
              try {
                const parsed = JSON.parse(completePayload);
                result = { jobId, success: true, outputPath: parsed.output_path };
              } catch {
                result = { jobId, success: true };
              }

              pending.remainingCompletions--;

              if (pending.remainingCompletions <= 0) {
                // All models done — resolve the promise
                _pendingJobs.delete(jobId);
                pending.onComplete(result);
              } else {
                // More models to go — notify per-model callback, keep listening
                pending.onModelComplete?.(result);
              }
            }
            break;
          }

          case MSG_JOB_FAILED: {
            // Worker sends: JOB_FAILED::{json} (no job ID prefix)
            const failPayload = parts.slice(1).join(MSG_SEPARATOR);
            const { _pendingJobs } = get();
            const failEntry = Array.from(_pendingJobs.entries())[0];
            if (failEntry) {
              const [jobId, pending] = failEntry;
              _pendingJobs.delete(jobId);
              let errorMsg = "Job failed";
              try {
                const parsed = JSON.parse(failPayload);
                errorMsg = parsed.error || errorMsg;
              } catch { /* use default */ }
              pending.onComplete({
                jobId,
                success: false,
                error: errorMsg,
              });
            }
            break;
          }

          case MSG_JOB_LOG: {
            // Worker sends: JOB_LOG::{job_id}::{text}
            const logJobId = parts[1];
            const text = parts.slice(2).join(MSG_SEPARATOR);
            const { _pendingJobs: logJobs } = get();
            const pending = logJobs.get(logJobId);
            if (pending) {
              pending.onProgress(text);
            }
            break;
          }

          case MSG_AUTH_CHALLENGE:
          case MSG_AUTH_SUCCESS:
          case MSG_AUTH_FAILURE:
            // Handled during auth handshake in connectToWorker — ignore here
            break;

          case "PROGRESS_REPORT": {
            // Worker sends: PROGRESS_REPORT::{jsonpickle payload}
            // Contains structured progress events (epoch_begin, epoch_end,
            // train_begin, train_end) from sleap-nn's ZMQ progress reporter.
            // NOT printed to terminal — silently updates progress state.
            // Matches PyQt behavior: LossViewer._check_messages() consumes
            // these for loss curves, not terminal output.
            const prPayload = parts.slice(1).join(MSG_SEPARATOR);
            const { _pendingJobs: prJobs } = get();
            const prEntry = Array.from(prJobs.entries())[0];
            if (prEntry) {
              const [, pending] = prEntry;
              // Tag as progress report so trainingStore handles it differently
              pending.onProgress(`__PROGRESS_REPORT__${prPayload}`);
            }
            break;
          }

          default: {
            // Unrecognized message — raw log line from worker (e.g. wandb
            // output, error messages, training summaries). Forward to
            // onProgress, matching the PyQt client's on_log() behavior.
            const { _pendingJobs } = get();
            const defaultEntry = Array.from(_pendingJobs.entries())[0];
            if (defaultEntry) {
              const [, pending] = defaultEntry;
              pending.onProgress(data);
            }
            break;
          }
        }
      },
    }),
    {
      name: "sleap-app-connect",
      partialize: (state) => ({
        credentials: state.credentials,
        roomId: state.roomId,
      }),
    },
  ),
);
