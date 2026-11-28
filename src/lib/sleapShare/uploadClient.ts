/**
 * SLEAP Share upload protocol client (single-file, ≥100 MB multipart with retry
 * & abort, and multi-file `.slp` + companion videos).
 *
 * Transport abstraction:
 *  - Browser: XMLHttpRequest PUT with upload progress, ETag capture, and AbortSignal.
 *  - Desktop (Tauri): Rust `sleap_share_upload_file` streaming straight from disk
 *    via reqwest (bypasses dynamic-localhost-port R2 CORS and keeps memory flat).
 */

import { isTauri } from "@/lib/platform";
import { sleapCmd } from "@/lib/sleapPlugin";
import { getSleapShareBaseUrl } from "./config";

export const MULTIPART_THRESHOLD_BYTES = 100 * 1024 * 1024; // 100 MiB
export const ANON_MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MiB
export const AUTH_MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024; // 5 GiB

export type UploadSourcePayload =
  | {
      kind: "blob";
      blob: Blob;
      filename: string;
      size: number;
      role?: string;
    }
  | {
      kind: "path";
      path: string;
      filename: string;
      size: number;
      role?: string;
    };

export interface UploadMetadataOptions {
  name?: string;
  notes?: string;
  isPrivate?: boolean;
  permanent?: boolean;
  isSupport?: boolean;
  githubRepo?: string;
  githubType?: "issue" | "pr" | "discussion";
  githubNumber?: number;
}

export interface UploadProgress {
  stage: "init" | "uploading" | "completing";
  loadedBytes: number;
  totalBytes: number;
  detail?: string;
}

export interface UploadResult {
  shortcode: string;
  shareUrl: string;
  dataUrl: string;
  fileSize: number;
  expiresAt: number | null;
  isPrivate: boolean;
  permanent: boolean;
  memberCount?: number;
}

export interface PutOptions {
  url: string;
  payload: UploadSourcePayload;
  /** Sent as `Content-Type` ONLY when provided (single/multifile yes; multipart part PUT no). */
  contentType?: string;
  offset?: number;
  length?: number;
  signal?: AbortSignal;
  onProgress?: (loaded: number, total: number) => void;
}

export type PutTransport = (opts: PutOptions) => Promise<{ etag?: string }>;

export interface UploadClientOptions {
  baseUrl?: string;
  token?: string;
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
  fetchImpl?: typeof fetch;
  putTransport?: PutTransport;
  /** Part retry backoff base in ms (overridable in unit tests). */
  retryBaseDelayMs?: number;
}

export class UploadCancelledError extends Error {
  constructor(message = "Upload cancelled") {
    super(message);
    this.name = "UploadCancelledError";
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new UploadCancelledError();
  }
}

