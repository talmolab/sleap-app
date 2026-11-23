/**
 * Which command runs the bundled ffmpeg / ffprobe (#507): sidecars on macOS /
 * Windows; on Linux (every build) the scoped `$RESOURCE/<tool>` commands, since
 * Linux ships the tools as resources (the .deb/.rpm in /usr/lib/SLEAP, never
 * /usr/bin) and has no sidecars for the shell plugin to allow.
 */

import { describe, it, expect } from "../bun-test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ffmpegCommandSpec,
  BUNDLED_SCOPE,
  SIDECAR,
  type BundledTool,
} from "@/lib/transcode/ffmpegCommand";

const TOOLS: BundledTool[] = ["ffmpeg", "ffprobe"];
const readJson = (rel: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, "../../src-tauri", rel), "utf8"));

describe("ffmpegCommandSpec", () => {
  // macOS / Windows: the backend reports no Linux tools dir -> sidecars, as before.
  it("uses the sidecar when there is no Linux tools dir", () => {
    expect(ffmpegCommandSpec("ffmpeg", null)).toEqual({ kind: "sidecar", name: "binaries/ffmpeg" });
    expect(ffmpegCommandSpec("ffprobe", null)).toEqual({ kind: "sidecar", name: "binaries/ffprobe" });
  });

  // Linux — .deb/.rpm, AppImage and dev alike — always gets the scoped commands.
  it("uses the scoped resource commands on Linux", () => {
    for (const dir of ["/usr/lib/SLEAP", "/tmp/.mount_x/usr/lib/SLEAP", "/src/src-tauri/target/debug"]) {
      expect(ffmpegCommandSpec("ffmpeg", dir)).toEqual({ kind: "scoped", name: "bundled-ffmpeg" });
      expect(ffmpegCommandSpec("ffprobe", dir)).toEqual({ kind: "scoped", name: "bundled-ffprobe" });
    }
  });
});

describe("bundled-tool commands vs. the Tauri config", () => {
  // The shell plugin refuses a sidecar missing from the compiled externalBin, so
  // the sidecars used off Linux must be in the base config...
  it("base config declares the sidecars macOS / Windows use", () => {
    const base = readJson("tauri.conf.json");
    for (const tool of TOOLS) expect(base.bundle.externalBin).toContain(SIDECAR[tool]);
  });

  // ...and Linux must have none (they'd land in /usr/bin) but ship each tool as
  // a resource exactly where its `$RESOURCE/<tool>` scope entry points.
  it("Linux config ships the tools as resources, not sidecars", () => {
    const linux = readJson("tauri.linux.conf.json");
    expect(linux.bundle.externalBin).toEqual([]);
    for (const tool of TOOLS) {
      expect(linux.bundle.resources[`binaries/${tool}-x86_64-unknown-linux-gnu`]).toBe(tool);
    }
  });

  // A scope name with no matching capability entry is refused at spawn time.
  it("capabilities allow the scoped commands at $RESOURCE/<tool>", () => {
    const cap = readJson("capabilities/default.json") as {
      permissions: Array<string | { identifier: string; allow?: Array<Record<string, unknown>> }>;
    };
    for (const id of ["shell:allow-spawn", "shell:allow-execute"]) {
      const perm = cap.permissions.find((p) => typeof p === "object" && p.identifier === id);
      const allow = (perm as { allow: Array<Record<string, unknown>> }).allow;
      for (const tool of TOOLS) {
        const entry = allow.find((e) => e.name === BUNDLED_SCOPE[tool]);
        expect(entry?.cmd).toBe(`$RESOURCE/${tool}`);
      }
    }
  });
});
