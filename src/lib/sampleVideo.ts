/**
 * The fixed sample video (mice.mp4) the tutorial is built around, fetched on
 * demand by the New Project dialog's "Use sample video" button.
 *
 * Served from raw.githubusercontent.com, pinned to a commit: unlike the old
 * Google Drive link it sends `access-control-allow-origin: *`, so the app can
 * fetch it from app.sleap.ai and from the Tauri WebView. Not bundled in
 * `public/` — 31 MB would ship in every installer and in every permanent
 * app.sleap.ai/<tag>/ deploy folder.
 */

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
