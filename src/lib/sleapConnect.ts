/**
 * sleap-rtc signaling and data channel protocol client.
 *
 * Implements the WebSocket signaling protocol and WebRTC data channel
 * message format used by sleap-rtc workers. This allows sleap-app to
 * connect to rooms, discover workers, browse remote filesystems,
 * and submit inference jobs.
 */

// ── Protocol constants (match sleap_rtc/protocol.py) ──────────────
export const MSG_SEPARATOR = "::";

// Job messages
export const MSG_JOB_SUBMIT = "JOB_SUBMIT";
export const MSG_JOB_ACCEPTED = "JOB_ACCEPTED";
export const MSG_JOB_REJECTED = "JOB_REJECTED";
export const MSG_JOB_PROGRESS = "JOB_PROGRESS";
export const MSG_JOB_COMPLETE = "JOB_COMPLETE";
export const MSG_JOB_FAILED = "JOB_FAILED";
export const MSG_JOB_CANCEL = "JOB_CANCEL";
export const MSG_JOB_STOP = "JOB_STOP";
export const MSG_CONTROL_COMMAND = "CONTROL_COMMAND";

// Job log messages
export const MSG_JOB_LOG = "JOB_LOG";

// P2P auth messages (Ed25519 challenge-response)
export const MSG_AUTH_CHALLENGE = "AUTH_CHALLENGE";
export const MSG_AUTH_RESPONSE = "AUTH_RESPONSE";
export const MSG_AUTH_SUCCESS = "AUTH_SUCCESS";
export const MSG_AUTH_FAILURE = "AUTH_FAILURE";

// Filesystem messages
export const MSG_FS_GET_MOUNTS = "FS_GET_MOUNTS";
export const MSG_FS_MOUNTS_RESPONSE = "FS_MOUNTS_RESPONSE";
export const MSG_FS_LIST_DIR = "FS_LIST_DIR";
export const MSG_FS_LIST_RESPONSE = "FS_LIST_RESPONSE";
export const MSG_FS_ERROR = "FS_ERROR";

// ── Types ─────────────────────────────────────────────────────────

export interface WorkerInfo {
  peerId: string;
  name: string;
  status: "available" | "busy" | "offline";
  gpu?: {
    model: string;
    memoryMb: number;
    cudaVersion: string;
  };
  mounts: string[];
}

export interface TrackJobSpec {
  type: "track";
  data_path: string;
  model_paths: string[];
  output_path?: string;
  batch_size?: number;
  peak_threshold?: number;
  only_suggested_frames?: boolean;
  frame_filter?: string;
  video_index?: number;
  exclude_user_labeled?: boolean;
  frames?: string;
  path_mappings?: Record<string, string>;
  robust?: number;
  ensure_channels?: "rgb" | "grayscale";
  tracker?: string;
  similarity?: string;
  match?: string;
  track_window?: number;
  max_tracks?: number;
  connect_single_breaks?: boolean;
}

export interface TrainJobSpec {
  type: "train";
  config_contents: string[];
  model_types: string[];
  labels_path: string;
  val_labels_path?: string;
  max_epochs?: number;
  batch_size?: number;
  learning_rate?: number;
  run_name?: string;
  path_mappings?: Record<string, string>;
  inference_target?: string;
}

export type JobSpec = TrackJobSpec | TrainJobSpec;

export interface FileEntry {
  name: string;
  isDir: boolean;
  size?: number;
}

export interface Credentials {
  jwt: string;
  username: string;
  avatarUrl?: string;
  defaultRoom?: string;
  accountKey?: string;
  privateKey?: string; // Ed25519 private key (URL-safe base64, raw 32 bytes)
}

export interface JobResult {
  jobId: string;
  success: boolean;
  outputPath?: string;
  error?: string;
}

// ── Message helpers ───────────────────────────────────────────────

/** Build a protocol message from parts: "TYPE::arg1::arg2" */
export function buildMessage(...parts: string[]): string {
  return parts.join(MSG_SEPARATOR);
}

/** Parse a protocol message into [type, ...args] */
export function parseMessage(msg: string): string[] {
  return msg.split(MSG_SEPARATOR);
}

/** Generate a random job ID */
export function generateJobId(): string {
  return `job_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