function makeUploadId(): string {
  return typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `up-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Browser presigned PUT transport via XMLHttpRequest (supports upload progress). */
export function browserXhrPutTransport(opts: PutOptions): Promise<{ etag?: string }> {
  if (opts.payload.kind !== "blob") {
    return Promise.reject(new Error("Browser XHR transport requires a Blob payload"));
  }
  const { blob } = opts.payload;
  const start = opts.offset ?? 0;
  const body =
    opts.offset !== undefined || opts.length !== undefined
      ? blob.slice(start, opts.length !== undefined ? start + opts.length : blob.size)
      : blob;
  const expectedTotal = body.size;

  return new Promise<{ etag?: string }>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new UploadCancelledError());
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open("PUT", opts.url, true);
    if (opts.contentType) {
      xhr.setRequestHeader("Content-Type", opts.contentType);
    }

    const onAbort = () => {
      xhr.abort();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    const cleanup = () => {
      opts.signal?.removeEventListener("abort", onAbort);
    };

    xhr.upload.onprogress = (ev) => {
      const total = ev.lengthComputable && ev.total > 0 ? ev.total : expectedTotal;
      opts.onProgress?.(Math.min(ev.loaded, total), total);
    };

    xhr.onload = () => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        opts.onProgress?.(expectedTotal, expectedTotal);
        const rawEtag = xhr.getResponseHeader("ETag") || xhr.getResponseHeader("etag");
        const etag = rawEtag ? rawEtag.trim().replace(/^"|"$/g, "") : undefined;
        resolve({ etag });
      } else {
        const snippet = (xhr.responseText || "").slice(0, 200).trim();
        reject(
          new Error(
            snippet
              ? `Storage upload failed (${xhr.status}): ${snippet}`
              : `Storage upload failed with HTTP ${xhr.status}`
          )
        );
      }
    };

    xhr.onerror = () => {
      cleanup();
      reject(new Error("Network error while uploading file to storage."));
    };

    xhr.onabort = () => {
      cleanup();
      reject(new UploadCancelledError());
    };

    xhr.send(body);
  });
}

/** Desktop (Tauri) streaming PUT transport backed by Rust `sleap_share_upload_file`. */
export async function tauriRustPutTransport(opts: PutOptions): Promise<{ etag?: string }> {
  if (opts.payload.kind !== "path") {
    return browserXhrPutTransport(opts);
  }
  throwIfAborted(opts.signal);

  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");

  const uploadId = makeUploadId();
  let unlisten: (() => void) | undefined;

  if (opts.onProgress) {
    unlisten = await listen<{ uploadId: string; loaded: number; total: number }>(
      "sleap-share-upload-progress",
      (ev) => {
        if (ev.payload?.uploadId === uploadId) {
          opts.onProgress?.(ev.payload.loaded, ev.payload.total);
        }
      }
    );
  }

  const onAbort = () => {
    void invoke(sleapCmd("sleap_share_cancel_upload"), { uploadId }).catch(() => {});
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const res = await invoke<{ etag?: string | null; status: number }>(
      sleapCmd("sleap_share_upload_file"),
      {
        uploadId,
        presignedUrl: opts.url,
        filePath: opts.payload.path,
        contentType: opts.contentType ?? null,
        offset: opts.offset ?? null,
        length: opts.length ?? null,
      }
    );
    return { etag: res.etag ?? undefined };
  } catch (err) {
    if (opts.signal?.aborted) {
      throw new UploadCancelledError();
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.toLowerCase().includes("upload cancelled")) {
      throw new UploadCancelledError(msg);
    }
    throw new Error(msg);
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    unlisten?.();
  }
}

function defaultPutTransport(): PutTransport {
  return isTauri ? tauriRustPutTransport : browserXhrPutTransport;
}

function buildApiHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Upload-Source": "sleap-app",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function buildMetaBody(meta: UploadMetadataOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (meta.name?.trim()) out.name = meta.name.trim();
  if (meta.notes?.trim()) out.notes = meta.notes.trim();
  if (meta.isPrivate) out.private = true;
  if (meta.permanent) out.permanent = true;
  if (meta.isSupport) {
    out.isSupport = true;
    if (meta.githubRepo) out.githubRepo = meta.githubRepo;
    if (meta.githubType) out.githubType = meta.githubType;
    if (meta.githubNumber != null && Number.isInteger(meta.githubNumber) && meta.githubNumber > 0) {
      out.githubNumber = meta.githubNumber;
    }
  }
  return out;
}

async function apiPostJson<T>(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch
): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted || (err instanceof DOMException && err.name === "AbortError")) {
      throw new UploadCancelledError();
    }
    throw err;
  }
  const data = (await res.json().catch(() => null)) as
    | (T & { error?: string; message?: string })
    | null;
  if (!res.ok) {
    const msg = data?.error || data?.message || `SLEAP Share request failed (${res.status})`;
    throw new Error(msg);
  }
  if (!data) {
    throw new Error(`Invalid response from SLEAP Share (${res.status})`);
  }
  return data;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UploadCancelledError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new UploadCancelledError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function uploadSingleFile(
  payload: UploadSourcePayload,
  meta: UploadMetadataOptions,
  opts: UploadClientOptions
): Promise<UploadResult> {
  const base = (opts.baseUrl || getSleapShareBaseUrl()).replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const putTransport = opts.putTransport ?? defaultPutTransport();
  const headers = buildApiHeaders(opts.token);
  const metaBody = buildMetaBody(meta);
  const retryBase = opts.retryBaseDelayMs ?? 1000;

  throwIfAborted(opts.signal);
  opts.onProgress?.({
    stage: "init",
    loadedBytes: 0,
    totalBytes: payload.size,
    detail: "Initializing upload…",
  });

  if (payload.size < MULTIPART_THRESHOLD_BYTES) {
    const init = await apiPostJson<{
      shortcode: string;
      uploadUrl: string;
      isPrivate?: boolean;
    }>(
      `${base}/api/upload/init`,
      { filename: payload.filename, fileSize: payload.size, ...metaBody },
      headers,
      opts.signal,
      fetchImpl
    );

    opts.onProgress?.({
      stage: "uploading",
      loadedBytes: 0,
      totalBytes: payload.size,
      detail: `Uploading ${payload.filename}…`,
    });

    await putTransport({
      url: init.uploadUrl,
      payload,
      contentType: "application/octet-stream",
      signal: opts.signal,
      onProgress: (loaded, total) => {
        opts.onProgress?.({
          stage: "uploading",
          loadedBytes: loaded,
          totalBytes: total || payload.size,
          detail: `Uploading ${payload.filename}…`,
        });
      },
    });

    throwIfAborted(opts.signal);
    opts.onProgress?.({
      stage: "completing",
      loadedBytes: payload.size,
      totalBytes: payload.size,
      detail: "Validating & finalizing…",
    });

    const done = await apiPostJson<{
      shortcode: string;
      shareUrl: string;
      dataUrl: string;
      fileSize: number;
      expiresAt: number | null;
      isPrivate?: boolean;
      permanent?: boolean;
    }>(
      `${base}/api/upload/complete`,
      { shortcode: init.shortcode },
      headers,
      opts.signal,
      fetchImpl
    );

    return {
      shortcode: done.shortcode,
      shareUrl: done.shareUrl,
      dataUrl: done.dataUrl,
      fileSize: done.fileSize ?? payload.size,
      expiresAt: done.expiresAt ?? null,
      isPrivate: done.isPrivate ?? meta.isPrivate === true,
      permanent: done.permanent ?? meta.permanent === true,
    };
  }

  // Multipart upload (>= 100 MiB)
  const init = await apiPostJson<{
    shortcode: string;
    uploadId: string;
    partSize: number;
    totalParts: number;
    parts: Array<{ partNumber: number; uploadUrl: string }>;
    isPrivate?: boolean;
  }>(
    `${base}/api/upload/multipart/init`,
    {
      filename: payload.filename,
      fileSize: payload.size,
      partSize: MULTIPART_THRESHOLD_BYTES,
      ...metaBody,
    },
    headers,
    opts.signal,
    fetchImpl
  );

  const completedParts: Array<{ partNumber: number; etag: string }> = [];
  let completedBytes = 0;

  try {
    for (const part of init.parts) {
      throwIfAborted(opts.signal);
      const offset = (part.partNumber - 1) * init.partSize;
      const length = Math.min(init.partSize, payload.size - offset);

      let etag: string | undefined;
      let lastErr: unknown;
      for (let attempt = 1; attempt <= 3; attempt++) {
        throwIfAborted(opts.signal);
        try {
          const res = await putTransport({
            url: part.uploadUrl,
            payload,
            // Multipart UploadPartCommand is NOT signed with Content-Type
            offset,
            length,
            signal: opts.signal,
            onProgress: (loaded) => {
              opts.onProgress?.({
                stage: "uploading",
                loadedBytes: Math.min(payload.size, completedBytes + loaded),
                totalBytes: payload.size,
                detail: `Uploading part ${part.partNumber} of ${init.totalParts}…`,
              });
            },
          });
          etag = res.etag;
          if (!etag) {
            throw new Error(`Missing ETag for part ${part.partNumber}`);
          }
          break;
        } catch (err) {
          if (err instanceof UploadCancelledError || opts.signal?.aborted) {
            throw new UploadCancelledError();
          }
          lastErr = err;
          if (attempt < 3) {
            await sleep(retryBase * 2 ** (attempt - 1), opts.signal);
          }
        }
      }

      if (!etag) {
        throw lastErr instanceof Error
          ? lastErr
          : new Error(`Failed to upload part ${part.partNumber}`);
      }

      completedParts.push({ partNumber: part.partNumber, etag });
      completedBytes += length;
      opts.onProgress?.({
        stage: "uploading",
        loadedBytes: Math.min(payload.size, completedBytes),
        totalBytes: payload.size,
        detail: `Uploaded part ${part.partNumber} of ${init.totalParts}`,
      });
    }

    throwIfAborted(opts.signal);
    opts.onProgress?.({
      stage: "completing",
      loadedBytes: payload.size,
      totalBytes: payload.size,
      detail: "Assembling & validating upload…",
    });

    const done = await apiPostJson<{
      shortcode: string;
      shareUrl: string;
      dataUrl: string;
      fileSize: number;
      expiresAt: number | null;
      isPrivate?: boolean;
      permanent?: boolean;
    }>(
      `${base}/api/upload/multipart/complete`,
      {
        shortcode: init.shortcode,
        uploadId: init.uploadId,
        parts: completedParts,
      },
      headers,
      opts.signal,
      fetchImpl
    );

    return {
      shortcode: done.shortcode,
      shareUrl: done.shareUrl,
      dataUrl: done.dataUrl,
      fileSize: done.fileSize ?? payload.size,
      expiresAt: done.expiresAt ?? null,
      isPrivate: done.isPrivate ?? meta.isPrivate === true,
      permanent: done.permanent ?? meta.permanent === true,
    };
  } catch (err) {
    // Best-effort abort so R2 doesn't retain orphaned multipart fragments.
    await apiPostJson(
      `${base}/api/upload/multipart/abort`,
      { shortcode: init.shortcode, uploadId: init.uploadId },
      headers,
      undefined,
      fetchImpl
    ).catch(() => {});
    throw err;
  }
}

async function uploadMultifileDataset(
  payloads: readonly UploadSourcePayload[],
  meta: UploadMetadataOptions,
  opts: UploadClientOptions
): Promise<UploadResult> {
  const base = (opts.baseUrl || getSleapShareBaseUrl()).replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const putTransport = opts.putTransport ?? defaultPutTransport();
  const headers = buildApiHeaders(opts.token);
  const metaBody = buildMetaBody(meta);
  const totalBytes = payloads.reduce((sum, p) => sum + p.size, 0);

  throwIfAborted(opts.signal);
  opts.onProgress?.({
    stage: "init",
    loadedBytes: 0,
    totalBytes,
    detail: `Initializing ${payloads.length}-file dataset…`,
  });

  const init = await apiPostJson<{
    shortcode: string;
    memberCount: number;
    members: Array<{
      filename: string;
      originalFilename: string;
      role: string;
      isPrimary: boolean;
      uploadUrl: string;
    }>;
  }>(
    `${base}/api/upload/multifile/init`,
    {
      files: payloads.map((p) => ({
        filename: p.filename,
        fileSize: p.size,
        ...(p.role ? { role: p.role } : {}),
      })),
      ...metaBody,
    },
    headers,
    opts.signal,
    fetchImpl
  );

  if (!Array.isArray(init.members) || init.members.length !== payloads.length) {
    throw new Error("Unexpected member list returned by SLEAP Share.");
  }

  let completedBytes = 0;
  for (let i = 0; i < payloads.length; i++) {
    throwIfAborted(opts.signal);
    const payload = payloads[i];
    const member = init.members[i];

    await putTransport({
      url: member.uploadUrl,
      payload,
      contentType: "application/octet-stream",
      signal: opts.signal,
      onProgress: (loaded) => {
        opts.onProgress?.({
          stage: "uploading",
          loadedBytes: Math.min(totalBytes, completedBytes + loaded),
          totalBytes,
          detail: `Uploading ${payload.filename} (${i + 1}/${payloads.length})…`,
        });
      },
    });
    completedBytes += payload.size;
  }

  throwIfAborted(opts.signal);
  opts.onProgress?.({
    stage: "completing",
    loadedBytes: totalBytes,
    totalBytes,
    detail: "Validating dataset & finalizing…",
  });

  const done = await apiPostJson<{
    shortcode: string;
    shareUrl: string;
    dataUrl: string;
    fileSize: number;
    expiresAt: number | null;
    isPrivate?: boolean;
    permanent?: boolean;
  }>(
    `${base}/api/upload/multifile/complete`,
    { shortcode: init.shortcode },
    headers,
    opts.signal,
    fetchImpl
  );

  return {
    shortcode: done.shortcode,
    shareUrl: done.shareUrl,
    dataUrl: done.dataUrl,
    fileSize: done.fileSize ?? totalBytes,
    expiresAt: done.expiresAt ?? null,
    isPrivate: done.isPrivate ?? meta.isPrivate === true,
    permanent: done.permanent ?? meta.permanent === true,
    memberCount: init.memberCount,
  };
}

/**
 * Upload one file (single/multipart) or multiple files (multifile dataset) to
 * SLEAP Share.
 */
export async function uploadToSleapShare(
  payloads: readonly UploadSourcePayload[],
  meta: UploadMetadataOptions,
  opts: UploadClientOptions = {}
): Promise<UploadResult> {
  if (payloads.length === 0) {
    throw new Error("No files selected to upload.");
  }
  if (payloads.length === 1) {
    return uploadSingleFile(payloads[0], meta, opts);
  }
  return uploadMultifileDataset(payloads, meta, opts);
}
