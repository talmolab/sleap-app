/**
 * Decide whether building a local scrub proxy is worth it for a given video.
 *
 * A scrub proxy is a same-resolution, short-GOP LOCAL H.264 copy built once so
 * scrubbing a video that lives on a slow network mount is fast. It only pays off
 * on desktop (Tauri) for an already-decodable external file that's actually on a
 * network path and large enough that the copy earns back its cost. This gate is
 * pure so the decision is unit-testable without any I/O.
 */

import { isNetworkPath } from "./networkPath.js";

/** Default floor: skip the proxy for anything under 50 MB (copy not worth it). */
const DEFAULT_MIN_BYTES = 50 * 1024 * 1024;

export interface ScrubProxyPolicyInput {
  /** User/feature toggle for scrub proxies. */
  enabled: boolean;
  /** True only in the desktop (Tauri) runtime, where the ffmpeg sidecar exists. */
  isTauri: boolean;
  /** Absolute source path of the video. */
  path: string;
  /** Source file size in bytes. */
  sizeBytes: number;
  /**
   * True when the source is an external, already-decodable video file (not an
   * embedded/imagevideo source and not a legacy codec needing a full transcode).
   */
  isExternalDecodableVideo: boolean;
  /** Minimum source size to bother proxying. Default 50 MB. */
  minBytes?: number;
}

export function shouldBuildScrubProxy(input: ScrubProxyPolicyInput): boolean {
  const minBytes = input.minBytes ?? DEFAULT_MIN_BYTES;
  return (
    input.enabled &&
    input.isTauri &&
    input.isExternalDecodableVideo &&
    isNetworkPath(input.path) &&
    input.sizeBytes >= minBytes
  );
}
