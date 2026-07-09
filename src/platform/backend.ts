/**
 * Backend command wrappers for Tauri invoke calls.
 *
 * Provides typed wrappers around Tauri `invoke()` for Rust backend commands.
 * In browser mode, these return stub/unavailable results.
 */

import { isTauri } from "./index";
import { sleapCmd } from "@/lib/sleapPlugin";
import { saveSlpToBytes } from "@talmolab/sleap-io.js";
import type { InferenceConfig } from "@/stores/inferenceStore";
import type { UnlistenFn } from "@tauri-apps/api/event";

function sampleRandomFrames(totalFrames: number, count: number): number[] {
  const n = Math.min(count, totalFrames);
  const indices = Array.from({ length: totalFrames }, (_, i) => i);
  for (let i = indices.length - 1; i > 0 && i >= indices.length - n; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  return indices.slice(indices.length - n).sort((a, b) => a - b);
}

// === Types matching Rust structs ===

export interface UvInfo {
  available: boolean;
  version: string | null;
  path: string | null;
  pythonDir: string | null;
}

export interface UvTool {
  name: string;
  version: string | null;
  commands: string[];
}

export interface PythonInterpreter {
  key: string;
  version: string;
  path: string | null;
  source: "managed" | "system" | "download";
}

export interface PythonInfo {
  path: string;
  version: string | null;
  sleapNnVersion: string | null;
}

export type ProcessEvent =
  | { event: "stdout"; data: { line: string } }
  | { event: "stderr"; data: { line: string } }
  | { event: "finished"; data: { success: boolean; code: number | null } };

// === Helpers ===

async function invokeCmd<T>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(sleapCmd(cmd), args);
}

// === Detection commands ===

/** Detect whether `uv` is installed and get its version. */
export async function detectUv(): Promise<UvInfo> {
  if (!isTauri) {
    return { available: false, version: null, path: null, pythonDir: null };
  }
  return invokeCmd<UvInfo>("detect_uv");
}

/** List tools installed via `uv tool`. */
export async function listUvTools(): Promise<UvTool[]> {
  if (!isTauri) return [];
  return invokeCmd<UvTool[]>("list_uv_tools");
}

/** List installed Python interpreters (via `uv python list --only-installed`). */
export async function listPythonInterpreters(): Promise<PythonInterpreter[]> {
  if (!isTauri) return [];
  return invokeCmd<PythonInterpreter[]>("list_python_interpreters");
}

/** List Python versions available for download. */
export async function listDownloadablePythons(): Promise<PythonInterpreter[]> {
  if (!isTauri) return [];
  return invokeCmd<PythonInterpreter[]>("list_downloadable_pythons");
}

/** Check a specific Python interpreter for version and package availability. */
export async function checkPython(pythonPath: string): Promise<PythonInfo> {
  if (!isTauri) {
    return {
      path: pythonPath,
      version: null,
      sleapNnVersion: null,
    };
  }
  return invokeCmd<PythonInfo>("check_python", { pythonPath });
}

// === Install commands (streaming via Channel) ===

async function streamingInvoke<T = void>(
  cmd: string,
  args: Record<string, unknown>,
  onEvent: (event: ProcessEvent) => void
): Promise<T> {
  const { invoke, Channel } = await import("@tauri-apps/api/core");
  const channel = new Channel<ProcessEvent>();
  channel.onmessage = onEvent;
  return invoke<T>(sleapCmd(cmd), { ...args, onEvent: channel });
}

/** Install a Python version via `uv python install`. */
export async function installPython(
  version: string,
  onEvent: (event: ProcessEvent) => void
): Promise<void> {
  if (!isTauri) return;
  await streamingInvoke("install_python", { version }, onEvent);
}

/** Detect GPU type: "cuda", "mps", or "cpu". */
export async function detectGpu(): Promise<string> {
  return invokeCmd<string>("detect_gpu", {});
}

/** Install a uv tool (e.g., sleap-nn). */
export async function installUvTool(
  pkg: string,
  pythonPath: string | null,
  force: boolean,
  onEvent: (event: ProcessEvent) => void,
  extraArgs?: string[]
): Promise<void> {
  if (!isTauri) return;
  await streamingInvoke(
    "install_uv_tool",
    { package: pkg, pythonPath, force, extraArgs: extraArgs ?? null },
    onEvent
  );
}

