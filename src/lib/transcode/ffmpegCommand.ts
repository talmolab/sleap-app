/**
 * Which shell command runs the bundled ffmpeg / ffprobe (#507).
 *
 * macOS / Windows: Tauri sidecars next to the app binary
 * (`Command.sidecar("binaries/ffmpeg")`).
 *
 * Linux (every build: .deb, .rpm, AppImage, `tauri dev`): no sidecars at all.
 * `src-tauri/tauri.linux.conf.json` empties `externalBin` — otherwise the
 * .deb/.rpm would install ffmpeg into /usr/bin, clashing with the system's —
 * and ships the tools as resources instead (`/usr/lib/SLEAP/` for .deb/.rpm).
 * With `externalBin` empty the shell plugin refuses every sidecar request, so
 * on Linux we must use the scoped `bundled-*` commands, whose `cmd` is
 * `$RESOURCE/<tool>` (capabilities/default.json + the runtime localhost
 * capability in src-tauri/src/lib.rs).
 */

export type BundledTool = "ffmpeg" | "ffprobe";

/** How to create the command: a sidecar, or a named scope entry (`$RESOURCE/<tool>`). */
export type FfmpegCommandSpec =
  | { kind: "sidecar"; name: string }
  | { kind: "scoped"; name: string };

/** Tauri `externalBin` base names (resolve to `binaries/<name>-<target-triple>`). */
export const SIDECAR: Record<BundledTool, string> = {
  ffmpeg: "binaries/ffmpeg",
  ffprobe: "binaries/ffprobe",
};

/** Shell-scope names for the Linux resource copies (`$RESOURCE/<tool>`). */
export const BUNDLED_SCOPE: Record<BundledTool, string> = {
  ffmpeg: "bundled-ffmpeg",
  ffprobe: "bundled-ffprobe",
};

/**
 * Pick the command for `tool`. `linuxToolsDir` is what the Rust
 * `linux_tools_dir` command returned: the resource dir on Linux, null on
 * macOS / Windows.
 */
export function ffmpegCommandSpec(
  tool: BundledTool,
  linuxToolsDir: string | null
): FfmpegCommandSpec {
  return linuxToolsDir
    ? { kind: "scoped", name: BUNDLED_SCOPE[tool] }
    : { kind: "sidecar", name: SIDECAR[tool] };
}
