/**
 * Register a desktop (Tauri) {@link FsResolver} so sleap-io.js resolves external
 * and `ImageVideo` source paths itself during load (issue #213 / sleap-io.js#216).
 *
 * A `.slp` stores video sources by the ABSOLUTE path they had on the machine that
 * wrote them. Reopened elsewhere — a different OS, or media moved into a subfolder
 * beside the `.slp` — those paths no longer resolve. With an `FsResolver`
 * registered via `setFsResolver`, the eager SLP reader resolves each stored source
 * against the labels-file directory using one shared policy (verbatim →
 * relative-to-labels-dir → common-suffix anchor → progressively shorter
 * trailing-tail grafts, UNC-aware). For an `ImageVideo` it probes only the first
 * frame and applies the winning prefix-swap to the whole list. When the first
 * frame is confirmed unreachable it WITHHOLDS the backend (`backend === null`,
 * `backendError.kind === "image-sequence"`) instead of handing back a blank-
 * rendering one — the signal the Videos panel uses to offer "Locate image folder…".
 *
 * Only `exists` is exercised by the load-time candidate probing. `sameFile` /
 * `realpath` back sleap-io.js's label-merge Matchers phase, which this app does
 * not drive; they degrade conservatively (callers wrap them in try/catch), which
 * lands on the same "cannot verify / no positive match" path as the browser
 * (no-FS) build.
 *
 * Candidate paths are forward-slash normalized. On Windows the Tauri `fs` plugin
 * and the native image reader go through Rust `std::fs`, which accepts `/` as a
 * path separator, so the normalized candidates resolve without back-conversion.
 */

import { setFsResolver, type FsResolver } from "@talmolab/sleap-io.js";

/**
 * Build (but do not register) an {@link FsResolver} backed by a Tauri `exists`
 * probe. `sameFile`/`realpath` degrade conservatively — see the module comment.
 * Exposed separately from {@link installTauriFsResolver} so it can be unit-tested
 * without the module-global registration (`getFsResolver` isn't re-exported).
 */
export function buildTauriFsResolver(
  exists: (path: string) => Promise<boolean>
): FsResolver {
  return {
    exists,
    sameFile: async () => false,
    realpath: async (path: string) => path,
  };
}

/**
 * Install a global {@link FsResolver} backed by a Tauri `exists` probe. Call once
 * before `loadSlp` / `readSlpStreaming` on desktop (where filesystem access is
 * available); the browser build leaves the resolver unset and degrades to the
 * stored paths verbatim.
 */
export function installTauriFsResolver(
  exists: (path: string) => Promise<boolean>
): void {
  setFsResolver(buildTauriFsResolver(exists));
}
