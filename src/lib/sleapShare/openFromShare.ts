/**
 * SLEAP Share dataset resolution: private handoff ticket redemption, metadata +
 * member listing, and automatic companion-video attachment for multi-file
 * datasets opened in SLEAP App.
 */

import type { Labels, Video } from "@talmolab/sleap-io.js";
import { assignVideoBackendFromUrl } from "@/lib/resolveVideos";
import { detectSleapShareUrl } from "./config";

export interface ShareDatasetMember {
  memberIndex: number;
  role: string;
  filename: string;
  contentType: string;
  objectKey: string;
  fileSize: number;
  isPrimary: boolean;
  url: string;
  validationStatus?: string | null;
  labeledFramesCount?: number | null;
}

export interface ShareDatasetMembersResponse {
  shortcode: string;
  memberCount: number;
  kind: "single" | "multifile" | "labelsset" | string;
  members: ShareDatasetMember[];
}

export interface ShareDatasetMetadata {
  shortcode: string;
  originalFilename: string;
  name?: string;
  fileSize: number;
  uploadedAt: number;
  expiresAt: number | null;
  isPrivate?: boolean;
  validationStatus: string;
  metadata?: {
    labeledFramesCount: number;
    userInstancesCount: number;
    predictedInstancesCount: number;
    tracksCount: number;
    videosCount: number;
    hasEmbeddedImages: boolean;
    formatVersion: string;
  };
}

/**
 * Exchange a single-use private handoff ticket (`ds_tkt_*`) for a read-only,
 * single-dataset bearer token (`slp_ds_*`). Held strictly in memory.
 */
export async function redeemHandoffTicket(
  origin: string,
  shortcode: string,
  ticket: string,
  fetchImpl: typeof fetch = fetch
): Promise<{ token: string; expiresAt: number }> {
  const base = origin.replace(/\/+$/, "");
  const res = await fetchImpl(
    `${base}/api/datasets/${encodeURIComponent(shortcode)}/handoff/redeem`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket }),
    }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(
      body?.error ||
        `Private handoff link expired or already used (${res.status}). Re-open it from SLEAP Share or sign in.`
    );
  }
  const data = (await res.json()) as { token: string; expiresAt: number };
  if (!data?.token) {
    throw new Error("Invalid handoff redemption response from SLEAP Share.");
  }
  return data;
}

/** Fetch public (or authenticated) dataset metadata from `/api/metadata/{sc}`. */
export async function fetchShareMetadata(
  origin: string,
  shortcode: string,
  token?: string,
  fetchImpl: typeof fetch = fetch
): Promise<ShareDatasetMetadata | null> {
  const base = origin.replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetchImpl(
      `${base}/api/metadata/${encodeURIComponent(shortcode)}`,
      { method: "GET", headers }
    );
    if (!res.ok) return null;
    return (await res.json()) as ShareDatasetMetadata;
  } catch {
    return null;
  }
}

/** Fetch dataset member list from `/api/datasets/{sc}/members`. */
export async function fetchShareMembers(
  origin: string,
  shortcode: string,
  token?: string,
  fetchImpl: typeof fetch = fetch
): Promise<ShareDatasetMembersResponse | null> {
  const base = origin.replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetchImpl(
      `${base}/api/datasets/${encodeURIComponent(shortcode)}/members`,
      { method: "GET", headers }
    );
    if (!res.ok) return null;
    return (await res.json()) as ShareDatasetMembersResponse;
  } catch {
    return null;
  }
}

function fileBasenameLower(path: string | string[] | undefined): string {
  const s = Array.isArray(path) ? (path[0] ?? "") : (path ?? "");
  return s.split(/[\\/]/).pop()?.split("?")[0]?.toLowerCase() ?? "";
}

/**
 * Match a dead external `Video` against uploaded companion video members.
 * Mirrors `sleap-share`'s `player.js` `matchCompanion` heuristic so both viewers
 * resolve the exact same video.
 */
export function matchCompanionVideoMember(
  video: Pick<Video, "filename">,
  videoMembers: readonly ShareDatasetMember[],
  deadCount: number,
  slpUrl: string
): ShareDatasetMember | null {
  if (videoMembers.length === 0) return null;
  if (deadCount === 1 && videoMembers.length === 1) return videoMembers[0];

  const vidBase = fileBasenameLower(video.filename);
  const slpKey = fileBasenameLower(slpUrl)
    .replace(/\.(pkg\.slp|slp|pkg)$/i, "")
    .replace(/\.(inference|cleaned|proofread|predictions|analysis)/gi, "");

  for (const m of videoMembers) {
    const mBase = fileBasenameLower(m.filename || m.url);
    const mStem = mBase.replace(/\.[^.]+$/, "");
    if (mBase && mBase === vidBase) return m;
    if (mStem && slpKey && (slpKey.includes(mStem) || mStem.includes(slpKey))) {
      return m;
    }
  }
  return videoMembers.length === 1 ? videoMembers[0] : null;
}

/**
 * For a multi-file SLEAP Share dataset whose `.slp` references external video(s),
 * attach streaming HTTP Range backends from any companion video members hosted
 * under the same shortcode.
 */
export async function resolveShareCompanionVideos(
  labels: Labels,
  slpUrl: string,
  members: readonly ShareDatasetMember[],
  headers?: Record<string, string>
): Promise<number> {
  const deadVideos = labels.videos.filter(
    (v) => v && !v.hasEmbeddedImages && !v.backend
  );
  if (deadVideos.length === 0) return 0;

  const videoMembers = members.filter(
    (m) =>
      !m.isPrimary &&
      (/^video\//i.test(m.contentType || "") ||
        /\.(mp4|mov|avi|mkv|webm|m4v|ogg|ogv|ts)$/i.test(
          m.filename || m.url || ""
        ))
  );
  if (videoMembers.length === 0) return 0;

  let resolvedCount = 0;
  for (const video of deadVideos) {
    const matched = matchCompanionVideoMember(
      video,
      videoMembers,
      deadVideos.length,
      slpUrl
    );
    if (!matched) continue;
    const memberUrl = new URL(matched.url, slpUrl).href;
    const ok = await assignVideoBackendFromUrl(video, memberUrl, {
      silent: true,
      headers,
    });
    if (ok) resolvedCount++;
  }
  return resolvedCount;
}

/**
 * Extract the origin + shortcode for a SLEAP Share URL if recognized.
 */
export { detectSleapShareUrl };
