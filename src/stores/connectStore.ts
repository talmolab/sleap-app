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
  MSG_JOB_ACCEPTED,
  MSG_JOB_REJECTED,
  MSG_JOB_PROGRESS,
  MSG_JOB_COMPLETE,
  MSG_JOB_FAILED,
  MSG_FS_GET_MOUNTS,
  MSG_FS_MOUNTS_RESPONSE,
  MSG_FS_LIST_DIR,
  MSG_FS_LIST_RESPONSE,
  MSG_FS_ERROR,
  MSG_SEPARATOR,
} from "@/lib/sleapConnect";
import { isTauri } from "@/platform/index";

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
  resolve: (entries: FileEntry[]) => void;
  reject: (err: Error) => void;
}

interface PendingJobCallbacks {
  onProgress: (line: string, isCarriageReturn?: boolean) => void;
  onComplete: (result: JobResult) => void;
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

  // Internal (not persisted)
  _ws: WebSocket | null;
  _pc: RTCPeerConnection | null;
  _dc: RTCDataChannel | null;
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
  ) => Promise<JobResult>;
  cancelJob: (jobId: string) => void;
  stopJob: () => void;
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
      _ws: null,
      _pc: null,
      _dc: null,
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
              },
            });
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
                role: "client",
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
        const { _ws, _pc, _dc } = get();
        if (_dc) _dc.close();
        if (_pc) _pc.close();
        if (_ws) _ws.close();
        set({
          connectionStatus: "disconnected",
          connectionError: null,
          roomId: null,
          workers: [],
          selectedWorkerId: null,
          _ws: null,
          _pc: null,
          _dc: null,
        });
      },

      selectWorker: (workerId) => set({ selectedWorkerId: workerId }),

      connectToWorker: async (workerId: string) => {
        const { _ws, credentials } = get();
        if (!_ws || !credentials) return;

        console.log("[connect] Initiating WebRTC connection to worker:", workerId);
        set({ selectedWorkerId: workerId });

        // Create RTCPeerConnection with STUN + TURN servers
        const pc = new RTCPeerConnection({
          iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            {
              urls: "turn:10.0.73.44:31540",
              username: "sleap",
              credential: "sleap123",
            },
            {
              urls: "turn:10.0.73.44:31540?transport=tcp",
              username: "sleap",
              credential: "sleap123",
            },
          ],
        });

        // Create data channel
        const dc = pc.createDataChannel("my-data-channel");
        dc.onopen = () => {
          console.log("[connect] Data channel open to worker:", workerId);
          // Request worker's mount paths
          dc.send(MSG_FS_GET_MOUNTS);
        };
        dc.onmessage = (event) => {
          if (typeof event.data === "string") {
            get()._handleDataChannelMessage(event.data);
          }
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
          if (pc.iceConnectionState === "failed" || pc.iceConnectionState === "disconnected") {
            console.warn("[connect] ICE connection failed/disconnected");
          }
        };

        set({ _pc: pc, _dc: dc });

        // Create and send SDP offer
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        _ws.send(
          JSON.stringify({
            type: "offer",
            sender: credentials.username,
            target: workerId,
            sdp: offer.sdp,
            role: "client",
          }),
        );

        console.log("[connect] SDP offer sent to worker:", workerId);
      },

      // ── Remote filesystem ────────────────────────────────────
      browseRemoteDir: async (path: string): Promise<FileEntry[]> => {
        const { _dc } = get();
        if (!_dc || _dc.readyState !== "open") {
          throw new Error("Data channel not connected");
        }

        return new Promise((resolve, reject) => {
          // Worker protocol: FS_LIST_DIR::path::offset (no request ID)
          // Only one FS request at a time
          const { _pendingFs } = get();
          _pendingFs.set("_current", { resolve, reject });

          _dc.send(
            buildMessage(MSG_FS_LIST_DIR, path, "0"),
          );

          // Timeout after 10s
          setTimeout(() => {
            if (_pendingFs.has("_current")) {
              _pendingFs.delete("_current");
              reject(new Error("Filesystem request timed out"));
            }
          }, 10000);
        });
      },

      // ── Job submission ───────────────────────────────────────
      submitJob: async (
        spec: JobSpec,
        onProgress: (line: string, isCarriageReturn?: boolean) => void,
      ): Promise<JobResult> => {
        const { _dc } = get();
        if (!_dc || _dc.readyState !== "open") {
          throw new Error("Data channel not connected");
        }

        const jobId = generateJobId();

        return new Promise((resolve) => {
          const { _pendingJobs } = get();
          _pendingJobs.set(jobId, {
            onProgress,
            onComplete: resolve,
          });

          _dc.send(
            buildMessage(MSG_JOB_SUBMIT, jobId, JSON.stringify(spec)),
          );
        });
      },

      cancelJob: (jobId: string) => {
        const { _dc } = get();
        if (_dc && _dc.readyState === "open") {
          _dc.send(buildMessage(MSG_JOB_CANCEL, jobId));
        }
      },

      stopJob: () => {
        const { _dc } = get();
        if (_dc && _dc.readyState === "open") {
          _dc.send(buildMessage(MSG_JOB_STOP));
        }
      },

      // ── Internal: signaling message handler ──────────────────
      _handleSignalingMessage: (msg: Record<string, unknown>) => {
        const type = msg.type as string;

        switch (type) {
          case "registered_auth": {
            console.log("[connect] Registered in room:", msg.room_id);
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
                mounts: (props.mounts as string[]) || [],
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
                pending.resolve(entries);
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
            // Worker sends: JOB_COMPLETE::{json} (no job ID prefix)
            const completePayload = parts.slice(1).join(MSG_SEPARATOR);
            const { _pendingJobs } = get();
            const completeEntry = Array.from(_pendingJobs.entries())[0];
            if (completeEntry) {
              const [jobId, pending] = completeEntry;
              _pendingJobs.delete(jobId);
              try {
                const result = JSON.parse(completePayload);
                pending.onComplete({
                  jobId,
                  success: true,
                  outputPath: result.output_path,
                });
              } catch {
                pending.onComplete({ jobId, success: true });
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

          default:
            console.log("[connect] Unhandled data channel message:", msgType);
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