/** Upgrade a uv tool to its latest version. */
export async function upgradeUvTool(
  pkg: string,
  onEvent: (event: ProcessEvent) => void
): Promise<void> {
  if (!isTauri) return;
  await streamingInvoke("upgrade_uv_tool", { package: pkg }, onEvent);
}

/** Update uv itself via `uv self update`. */
export async function updateUv(
  onEvent: (event: ProcessEvent) => void
): Promise<void> {
  if (!isTauri) return;
  await streamingInvoke("update_uv", {}, onEvent);
}

/** Install uv via the official install script. */
export async function installUv(
  onEvent: (event: ProcessEvent) => void
): Promise<void> {
  if (!isTauri) return;
  await streamingInvoke("install_uv", {}, onEvent);
}

/**
 * Spawn a long-running command and stream stdout/stderr via Channel.
 * Returns true if the process exited successfully.
 */
export async function runPythonCommand(
  program: string,
  args: string[],
  onEvent: (event: ProcessEvent) => void
): Promise<boolean> {
  if (!isTauri) {
    console.warn("runPythonCommand is only available in Tauri");
    return false;
  }
  return streamingInvoke<boolean>("run_python_command", { program, args }, onEvent);
}

/**
 * Cancel the currently running subprocess.
 */
export async function cancelCommand(): Promise<void> {
  if (!isTauri) return;
  return invokeCmd<void>("cancel_command");
}

/**
 * Start ZMQ PUB relay on port 9000 for sending stop commands to sleap-nn.
 * Cleans up any stale processes on the port before binding.
 */
export async function startZmqRelay(): Promise<void> {
  if (!isTauri) return;
  return invokeCmd<void>("start_zmq_relay");
}

/**
 * Send stop command to sleap-nn via ZMQ relay.
 * sleap-nn finishes the current epoch, saves checkpoint, exits with code 0.
 */
export async function sendTrainingStop(): Promise<void> {
  if (!isTauri) return;
  console.log("[backend] Sending stop via ZMQ relay...");
  await invokeCmd<void>("send_training_stop");
  console.log("[backend] Stop command sent");
}

/**
 * Kill the ZMQ relay process.
 */
export async function stopZmqRelay(): Promise<void> {
  if (!isTauri) return;
  return invokeCmd<void>("stop_zmq_relay");
}

/**
 * Start the ZMQ SUB progress relay (binds :9001) that forwards sleap-nn
 * training loss telemetry to the frontend as "training-progress" events.
 * No-op outside Tauri.
 */
export async function startProgressRelay(): Promise<void> {
  if (!isTauri) return;
  return invokeCmd<void>("start_progress_relay");
}

/** Stop the ZMQ SUB progress relay. No-op outside Tauri. */
export async function stopProgressRelay(): Promise<void> {
  if (!isTauri) return;
  return invokeCmd<void>("stop_progress_relay");
}

/**
 * Subscribe to training-progress events emitted by the Rust SUB relay.
 * Each payload is one raw sleap-nn ZMQ message (JSON string). Returns an
 * unlisten function. No-op (returns a noop unlisten) outside Tauri.
 */
