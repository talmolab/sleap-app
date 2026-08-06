/**
 * Desktop (Tauri) "open a .slp, but don't duplicate an already-open project"
 * routing. Each WebviewWindow is an isolated JS heap, so the source of truth for
 * "which file is open in which window" lives in Rust (see lib.rs WindowFiles).
 *
 * Every path-based open funnels through `openOrFocusPath`, which asks Rust
 * (`resolve_open`) where the file should go and then:
 *   - focuses the window that already has it open (dedup), or
 *   - loads it into the current window if that window is empty (Welcome), or
 *   - tells another empty window to load it, or
 *   - spawns a fresh window for it.
 * So a loaded project is never clobbered, and the same file never opens twice.
 *
 * The pure helpers (`planOpen`, `readOpenFileParam`) hold the branch logic and
 * are unit-tested without Tauri. (`buildInstanceUrl` lives in newInstance.ts,
 * next to the window it parameterizes.)
 */

import { sleapCmd } from "./sleapPlugin";

export type ResolveAction = "focus" | "reuse" | "new";

/** Rust's answer for where an open request should go. */
export interface Resolution {
  action: ResolveAction;
  label: string | null;
}

/** The concrete action the frontend takes, derived from a Resolution. */
export type OpenPlan =
  | { kind: "focus"; label: string }
  | { kind: "loadHere" }
  | { kind: "loadElsewhere"; label: string }
  | { kind: "newWindow" };

/**
 * Pure mapping from Rust's Resolution (+ this window's label) to what the
 * frontend does. Any malformed/unknown resolution falls back to a new window —
 * the always-safe choice (it never clobbers a loaded project).
 */
export function planOpen(r: Resolution, myLabel: string): OpenPlan {
  if (r.action === "focus" && r.label) return { kind: "focus", label: r.label };
  if (r.action === "reuse" && r.label)
    return r.label === myLabel
      ? { kind: "loadHere" }
      : { kind: "loadElsewhere", label: r.label };
  return { kind: "newWindow" };
}

/** The `?openFile=` path a window was spawned to load, if any (decoded). */
export function readOpenFileParam(search: string): string | null {
  return new URLSearchParams(search).get("openFile");
}

/** Ask Rust where an open request for `path` should go. */
export async function resolveOpen(
  path: string,
  preferLabel: string
): Promise<Resolution> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<Resolution>(sleapCmd("resolve_open"), { path, preferLabel });
}

/** Record (or clear, with `null`) the file this window has open, in the registry. */
export async function windowSetFile(
  label: string,
  path: string | null
): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke(sleapCmd("window_set_file"), { label, path });
}

/** Bring the window with `label` to the foreground (un-minimize, show, focus). */
export async function focusWindow(label: string): Promise<void> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const w = await WebviewWindow.getByLabel(label);
  if (!w) return;
  await w.unminimize().catch(() => {});
  await w.show().catch(() => {});
  await w.setFocus().catch(() => {});
}

/** Load a .slp into THIS window (used when this window is the empty target). */
async function loadHere(path: string): Promise<void> {
  const { loadProjectFromPath } = await import("./loadProject");
  const { readFile, exists } = await import("@tauri-apps/plugin-fs");
  await loadProjectFromPath(path, readFile, exists);
}

/**
 * Route an open request for `path` (desktop only). Focuses an existing window
 * that has the file, reuses an empty window, or spawns a new one — see module
 * docs. Safe to call from any window; the decision is centralized in Rust.
 */
export async function openOrFocusPath(path: string): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const myLabel = getCurrentWindow().label;
  const plan = planOpen(await resolveOpen(path, myLabel), myLabel);

  switch (plan.kind) {
    case "focus":
      await focusWindow(plan.label);
      return;
    case "loadHere":
      await loadHere(path);
      return;
    case "loadElsewhere": {
      const { emitTo } = await import("@tauri-apps/api/event");
      await emitTo(plan.label, "load-file", { path });
      await focusWindow(plan.label);
      return;
    }
    case "newWindow": {
      const { openNewInstance } = await import("./newInstance");
      await openNewInstance({ file: path });
      return;
    }
  }
}
