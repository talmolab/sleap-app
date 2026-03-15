/**
 * Backend command wrappers for Tauri invoke calls.
 *
 * Provides typed wrappers around Tauri `invoke()` for Rust backend commands.
 * In browser mode, these return stub/unavailable results.
 */

import { isTauri } from "./index";

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

export type InstallEvent =
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

async function streamingInvoke(
  cmd: string,
  args: Record<string, unknown>,
  onEvent: (event: InstallEvent) => void
): Promise<void> {
  const { invoke, Channel } = await import("@tauri-apps/api/core");
  const channel = new Channel<InstallEvent>();
  channel.onmessage = onEvent;
  await invoke(cmd, { ...args, onEvent: channel });
}

/** Install a Python version via `uv python install`. */
export async function installPython(
  version: string,
  onEvent: (event: InstallEvent) => void
): Promise<void> {
  if (!isTauri) return;
  await streamingInvoke("install_python", { version }, onEvent);
}

/** Install a uv tool (e.g., sleap-nn). */
export async function installUvTool(
  pkg: string,
  pythonPath: string | null,
  force: boolean,
  onEvent: (event: InstallEvent) => void
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
  onEvent: (event: InstallEvent) => void
): Promise<void> {
  if (!isTauri) return;
  await streamingInvoke("upgrade_uv_tool", { package: pkg }, onEvent);
}
