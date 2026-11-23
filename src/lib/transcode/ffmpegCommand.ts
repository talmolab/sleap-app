/**
 * Which shell command runs the bundled ffmpeg / ffprobe (#507).
 *
 * Everywhere except a Linux .deb / .rpm install they are Tauri sidecars that sit
 * next to the app binary (`Command.sidecar("binaries/ffmpeg")`). The .deb / .rpm
 * instead install them off PATH in `/usr/lib/SLEAP/` so they never clash with
 * the system's own `/usr/bin/ffmpeg` — and a sidecar lookup there would find
 * that system ffmpeg, not ours. On those installs the Rust side reports the
 * private dir and we spawn the scoped absolute-path commands instead (scope
 * entries `linux-pkg-*` in `src-tauri/capabilities/default.json` and the
 * runtime localhost capability in `src-tauri/src/lib.rs`).
 */

export type BundledTool = "ffmpeg" | "ffprobe";

/** How to create the command: a sidecar, or a named scope entry (absolute path). */
export type FfmpegCommandSpec =
  | { kind: "sidecar"; name: string }
  | { kind: "scoped"; name: string };

/** Tauri `externalBin` base names (resolve to `binaries/<name>-<target-triple>`). */
const SIDECAR: Record<BundledTool, string> = {
  ffmpeg: "binaries/ffmpeg",
  ffprobe: "binaries/ffprobe",
};

/** Shell-scope names for the Linux package's private copies (`/usr/lib/SLEAP/<tool>`). */
export const LINUX_PKG_SCOPE: Record<BundledTool, string> = {
  ffmpeg: "linux-pkg-ffmpeg",
  ffprobe: "linux-pkg-ffprobe",
};

/**
 * Pick the command for `tool`. `privateToolsDir` is what the Rust
 * `linux_package_tools_dir` command returned: non-null only on a Linux .deb /
 * .rpm install whose private ffmpeg is present.
 */
export function ffmpegCommandSpec(
  tool: BundledTool,
  privateToolsDir: string | null
): FfmpegCommandSpec {
  return privateToolsDir
    ? { kind: "scoped", name: LINUX_PKG_SCOPE[tool] }
    : { kind: "sidecar", name: SIDECAR[tool] };
}
