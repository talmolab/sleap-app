/**
 * Backend command wrappers for Tauri invoke calls.
 *
 * Provides typed wrappers around Tauri `invoke()` for Rust backend commands.
 * In browser mode, these return stub/unavailable results.
 */

import { isTauri } from "./index";
import type { InferenceConfig } from "@/stores/inferenceStore";

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
  sleapVersion: string | null;
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
  return invoke<T>(cmd, args);
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
      sleapVersion: null,
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
  return invoke<T>(cmd, { ...args, onEvent: channel });
}

/** Install a Python version via `uv python install`. */
export async function installPython(
  version: string,
  onEvent: (event: ProcessEvent) => void
): Promise<void> {
  if (!isTauri) return;
  await streamingInvoke("install_python", { version }, onEvent);
}

/** Install a uv tool (e.g., sleap-nn). */
export async function installUvTool(
  pkg: string,
  pythonPath: string | null,
  force: boolean,
  onEvent: (event: ProcessEvent) => void
): Promise<void> {
  if (!isTauri) return;
  await streamingInvoke(
    "install_uv_tool",
    { package: pkg, pythonPath, force },
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
 * Run sleap-nn inference. Orchestrates the full pipeline:
 * 1. Build CLI args
 * 2. Spawn process with streaming
 *
 * Note: Full temp-file orchestration (writing labels to .slp, reading output .slp)
 * is a TODO — depends on sleap-io.js serialization and Tauri temp directory APIs.
 */
export async function runInference(
  config: InferenceConfig,
  onEvent: (event: ProcessEvent) => void
): Promise<{ success: boolean; outputPath: string | null }> {
  if (!isTauri) {
    console.warn("Inference is only available in Tauri desktop mode");
    return { success: false, outputPath: null };
  }

  // Generate output path in temp directory
  const { tempDir } = await import("@tauri-apps/api/path");
  const tmp = await tempDir();
  const outputPath = `${tmp}sleap_inference_${Date.now()}.slp`;

  // Build CLI args for sleap-nn track
  const program = "sleap-nn";
  const args = ["track", "--gui"];

  // Add model path
  args.push("--model_paths", config.modelPath);

  // Add output path
  args.push("--output_path", outputPath);

  // Add video index
  if (config.videoIndex !== "all") {
    args.push("--video_index", String(config.videoIndex));
  }

  // Add max instances
  args.push("--max_instances", String(config.maxInstances));

  // TODO: Add --data_path (temp .slp file), frame range, tracking method
  // These require writing the current Labels to a temp file, which depends on
  // sleap-io.js serialization support.

  const success = await runPythonCommand(program, args, onEvent);
  return { success, outputPath };
}
