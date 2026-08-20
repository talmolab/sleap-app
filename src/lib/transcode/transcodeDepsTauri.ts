/**
 * Real desktop implementation of {@link TranscodeDeps}: Tauri fs + the bundled
 * ffmpeg sidecar (via `@tauri-apps/plugin-shell`). All Tauri modules are
 * dynamically imported so this file never pulls native APIs into the browser
 * bundle. Kept separate from {@link file://./transcodeVideo.ts} so that module's
 * orchestration stays unit-testable with plain fakes.
 *
 * The ffmpeg binary is a Tauri `externalBin` sidecar — see
 * `src-tauri/binaries/README.md` for how the per-platform libopenh264 build is
 * fetched and named. It runs as a native child process (disk→disk); the source
 * bytes never touch the WebView heap.
 */

import { parseFfmpegProgress, type TranscodeDeps } from "./transcodeVideo.js";

/** Tauri `externalBin` base names (resolve to `binaries/<name>-<target-triple>`). */
const FFMPEG_SIDECAR = "binaries/ffmpeg";
const FFPROBE_SIDECAR = "binaries/ffprobe";
/** Cache lives under the OS cache dir (disposable), not app-local data. */
const CACHE_ROOT = "video-cache";

/** Build the production desktop {@link TranscodeDeps}. Tauri-only. */
export function createTauriTranscodeDeps(): TranscodeDeps {
  return {
    async cacheDir() {
      const { appCacheDir, join } = await import("@tauri-apps/api/path");
      return join(await appCacheDir(), CACHE_ROOT);
    },

    async join(...parts) {
      const { join } = await import("@tauri-apps/api/path");
      return join(...parts);
    },

    async stat(path) {
      const { stat } = await import("@tauri-apps/plugin-fs");
      const info = await stat(path);
      return {
        size: info.size,
        // plugin-fs returns mtime as a Date | null; fall back to 0 (still stable
        // for a given unchanged file within a session).
        mtimeMs: info.mtime ? info.mtime.getTime() : 0,
      };
    },

    async exists(path) {
      const { exists } = await import("@tauri-apps/plugin-fs");
      return exists(path);
    },

    async mkdir(path) {
      const { mkdir } = await import("@tauri-apps/plugin-fs");
      await mkdir(path, { recursive: true });
    },

    async rename(from, to) {
      const { rename } = await import("@tauri-apps/plugin-fs");
      await rename(from, to);
    },

    async remove(path) {
      const { remove } = await import("@tauri-apps/plugin-fs");
      try {
        await remove(path);
      } catch {
        /* not present — fine */
      }
    },

    async exec(tool, args) {
      const { Command } = await import("@tauri-apps/plugin-shell");
      const sidecar = tool === "ffprobe" ? FFPROBE_SIDECAR : FFMPEG_SIDECAR;
      const output = await Command.sidecar(sidecar, args).execute();
      return { stdout: output.stdout, stderr: output.stderr, code: output.code };
    },

    async runTranscode(args, onProgress, signal) {
      const { Command } = await import("@tauri-apps/plugin-shell");
      const command = Command.sidecar(FFMPEG_SIDECAR, args);

      command.stdout.on("data", (line: string) => {
        for (const p of parseFfmpegProgress(line)) onProgress(p);
      });

      const child = await command.spawn();
      const onAbort = () => {
        void child.kill();
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      try {
        await new Promise<void>((resolve, reject) => {
          command.on("close", (data: { code: number | null }) => {
            if (signal?.aborted) reject(new Error("Transcode cancelled"));
            else if (data.code === 0) resolve();
            else reject(new Error(`ffmpeg exited with code ${data.code}`));
          });
          command.on("error", (err: string) =>
            reject(new Error(`ffmpeg failed to run: ${err}`))
          );
        });
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
