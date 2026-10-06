/**
 * A short, stable, human-meaningful tag for the project attached to a remote
 * job (PR3, docs/plans/2026-10-04-connect-pr3-detailed-plan.md §3a.5) — lets
 * a worker's job list/history (sleap-connect #98's `job.project`, the same
 * `JobProject` shape) show which project submitted a job without the app
 * ever sending a full local path. Pure and synchronous: both fields are
 * derived directly from `projectPath`, nothing else.
 */
import type { JobProject } from "@/lib/protocolV1/client";

/** Last path segment of a filesystem path (handles both `/` and `\`). */
function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

/**
 * 32-bit FNV-1a hash, formatted as 8 lowercase hex digits — fast,
 * dependency-free, and deterministic across platforms/runs. Collisions are a
 * non-issue here: this is a display tag for a job list, not an identity or
 * security key.
 */
function fnv1aHex8(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * `name` is the project file's basename, or `"untitled.slp"` for an unsaved
 * project (`projectPath === null`). `id` is an 8-hex FNV-1a hash of the full
 * path — or of `""` for an unsaved project, so every untitled project tags
 * the same way (there's no path to disambiguate them by anyway).
 */
export function projectTag(projectPath: string | null): JobProject {
  return {
    name: projectPath ? basename(projectPath) : "untitled.slp",
    id: fnv1aHex8(projectPath ?? ""),
  };
}
