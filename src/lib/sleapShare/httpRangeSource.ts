/**
 * Authenticated HTTP RangeSource for lazy streaming of private `.slp` /
 * `.pkg.slp` datasets from SLEAP Share (or any CORS + Range + Bearer host).
 *
 * Uses an aligned-page LRU cache (256 KiB pages, capped at 16 MiB) so
 * `readSlpStreaming()`'s many small sequential HDF5 reads coalesce into a few
 * HTTP Range requests instead of downloading multi-GB files eagerly into RAM.
 */

import { RemoteIOError, redactUrl, type RangeSource } from "@talmolab/sleap-io.js";

const DEFAULT_PAGE_SIZE = 256 * 1024; // 256 KiB
const DEFAULT_MAX_PAGES = 64; // 16 MiB cap

export interface HttpRangeSourceOptions {
  headers?: Record<string, string>;
  pageSize?: number;
  maxPages?: number;
  fetchImpl?: typeof fetch;
}

export interface HttpRangeSource extends RangeSource {
  readonly url: string;
  /** Last HTTP error thrown by a readRange call (readSlpStreaming may wrap worker errors). */
  lastError: Error | null;
}

function parseContentRangeTotal(header: string | null): number | null {
  if (!header) return null;
  const m = /\/(\d+)$/.exec(header.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function makeHttpError(url: string, status: number): RemoteIOError {
  const safeUrl = redactUrl(url);
  if (status === 401 || status === 403) {
    return new RemoteIOError({
      message: `Authorization failed (${status}) for ${safeUrl}. Sign in to SLEAP Share or reopen from the dataset page.`,
      url: safeUrl,
      status,
    });
  }
  if (status === 404) {
    return new RemoteIOError({
      message: `Dataset not found or private (404) at ${safeUrl}.`,
      url: safeUrl,
      status,
    });
  }
  return new RemoteIOError({
    message: `HTTP ${status} fetching ${safeUrl}`,
    url: safeUrl,
    status,
  });
}

/**
 * Determine total byte length of a remote file using HEAD, falling back to a
 * 1-byte Range GET (`bytes=0-0`) when Content-Length is absent.
 */
export async function probeRemoteFileSize(
  url: string,
  headers: Record<string, string> = {},
  fetchImpl: typeof fetch = fetch
): Promise<number> {
  const headRes = await fetchImpl(url, {
    method: "HEAD",
    headers,
  });
  if (!headRes.ok) {
    throw makeHttpError(url, headRes.status);
  }
  const cl = Number(headRes.headers.get("Content-Length"));
  if (Number.isFinite(cl) && cl > 0) {
    return cl;
  }

  // Fallback: 1-byte range probe
  const rangeRes = await fetchImpl(url, {
    method: "GET",
    headers: { ...headers, Range: "bytes=0-0" },
  });
  if (!rangeRes.ok && rangeRes.status !== 206) {
    throw makeHttpError(url, rangeRes.status);
  }
  const total = parseContentRangeTotal(rangeRes.headers.get("Content-Range"));
  if (total !== null) return total;
  const fallbackLen = Number(rangeRes.headers.get("Content-Length"));
  if (Number.isFinite(fallbackLen) && fallbackLen >= 0) return fallbackLen;

  const safeUrl = redactUrl(url);
  throw new RemoteIOError({
    message: `Server did not advertise Content-Length or Content-Range for ${safeUrl}`,
    url: safeUrl,
    status: null,
  });
}

/**
 * Create a cached, authenticated HTTP {@link RangeSource} for `url`.
 */
export async function createAuthenticatedHttpRangeSource(
  url: string,
  options: HttpRangeSourceOptions = {}
): Promise<HttpRangeSource> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = { ...(options.headers ?? {}) };
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;

  const size = await probeRemoteFileSize(url, headers, fetchImpl);
  const cache = new Map<number, Uint8Array>();
  const inflight = new Map<number, Promise<Uint8Array>>();

  const source: HttpRangeSource = {
    url,
    size,
    lastError: null,

    async readRange(offset: number, length: number): Promise<Uint8Array> {
      if (length <= 0 || offset >= size) return new Uint8Array(0);
      const clampedEnd = Math.min(size, offset + length);
      const outLen = clampedEnd - offset;

      const firstPage = Math.floor(offset / pageSize);
      const lastPage = Math.floor((clampedEnd - 1) / pageSize);

      const getPage = async (pageIdx: number): Promise<Uint8Array> => {
        const hit = cache.get(pageIdx);
        if (hit) {
          // LRU refresh
          cache.delete(pageIdx);
          cache.set(pageIdx, hit);
          return hit;
        }
        const pending = inflight.get(pageIdx);
        if (pending) return pending;

        const pStart = pageIdx * pageSize;
        const pEnd = Math.min(size, pStart + pageSize) - 1;
        const promise = (async () => {
          try {
            const res = await fetchImpl(url, {
              method: "GET",
              headers: { ...headers, Range: `bytes=${pStart}-${pEnd}` },
            });
            if (!res.ok && res.status !== 206) {
              throw makeHttpError(url, res.status);
            }
            const buf = new Uint8Array(await res.arrayBuffer());
            // If a server ignored Range and returned 200 with the full body, slice it.
            const pageBytes =
              res.status === 200 && buf.byteLength > pEnd - pStart + 1
                ? buf.subarray(pStart, pEnd + 1)
                : buf;
            cache.set(pageIdx, pageBytes);
            while (cache.size > maxPages) {
              const oldestKey = cache.keys().next().value;
              if (oldestKey !== undefined) cache.delete(oldestKey);
              else break;
            }
            return pageBytes;
          } catch (err) {
            const wrapped =
              err instanceof Error ? err : new Error(String(err));
            source.lastError = wrapped;
            throw wrapped;
          } finally {
            inflight.delete(pageIdx);
          }
        })();
        inflight.set(pageIdx, promise);
        return promise;
      };

      // Single-page fast path
      if (firstPage === lastPage) {
        const page = await getPage(firstPage);
        const startInPage = offset - firstPage * pageSize;
        return page.slice(startInPage, startInPage + outLen);
      }

      // Multi-page stitch
      const pageIndices: number[] = [];
      for (let p = firstPage; p <= lastPage; p++) pageIndices.push(p);
      const pages = await Promise.all(pageIndices.map((p) => getPage(p)));

      const out = new Uint8Array(outLen);
      let written = 0;
      for (let i = 0; i < pages.length; i++) {
        const pIdx = pageIndices[i];
        const page = pages[i];
        const pStart = pIdx * pageSize;
        const sliceStart = Math.max(0, offset - pStart);
        const sliceEnd = Math.min(page.byteLength, clampedEnd - pStart);
        if (sliceEnd > sliceStart) {
          out.set(page.subarray(sliceStart, sliceEnd), written);
          written += sliceEnd - sliceStart;
        }
      }
      return written === outLen ? out : out.subarray(0, written);
    },
  };

  return source;
}
