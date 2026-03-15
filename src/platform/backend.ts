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
}

export interface UvTool {
  name: string;
  version: string | null;
  commands: string[];
}

export interface PythonInfo {
  path: string;
  version: string | null;
  sleapNnVersion: string | null;
  sleapVersion: string | null;
}

// === Command wrappers ===

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke: tauriInvoke } = await import("@tauri-apps/api/core");
  return tauriInvoke<T>(cmd, args);
}

/** Detect whether `uv` is installed and get its version. */
export async function detectUv(): Promise<UvInfo> {
  if (!isTauri) {
    return { available: false, version: null, path: null };
  }
  return invoke<UvInfo>("detect_uv");
}

/** List tools installed via `uv tool`. */
export async function listUvTools(): Promise<UvTool[]> {
  if (!isTauri) {
    return [];
  }
  return invoke<UvTool[]>("list_uv_tools");
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
  return invoke<PythonInfo>("check_python", { pythonPath });
}
