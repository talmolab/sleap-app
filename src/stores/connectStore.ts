import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  WorkerInfo,
  Credentials,
  FileEntry,
  TrackJobSpec,
  JobResult,
} from "@/lib/sleapConnect";
import {
  buildMessage,
  parseMessage,
  generateJobId,
  MSG_JOB_SUBMIT,
  MSG_JOB_CANCEL,
  MSG_JOB_ACCEPTED,
  MSG_JOB_REJECTED,
  MSG_JOB_PROGRESS,
  MSG_JOB_COMPLETE,
  MSG_JOB_FAILED,
  MSG_FS_LIST_DIR,
  MSG_FS_LIST_RESPONSE,
  MSG_SEPARATOR,
} from "@/lib/sleapConnect";
import { isTauri } from "@/platform/index";

// ── Signaling server config ──────────────────────────────────────
const SIGNALING_WS =
  (typeof import.meta !== "undefined" &&
    (import.meta as Record<string, unknown>).env &&
    ((import.meta as Record<string, unknown>).env as Record<string, string>)
      .VITE_SIGNALING_WS) ||
  "wss://signaling.sleap.ai/ws";

const SIGNALING_HTTP =
  (typeof import.meta !== "undefined" &&
    (import.meta as Record<string, unknown>).env &&
    ((import.meta as Record<string, unknown>).env as Record<string, string>)
      .VITE_SIGNALING_HTTP) ||
  "https://signaling.sleap.ai";

// ── Types ─────────────────────────────────────────────────────────

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "error";

interface PendingFsRequest {
  resolve: (entries: FileEntry[]) => void;
  reject: (err: Error) => void;
}

interface PendingJobCallbacks {
  onProgress: (line: string) => void;
  onComplete: (result: JobResult) => void;
}

interface ConnectState {
  // Auth
  credentials: Credentials | null;

  // Connection
  connectionStatus: ConnectionStatus;
  connectionError: string | null;
  roomId: string | null;
  availableRooms: string[];

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
  browseRemoteDir: (path: string) => Promise<FileEntry[]>;
  submitJob: (
    spec: TrackJobSpec,
    onProgress: (line: string) => void,
  ) => Promise<JobResult>;
  cancelJob: (jobId: string) => void;
  loadCredentialsFromDisk: () => Promise<void>;

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
          const credPath = `${home}.sleap-rtc/credentials.json`;
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

      // ── Remote filesystem ────────────────────────────────────
      browseRemoteDir: async (path: string): Promise<FileEntry[]> => {
        const { _dc } = get();
        if (!_dc || _dc.readyState !== "open") {
          throw new Error("Data channel not connected");
        }

        return new Promise((resolve, reject) => {
          const requestId = `fs_${Date.now()}`;
          const { _pendingFs } = get();
          _pendingFs.set(requestId, { resolve, reject });

          _dc.send(
            buildMessage(MSG_FS_LIST_DIR, requestId, path),
          );

          // Timeout after 10s
          setTimeout(() => {
            if (_pendingFs.has(requestId)) {
              _pendingFs.delete(requestId);
              reject(new Error("Filesystem request timed out"));
            }
          }, 10000);
        });
      },

      // ── Job submission ───────────────────────────────────────
      submitJob: async (
        spec: TrackJobSpec,
        onProgress: (line: string) => void,
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
            const requestId = parts[1];
            const entriesJson = parts[2];
            const { _pendingFs } = get();
            const pending = _pendingFs.get(requestId);
            if (pending) {
              _pendingFs.delete(requestId);
              try {
                const entries = JSON.parse(entriesJson) as FileEntry[];
                pending.resolve(entries);
              } catch {
                pending.reject(new Error("Invalid filesystem response"));
              }
            }
            break;
          }

          case MSG_JOB_ACCEPTED: {
            const jobId = parts[1];
            console.log("[connect] Job accepted:", jobId);
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
            const jobId = parts[1];
            const line = parts.slice(2).join(MSG_SEPARATOR);
            const { _pendingJobs } = get();
            const pending = _pendingJobs.get(jobId);
            if (pending) {
              pending.onProgress(line);
            }
            break;
          }

          case MSG_JOB_COMPLETE: {
            const jobId = parts[1];
            const resultJson = parts[2];
            const { _pendingJobs } = get();
            const pending = _pendingJobs.get(jobId);
            if (pending) {
              _pendingJobs.delete(jobId);
              try {
                const result = JSON.parse(resultJson);
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
            const jobId = parts[1];
            const errorJson = parts[2];
            const { _pendingJobs } = get();
            const pending = _pendingJobs.get(jobId);
            if (pending) {
              _pendingJobs.delete(jobId);
              let errorMsg = "Job failed";
              try {
                const parsed = JSON.parse(errorJson);
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
