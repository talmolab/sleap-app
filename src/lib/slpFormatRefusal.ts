/**
 * Helpers for handling `SlpFormatError` refusals from `@talmolab/sleap-io.js`
 * (e.g., SLP format 3.0+ files or unknown required features that this version
 * of SLEAP cannot read).
 *
 * Surfaces refusals through the dedicated {@link SlpFormatRefusalDialog} modal
 * instead of a transient toast so users see clear upgrade instructions and a
 * copyable 2.x conversion snippet while leaving any open project untouched.
 */

import { SlpFormatError } from "@talmolab/sleap-io.js";
import { useSlpFormatDialogStore } from "@/stores/slpFormatDialogStore";

/** GitHub Releases landing page opened by [Upgrade] in the web build. */
export const SLEAP_APP_RELEASES_PAGE_URL =
  "https://github.com/talmolab/sleap-app/releases";

/** Shape of an `SlpFormatError`, including Worker-serialized copies. */
export interface SlpFormatErrorLike {
  name?: string;
  message: string;
  labelsPath?: string;
  formatId?: number | null;
  unsupportedFeatures?: string[];
  requiredFeatures?: string[];
}

/** Normalized refusal payload displayed by `SlpFormatRefusalDialog`. */
export interface SlpFormatRefusal {
  fileName: string;
  formatId: number | null;
  unsupportedFeatures: string[];
  detail: string;
}

/**
 * Matches both live `SlpFormatError` instances and errors whose prototype was
 * lost during Worker/IPC serialization (`err.name === "SlpFormatError"`).
 */
export function isSlpFormatError(err: unknown): err is SlpFormatErrorLike {
  if (err instanceof SlpFormatError) return true;
  if (typeof err !== "object" || err === null) return false;
  const candidate = err as { name?: unknown; message?: unknown };
  return (
    candidate.name === "SlpFormatError" &&
    typeof candidate.message === "string"
  );
}

/** Extract the basename of a path or URL for display in the modal. */
export function displayRefusedFileName(
  pathOrName: string | null | undefined,
): string {
  if (!pathOrName) return "This file";
  const withoutQuery = pathOrName.split(/[?#]/)[0];
  const base = withoutQuery.split(/[\\/]/).filter(Boolean).pop();
  return base || "This file";
}

/** Format a numeric SLP format id (`3` -> `"3.0"`, `3.1` -> `"3.1"`). */
export function formatSlpVersion(formatId: number): string {
  return Number.isInteger(formatId) ? formatId.toFixed(1) : String(formatId);
}

/** Fallback parser when a serialized error retains only its `message`. */
function parseFormatIdFromMessage(message: string): number | null {
  const match = /\bSLP format\s+(\d+(?:\.\d+)?)\b/i.exec(message);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeFeatureList(
  err: SlpFormatErrorLike,
): string[] {
  const raw = err.unsupportedFeatures ?? err.requiredFeatures;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string" && item.length > 0);
}

/** Build the UI refusal payload from a live or serialized `SlpFormatError`. */
export function extractSlpFormatRefusal(
  err: SlpFormatErrorLike,
  fileNameHint?: string,
): SlpFormatRefusal {
  const formatId =
    typeof err.formatId === "number" && Number.isFinite(err.formatId)
      ? err.formatId
      : parseFormatIdFromMessage(err.message);
  return {
    fileName: displayRefusedFileName(fileNameHint || err.labelsPath),
    formatId,
    unsupportedFeatures: normalizeFeatureList(err),
    detail: err.message,
  };
}

/**
 * Whether Python `sleap-io >= 0.10` can re-save a 2.x-compatible copy
 * (formats below 4.0, or unknown format id).
 */
export function canSaveLegacyV2Copy(formatId: number | null): boolean {
  return formatId === null || formatId < 4;
}

/** Concise copyable Python snippet to save a 2.x-compatible copy in sleap-io >= 0.10. */
export function legacyV2CopyCommand(fileName: string): string {
  const input = fileName && fileName !== "This file" ? fileName : "input.slp";
  const stem = input.replace(/\.slp$/i, "");
  const output = `${stem}.v2.slp`;
  return [
    "import sleap_io as sio",
    `labels = sio.load_slp(${JSON.stringify(input)})`,
    `labels.save(${JSON.stringify(output)}, slp_version="v2")`,
  ].join("\n");
}

/**
 * If `err` is an `SlpFormatError` (live or worker-serialized), open the
 * refusal modal and return `true` so the caller can suppress `toast.error`.
 * Returns `false` for all other errors.
 */
export function handleSlpFormatError(
  err: unknown,
  fileNameHint?: string,
): boolean {
  if (!isSlpFormatError(err)) return false;
  useSlpFormatDialogStore
    .getState()
    .open(extractSlpFormatRefusal(err, fileNameHint));
  return true;
}