export async function listenTrainingProgress(
  cb: (msg: string) => void,
): Promise<UnlistenFn> {
  if (!isTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen<string>("training-progress", (event) => cb(event.payload));
}

/**
 * Run a single sleap-nn train command for one config.
 * 1. Write the YAML config to a temp file
 * 2. Build `sleap-nn train --config-name <name> --config-dir <dir>` with Hydra overrides
 * 3. Spawn process with streaming
 */
export async function runTraining(
  configYaml: string,
  labelsPath: string,
  runName: string,
  onEvent: (event: ProcessEvent) => void,
  modelDir?: string,
): Promise<{ success: boolean; command: string; modelPath: string }> {
  if (!isTauri) {
    console.warn("Training is only available in Tauri desktop mode");
    return { success: false, command: "", modelPath: "" };
  }

  const { writeFile } = await import("@tauri-apps/plugin-fs");
  const { tempDir, join } = await import("@tauri-apps/api/path");

  const tmp = await tempDir();
  const configFileName = `sleap_train_config_${Date.now()}.yaml`;
  // join() (not string concat) — tempDir() is not guaranteed to end in a separator
  // (e.g. Linux "/tmp", or a slash-less $TMPDIR), which would mangle the path.
  const configPath = await join(tmp, configFileName);

  await writeFile(configPath, new TextEncoder().encode(configYaml));
  console.log("[training] Wrote config to:", configPath);

  // Use provided modelDir or default to temp/models
  const ckptDir = modelDir || (await join(tmp, "sleap_models"));
  const modelPath = `${ckptDir}/${runName}`;

  const args = [
    "train",
    "--config-name", configFileName,
    "--config-dir", tmp,
    `data_config.train_labels_path=[${labelsPath}]`,
    `trainer_config.run_name=${runName}`,
    `trainer_config.ckpt_dir=${ckptDir}`,
    `trainer_config.zmq.controller_port=9000`,
    `trainer_config.zmq.publish_port=9001`,
  ];

  const command = `sleap-nn ${args.join(" ")}`;
  console.log("[training] Running:", command);
  console.log("[training] Model will be saved to:", modelPath);

  const success = await runPythonCommand("sleap-nn", args, onEvent);
  console.log("[training] Process finished: success=%s", success);

  return { success, command, modelPath };
}

/**
 * Run sleap-nn inference. Orchestrates the full pipeline:
 * 1. Serialize current Labels to a temp .slp file
 * 2. Build CLI args with data path, output path, and config
 * 3. Spawn process with streaming
 */
export async function runInference(
  config: InferenceConfig,
  projectPath: string | null,
  onEvent: (event: ProcessEvent) => void
): Promise<{ success: boolean; outputPath: string | null; command: string }> {
  if (!isTauri) {
    console.warn("Inference is only available in Tauri desktop mode");
    return { success: false, outputPath: null, command: "" };
  }

  const { tempDir, join } = await import("@tauri-apps/api/path");

  const tmp = await tempDir();
  const ts = Date.now();
  const outputPath = await join(tmp, `sleap_inference_output_${ts}.slp`);

  // Use original project file if available, otherwise serialize
  let dataPath: string;
  if (projectPath) {
    dataPath = projectPath;
    console.log("[inference] Using project file:", dataPath);
  } else {
    const { writeFile } = await import("@tauri-apps/plugin-fs");
    // Lazy import to avoid pulling in saveSlpToBytes when not needed
    const { useAppStore } = await import("@/stores/appStore");
    const labels = useAppStore.getState().labels;
    if (!labels) throw new Error("No project loaded");
    dataPath = await join(tmp, `sleap_inference_input_${ts}.slp`);
    console.log("[inference] Serializing project to temp file:", dataPath);
    const bytes = await saveSlpToBytes(labels);
    await writeFile(dataPath, bytes);
    console.log("[inference] Wrote %d bytes to %s", bytes.byteLength, dataPath);
  }

  // Build CLI args for sleap-nn track
  const program = "sleap-nn";
  const args = ["track", "--gui"];

  // Core I/O
  args.push("--data_path", dataPath);
  for (const mp of config.modelPaths) {
    args.push("--model_paths", mp);
  }
  args.push("--output_path", outputPath);

  // Data selection
  if (config.videoIndex !== "all") {
    args.push("--video_index", String(config.videoIndex));
  }

  // Frame range → CLI args (fail fast on unhandled types)
  if (typeof config.frameRange === "object") {
    args.push("--frames", `${config.frameRange.start}-${config.frameRange.end}`);
  } else {
    const { useAppStore } = await import("@/stores/appStore");

    switch (config.frameRange) {
      case "user_labeled":
        args.push("--only_labeled_frames");
        break;
      case "suggestions":
        args.push("--only_suggested_frames");
        break;
      case "predicted":
        args.push("--only_predicted_frames");
        break;
      case "video":
      case "all_videos":
        break;
      case "random_video": {
        const activeVideo = useAppStore.getState().video;
        const nFrames = activeVideo?.shape?.[0] ?? 0;
        if (nFrames === 0) throw new Error("Cannot sample: current video has no frames");
        const sampled = sampleRandomFrames(nFrames, config.sampleCount);
        args.push("--frames", sampled.join(","));
        break;
      }
      case "random":
        // "random (all videos)" requires per-video invocation — handled by caller.
        // If we reach here, fall back to current video only.
        throw new Error(
          "Random sampling across all videos requires per-video invocation. " +
          "Use 'random_video' for single-video random, or call runInference per video."
        );
      default:
        throw new Error(`Unhandled frame range type: ${config.frameRange}`);
    }
  }

  if (config.excludeUserLabeled) {
    args.push("--exclude_user_labeled");
  }

  // Inference settings
  args.push("--batch_size", String(config.batchSize));
  args.push("--device", config.device);
  if (config.maxInstances != null) {
    args.push("--max_instances", String(config.maxInstances));
  }
  args.push("--peak_threshold", String(config.peakThreshold));
  if (config.anchorPart) {
    args.push("--anchor_part", config.anchorPart);
  }

  // Bottom-up advanced
  if (config.integralRefinement) {
    args.push("--integral_refinement", "integral");
    args.push("--integral_patch_size", String(config.integralPatchSize));
  }
  if (config.pipeline === "bottom-up" || config.pipeline === "bottom-up-id") {
    args.push("--n_points", String(config.nPoints));
    args.push("--max_edge_length_ratio", String(config.maxEdgeLengthRatio));
    args.push("--dist_penalty_weight", String(config.distPenaltyWeight));
    args.push("--min_line_scores", String(config.minLineScores));
  }

  // Preprocessing
  if (config.ensureChannels === "rgb") {
    args.push("--ensure_rgb");
  } else if (config.ensureChannels === "grayscale") {
    args.push("--ensure_grayscale");
  }

  // Tracking
  if (config.tracking) {
    args.push("--tracking");
    if (config.trackerMethod === "flow") {
      args.push("--use_flow");
    }
    if (config.similarityMethod === "centroids") {
      args.push("--features", "centroids");
      args.push("--scoring_method", "euclidean_dist");
    } else {
      args.push("--scoring_method", config.similarityMethod);
    }
    args.push("--track_matching_method", config.matchingMethod);
    args.push("--tracking_window_size", String(config.trackingWindowSize));
    if (config.maxTracks != null) {
      args.push("--max_tracks", String(config.maxTracks));
    }
    args.push("--robust_best_instance", String(config.robust));
    if (config.connectSingleBreaks) {
      args.push("--post_connect_single_breaks");
    }
  }

  // Post-processing
  if (config.filterOverlapping) {
    args.push("--filter_overlapping");
    args.push("--filter_overlapping_method", config.filterMethod);
    args.push("--filter_overlapping_threshold", String(config.filterThreshold));
  }

  const command = `${program} ${args.join(" ")}`;
  console.log("[inference] Running:", command);
  const success = await runPythonCommand(program, args, onEvent);
  console.log("[inference] Process finished: success=%s, output=%s", success, outputPath);
  return { success, outputPath, command };
}

// === RTC commands (native WebRTC via Rust backend) ===

export interface RtcWorkerInfo {
  peerId: string;
  name: string;
  status: string;
  gpu?: { model: string; memoryMb: number; cudaVersion: string };
  mounts: string[];
}

export async function rtcJoinRoom(roomId: string): Promise<RtcWorkerInfo[]> {
  if (!isTauri) return [];
  return invokeCmd<RtcWorkerInfo[]>("rtc_join_room", { roomId });
}

export async function rtcConnectWorker(
  workerId: string,
  onMessage: (msg: string) => void,
): Promise<void> {
  if (!isTauri) return;
  const { invoke, Channel } = await import("@tauri-apps/api/core");
  const channel = new Channel<string>();
  channel.onmessage = onMessage;
  return invoke(sleapCmd("rtc_connect_worker"), { workerId, onMessage: channel });
}

export async function rtcSend(msg: string): Promise<void> {
  if (!isTauri) return;
  return invokeCmd("rtc_send", { msg });
}

export async function rtcDisconnectWorker(): Promise<void> {
  if (!isTauri) return;
  return invokeCmd("rtc_disconnect_worker");
}

export async function rtcLeaveRoom(): Promise<void> {
  if (!isTauri) return;
  return invokeCmd("rtc_leave_room");
}
