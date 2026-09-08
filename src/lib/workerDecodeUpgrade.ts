/**
 * App-side wiring for off-main-thread video decode (scrub-proxy v2 follow-up).
 *
 * The app opens a video on the on-main `Mp4BoxVideoBackend` immediately (instant,
 * always works), then upgrades — in the background — to io's `WorkerMp4BoxBackend`
 * (which decodes in a Web Worker) once the worker self-test passes. Any failure
 * leaves the on-main backend in place: the upgrade is a pure optimization and can
 * never break video open. Mirrors the Thread-C proxy hot-swap's safety contract.
 *
 * This module holds the serializable byte-source descriptor builders (the worker
 * can't receive a closure) and the injected orchestration; the concrete
 * `scheduleWorkerDecodeUpgrade` wiring lives in `resolveVideos.ts` (next to the
 * proxy hot-swap), like `runBackgroundProxySwap`.
 *
 * @module
 */

import type {
  ByteSourceDescriptor,
  Mp4ParseResult,
  VideoBackend,
} from "@talmolab/sleap-io.js";
import { convertFileSrc } from "@tauri-apps/api/core";
import { fileSize } from "./nativeRange";
import { sleapCmd } from "./sleapPlugin";
import { captureInvokeKey, getCachedInvokeKey } from "./tauriInvokeKey";

/**
 * Build the desktop (Tauri) byte-source descriptor the worker turns into a
 * `readRange`: the custom-protocol IPC url for `plugin:sleap|read_range` plus the
 * headers Tauri requires (invoke key + dummy callback/error). Returns null when
 * the key can't be captured or the file can't be sized. See {@link captureInvokeKey}.
 */
export async function buildTauriByteSourceDescriptor(
  path: string,
): Promise<ByteSourceDescriptor | null> {
  let size = 0;
  let key = getCachedInvokeKey();
  try {
    if (key) {
      size = await fileSize(path);
    } else {
      key = await captureInvokeKey(async () => {
        size = await fileSize(path);
      });
      if (!size) size = await fileSize(path);
    }
  } catch {
    return null;
  }
  if (!key || !size) return null;

  const url = convertFileSrc(sleapCmd("read_range"), "ipc");
  return {
    kind: "tauri",
    url,
    headers: {
      "Content-Type": "application/json",
      "Tauri-Callback": "1",
      "Tauri-Error": "2",
      "Tauri-Invoke-Key": key,
    },
    path,
    size,
  };
}

/**
 * Build the browser byte-source descriptor from a `Blob`/`File` (worker slices it
 * directly). The worker path is the ONLY way to unblock the main thread in a
 * browser (no proxies there).
 */
export function buildBlobByteSourceDescriptor(blob: Blob): ByteSourceDescriptor {
  return { kind: "blob", blob, size: blob.size };
}

/**
 * Build the browser byte-source descriptor for a remote video (worker does ranged
 * `fetch` with a `Range` header). `size` is the total file length (from the
 * backend's range-probe / parse), needed so the worker's reads never run past EOF
 * and so the upgrade's file-size guard matches. `headers` carries any auth applied
 * to the video fetches.
 */
export function buildUrlByteSourceDescriptor(
  url: string,
  headers: Record<string, string>,
  size: number,
): ByteSourceDescriptor {
  return { kind: "url", url, headers, size };
}

export type WorkerUpgradeOutcome =
  | "upgraded"
  | "unsupported"
  | "skipped"
  | "superseded"
  | "failed";

/** A backend that can hand off its main-thread parse to the worker. */
interface HasParseResult {
  getParseResult(): Promise<Mp4ParseResult>;
}
function canParse(backend: unknown): backend is HasParseResult {
  return (
    !!backend &&
    typeof (backend as HasParseResult).getParseResult === "function"
  );
}

export interface WorkerUpgradeDeps {
  /** Cheap pre-check: is a Worker constructible here? (io `isWorkerDecodeAvailable`). */
  isAvailable: () => boolean;
  /** Build the serializable byte source for the worker (tauri/blob). */
  buildDescriptor: (path: string) => Promise<ByteSourceDescriptor | null>;
  /** Construct + self-test the worker backend (io `WorkerMp4BoxBackend.create`). */
  createWorkerBackend: (params: {
    parseResult: Mp4ParseResult;
    byteSource: ByteSourceDescriptor;
    filename: string;
  }) => Promise<VideoBackend>;
  /** Is the target video still the active one? */
  isStillActive: () => boolean;
  /** The video's CURRENT backend (guards against a proxy already swapping in). */
  currentBackend: () => VideoBackend | null;
  /** Install the worker backend. */
  swap: (backend: VideoBackend) => void;
  /** Re-read the current frame from the freshly-swapped backend. */
  triggerReread: () => void;
  onUpgraded?: () => void;
}

/**
 * Upgrade `originalBackend` to an off-main worker backend, or leave it untouched.
 * Never throws. Returns why: `upgraded`, `unsupported` (worker self-test failed →
 * keep on-main), `skipped` (not applicable), or `superseded` (video/backend
 * changed — e.g. the Thread-C proxy swapped in first, which must win).
 */
export async function runWorkerDecodeUpgrade(
  originalBackend: VideoBackend,
  path: string,
  filename: string,
  deps: WorkerUpgradeDeps,
): Promise<WorkerUpgradeOutcome> {
  if (!deps.isAvailable()) return "skipped";
  if (!canParse(originalBackend)) return "skipped";

  let parseResult: Mp4ParseResult;
  try {
    parseResult = await originalBackend.getParseResult();
  } catch {
    return "skipped";
  }

  const byteSource = await deps.buildDescriptor(path);
  if (!byteSource) return "skipped";

  // Safety: the sample table (from the current backend) must describe the SAME
  // file as the byte source. If a cached scrub proxy already swapped in, its
  // parse is of the PROXY file while the descriptor is built from the original
  // `path` — decoding proxy offsets against original bytes would corrupt frames.
  // A size mismatch means "different file" → skip rather than corrupt.
  if (byteSource.size !== parseResult.fileSize) return "skipped";

  // Don't clobber a proxy that already swapped in, or a closed/changed video.
  if (!deps.isStillActive() || deps.currentBackend() !== originalBackend) {
    return "superseded";
  }

  let workerBackend: VideoBackend;
  try {
    workerBackend = await deps.createWorkerBackend({
      parseResult,
      byteSource,
      filename,
    });
  } catch {
    return "unsupported"; // worker self-test failed → keep the on-main backend
  }

  // Re-check after the async create: never swap onto a video the user has since
  // closed/changed, or over a proxy that swapped in meanwhile (don't leak it).
  if (!deps.isStillActive() || deps.currentBackend() !== originalBackend) {
    try {
      workerBackend.close();
    } catch {
      // ignore
    }
    return "superseded";
  }

  deps.swap(workerBackend);
  deps.triggerReread();
  deps.onUpgraded?.();
  // Free the on-main backend's decoder/cache. Its parse result (sample table) is
  // shared by reference with the worker backend and stays valid after close().
  if (originalBackend !== workerBackend) {
    try {
      originalBackend.close();
    } catch {
      // ignore
    }
  }
  return "upgraded";
}
