/**
 * The fixed sample video (mice.mp4) the tutorial is built around, fetched on
 * demand by the New Project dialog's "Use sample video" button.
 *
 * Served from raw.githubusercontent.com, pinned to a commit: unlike the old
 * Google Drive link it sends `access-control-allow-origin: *`, so the app can
 * fetch it from app.sleap.ai and from the Tauri WebView. Not bundled in
 * `public/` — 31 MB would ship in every installer and in every permanent
 * app.sleap.ai/<tag>/ deploy folder.
 *
 * {@link loadSampleVideo} turns the fetched bytes into a {@link PickedVideoFile}
 * — the same shape the dropzone and file picker already produce — so the New
 * Project dialog's existing `VideoImportList` → `addVideoFileToLabels`
 * pipeline needs no changes. Browser keeps the bytes in memory as a `File`;
 * desktop writes them once to a cache file and stages the video **by absolute
 * path**, mirroring `pickVideoFiles` (resolveVideos.ts), because sleap-nn
 * training/inference needs a real file on disk.
 */
import type { PickedVideoFile } from "@/lib/resolveVideos";

const SAMPLE_DATA_COMMIT = "b5b500b29584b71f704b9791221077727ccd2f1d";

export const SAMPLE_VIDEO = {
  name: "mice.mp4",
  url: `https://raw.githubusercontent.com/talmolab/sleap-tutorial-data/${SAMPLE_DATA_COMMIT}/mice.mp4`,
  /** Expected size; also the progress denominator when content-length is missing. */
  bytes: 31_258_120,
} as const;

export interface FetchSampleOptions {
  /** 0..1 */
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Fetch {@link SAMPLE_VIDEO} with incremental progress, via `ReadableStream`
 * chunks rather than a single `res.blob()` — the only way to report fractional
 * progress on a `fetch()` response. Throws if the server errors, or if the
 * stream ends short of a reported `content-length` (a truncated download that
 * would otherwise silently hand back a corrupt/partial video).
 */
export async function fetchSampleVideoBytes(opts: FetchSampleOptions = {}): Promise<Uint8Array> {
  const { onProgress, signal, fetchImpl = fetch } = opts;
  const res = await fetchImpl(SAMPLE_VIDEO.url, { signal });
  if (!res.ok || !res.body) throw new Error(`Sample video download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get("content-length")) || SAMPLE_VIDEO.bytes;

  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(Math.min(received / total, 1));
  }
  if (res.headers.get("content-length") && received !== total) {
    throw new Error("Sample video download was incomplete — try again.");
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Injectable filesystem adapter for the desktop sample-video cache, so the
 * cache-hit/miss branching in {@link loadSampleVideo} is unit-testable without
 * a Tauri runtime (happy-dom has no `@tauri-apps/plugin-fs`). The real
 * implementation is {@link tauriSampleCacheFs}.
 */
export interface SampleCacheFs {
  /** `<appLocalDataDir>/samples/mice.mp4` */
  cachePath(): Promise<string>;
  /** Size of the file at `path` in bytes, or `null` if it doesn't exist. */
  size(path: string): Promise<number | null>;
  /**
   * Write `bytes` to `path`: mkdir -p the parent, write to a `.part` sibling,
   * then rename over `path`. An interrupted write (crash, killed process)
   * leaves only the `.part` file behind, never a truncated file at `path`
   * that a later {@link size} check would mistake for a complete cache hit.
   */
  write(path: string, bytes: Uint8Array): Promise<void>;
}

/**
 * The default {@link SampleCacheFs}, backed by `@tauri-apps/plugin-fs` /
 * `@tauri-apps/api/path` (dynamic imports: this module is also loaded in the
 * browser build, which has neither package — same style as
 * `tauriDraft.ts`'s `tauriDraftFs()` / `sessionLog.ts`'s `initSessionLog()`).
 */
async function tauriSampleCacheFs(): Promise<SampleCacheFs> {
  const { appLocalDataDir, join } = await import("@tauri-apps/api/path");
  const { mkdir, stat, writeFile, rename, exists, remove } = await import(
    "@tauri-apps/plugin-fs"
  );

  async function cachePath(): Promise<string> {
    return join(await appLocalDataDir(), "samples", SAMPLE_VIDEO.name);
  }

  return {
    cachePath,
    async size(path) {
      try {
        const info = await stat(path);
        return info.size;
      } catch {
        return null; // missing (or unreadable) -> treat as a cache miss
      }
    },
    async write(path, bytes) {
      await mkdir(await join(await appLocalDataDir(), "samples"), { recursive: true });
      const partPath = `${path}.part`;
      await writeFile(partPath, bytes);
      // rename() is documented to replace an existing destination file, but
      // that's not guaranteed on Windows (MoveFileEx can refuse when the
      // target already exists) -- remove a stale final file first instead of
      // relying on it.
      if (await exists(path)) {
        await remove(path);
      }
      await rename(partPath, path);
    },
  };
}

export interface LoadSampleVideoOptions extends FetchSampleOptions {
  /** Which branch to take: in-memory `File` (browser) vs. cached-path (desktop). */
  isTauri: boolean;
  /** Desktop only. Defaults to {@link tauriSampleCacheFs}; inject a fake in tests. */
  fs?: SampleCacheFs;
}

/**
 * Resolve {@link SAMPLE_VIDEO} into a {@link PickedVideoFile}, platform-aware:
 * - **Browser:** fetches the whole file into memory and wraps it in a `File`,
 *   `absPath: null` -- matching what a dropped file produces today.
 * - **Desktop:** reuses a cached copy at the expected size, otherwise fetches
 *   and writes it once, then stages by absolute path with an empty `File`
 *   (name only), mirroring `pickVideoFiles` (resolveVideos.ts) -- sleap-nn
 *   training/inference needs a real file on disk, not an in-memory blob.
 */
export async function loadSampleVideo(opts: LoadSampleVideoOptions): Promise<PickedVideoFile> {
  const { isTauri, onProgress, signal, fetchImpl } = opts;

  if (!isTauri) {
    const bytes = await fetchSampleVideoBytes({ onProgress, signal, fetchImpl });
    return {
      file: new File([bytes], SAMPLE_VIDEO.name, { type: "video/mp4" }),
      absPath: null,
    };
  }

  const fs = opts.fs ?? (await tauriSampleCacheFs());
  const path = await fs.cachePath();

  if ((await fs.size(path)) === SAMPLE_VIDEO.bytes) {
    onProgress?.(1);
    return {
      file: new File([], SAMPLE_VIDEO.name, { type: "video/mp4" }),
      absPath: path,
    };
  }

  const bytes = await fetchSampleVideoBytes({ onProgress, signal, fetchImpl });
  await fs.write(path, bytes);
  return {
    file: new File([], SAMPLE_VIDEO.name, { type: "video/mp4" }),
    absPath: path,
  };
}
