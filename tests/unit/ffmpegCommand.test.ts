/**
 * Which command runs the bundled ffmpeg / ffprobe (#507): the sidecar
 * everywhere, except a Linux .deb / .rpm install, whose private copy lives in
 * /usr/lib/SLEAP so the system's own /usr/bin/ffmpeg is never touched.
 */

import { describe, it, expect } from "../bun-test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ffmpegCommandSpec, LINUX_PKG_SCOPE } from "@/lib/transcode/ffmpegCommand";

describe("ffmpegCommandSpec", () => {
  // macOS, Windows, the AppImage and dev builds: unchanged sidecar behavior.
  it("uses the sidecar when there is no private tools dir", () => {
    expect(ffmpegCommandSpec("ffmpeg", null)).toEqual({ kind: "sidecar", name: "binaries/ffmpeg" });
    expect(ffmpegCommandSpec("ffprobe", null)).toEqual({ kind: "sidecar", name: "binaries/ffprobe" });
  });

  // A .deb/.rpm install: a sidecar lookup would find /usr/bin/ffmpeg (the
  // system's), so the scoped absolute-path command must be used instead.
  it("uses the scoped private command on a Linux package install", () => {
    expect(ffmpegCommandSpec("ffmpeg", "/usr/lib/SLEAP")).toEqual({
      kind: "scoped",
      name: "linux-pkg-ffmpeg",
    });
    expect(ffmpegCommandSpec("ffprobe", "/usr/lib/SLEAP")).toEqual({
      kind: "scoped",
      name: "linux-pkg-ffprobe",
    });
  });

  // The scope names the frontend uses must exist in the capability file and
  // point at the package's private copies; otherwise the spawn is refused.
  it("matches the shell scope entries in capabilities/default.json", () => {
    const cap = JSON.parse(
      readFileSync(join(import.meta.dir, "../../src-tauri/capabilities/default.json"), "utf8")
    ) as { permissions: Array<string | { identifier: string; allow?: Array<Record<string, unknown>> }> };
    for (const id of ["shell:allow-spawn", "shell:allow-execute"]) {
      const perm = cap.permissions.find((p) => typeof p === "object" && p.identifier === id);
      expect(perm).toBeDefined();
      const allow = (perm as { allow: Array<Record<string, unknown>> }).allow;
      for (const tool of ["ffmpeg", "ffprobe"] as const) {
        const entry = allow.find((e) => e.name === LINUX_PKG_SCOPE[tool]);
        expect(entry?.cmd).toBe(`/usr/lib/SLEAP/${tool}`);
      }
    }
  });
});
