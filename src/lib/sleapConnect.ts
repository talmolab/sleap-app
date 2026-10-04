/**
 * sleap-rtc signaling and data channel protocol client.
 *
 * Implements the WebSocket signaling protocol and WebRTC data channel
 * message format used by sleap-rtc workers. This allows sleap-app to
 * connect to rooms, discover workers, browse remote filesystems,
 * and submit inference jobs.
 */
import type { JobProject } from "@/lib/protocolV1/client";

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
  min_match_points?: number;
  min_new_track_points?: number;
  scoring_reduction?: string;
  tracking_target_instance_count?: number;
  tracking_pre_cull_to_target?: boolean;
  tracking_pre_cull_iou_threshold?: number;
  tracking_clean_instance_count?: number;
  tracking_clean_iou_threshold?: number;
  use_kalman?: boolean;
  kf_track_features?: string;
  kf_init_frame_count?: number;
  kf_node_indices?: string;
  kf_reset_gap_size?: number;
  of_img_scale?: number;
  of_window_size?: number;
  of_max_levels?: number;
  filter_overlapping?: boolean;
  filter_overlapping_method?: string;
  filter_overlapping_threshold?: number;
  filter_min_visible_nodes?: number;
  filter_min_visible_node_fraction?: number;
  filter_min_mean_node_score?: number;
  filter_min_instance_score?: number;
  filter_min_centroid_distance?: number;
  /** Which project submitted this job (`projectTag()`) — shows up in the worker's job list/history (sleap-connect #98). */
  project?: JobProject;
}

export interface TrainJobSpec {
  type: "train";
  config_contents: string[];
  model_types: string[];
  /** `labelsSource: "worker-file"` — a path the worker can already read. Omitted when `labels_content` is sent instead (`labelsSource: "window"`). */
  labels_path?: string;
  /**
   * Base64-encoded `.slp` bytes for the training labels — this window's own
   * labels (`labelsSource: "window"`), sent in place of a worker filesystem
   * path (see trainingStore.ts's remote-submission path). Per-video,
   * selectively embedded: a video the worker can see is referenced by its
   * worker path; one it can't is embedded (labeled frames only, never the
   * full video — see remoteLabelsPayload.ts). Exact cross-repo wire contract
   * with sleap-connect's worker materialization — do not rename.
   */
  labels_content?: string | null;
  val_labels_path?: string;
  max_epochs?: number;
  batch_size?: number;
  learning_rate?: number;
  run_name?: string;
  path_mappings?: Record<string, string>;
  /** Which project submitted this job (`projectTag()`) — shows up in the worker's job list/history (sleap-connect #98). */
  project?: JobProject;
  // No `inference_target`: the worker never ran inference as part of a train
  // job. Post-training inference is a separate track job the app submits
  // once every model has trained (see trainingStore's remote branch).
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

/** A content-addressed result blob ref (protocol v1 spec §6.4). */
export interface JobResultBlobRef {
  sha256: string;
  size: number;
}

export interface JobResult {
  jobId: string;
  success: boolean;
  outputPath?: string;
  error?: string;
  /**
   * Result blobs a protocol-v1 worker reported on `job.result` (e.g.
   * `resultBlobs.predictions`) — fetch with `connectStore`'s
   * `fetchResultBlob`. `outputPath` above is the desktop-only, local-file
   * concept this replaces for the remote-worker case; empty/undefined
   * until the worker actually registers something (stage 1.10's
   * `talmolab/sleap-connect` side — a worker not running the blob HTTP
   * server, or a training job, never populates this).
   */
  resultBlobs?: Record<string, JobResultBlobRef>;
  /** Train jobs only: worker-side path of the trained model folder (a `model_paths` entry for a track job). */
  modelDir?: string;
  /** Train jobs only: worker-side path of the labels file the job trained on (materialized when sent inline). */
  labelsPath?: string;
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
