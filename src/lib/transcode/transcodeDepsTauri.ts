/**
 * Real desktop implementation of {@link TranscodeDeps}: Tauri fs + the bundled
 * ffmpeg sidecar (via `@tauri-apps/plugin-shell`). All Tauri modules are
 * dynamically imported so this file never pulls native APIs into the browser
 * bundle. Kept separate from {@link file://./transcodeVideo.ts} so that module's
 * orchestration stays unit-testable with plain fakes.
 *
 * The ffmpeg binary is a Tauri `externalBin` sidecar (on a Linux .deb / .rpm a
 * private copy in /usr/lib/SLEAP — see ./ffmpegCommand.ts) — see
 * `src-tauri/binaries/README.md` for how the per-platform libopenh264 build is
 * fetched and named. It runs as a native child process (disk→disk); the source
 * bytes never touch the WebView heap.
 */

import { createProgressAssembler, type TranscodeDeps } from "./transcodeVideo.js";
import { ffmpegCommandSpec, type BundledTool } from "./ffmpegCommand.js";
/** Cache lives under the OS cache dir (disposable), not app-local data. */
const CACHE_ROOT = "video-cache";

/**
 * The Linux .deb / .rpm private tools dir, or null (sidecar everywhere else).
 * Asked once per session; any failure (older backend, browser) means sidecar.
 */
let privateToolsDir: Promise<string | null> | null = null;
function linuxPackageToolsDir(): Promise<string | null> {
  privateToolsDir ??= (async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const { sleapCmd } = await import("@/lib/sleapPlugin");
      return (await invoke<string | null>(sleapCmd("linux_package_tools_dir"))) ?? null;
    } catch {
      return null;
    }
  })();
  return privateToolsDir;
}

/** A shell `Command` for the bundled `tool` (sidecar, or the .deb/.rpm private copy). */
async function bundledToolCommand(tool: BundledTool, args: string[]) {
  const { Command } = await import("@tauri-apps/plugin-shell");
  const spec = ffmpegCommandSpec(tool, await linuxPackageToolsDir());
  return spec.kind === "scoped"
    ? Command.create(spec.name, args)
    : Command.sidecar(spec.name, args);
}

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

    async readDir(dir) {
      const { readDir } = await import("@tauri-apps/plugin-fs");
      try {
        const entries = await readDir(dir);
        return entries.filter((e) => e.isFile).map((e) => e.name);
      } catch {
        return []; // dir absent (no cache yet)
      }
    },

    async exec(tool, args) {
      const output = await (await bundledToolCommand(tool, args)).execute();
      return { stdout: output.stdout, stderr: output.stderr, code: output.code };
    },

    async runTranscode(args, onProgress, signal, onStderr) {
      const command = await bundledToolCommand("ffmpeg", args);

      // The plugin emits stdout line-by-line; assemble whole `-progress` blocks
      // before parsing so each update carries a complete {frame, outTimeMs}.
      const feed = createProgressAssembler(onProgress);
      command.stdout.on("data", (chunk: string) => feed(chunk));
      if (onStderr) {
        command.stderr.on("data", (line: string) => {
          if (line.trim()) onStderr(line.trim());
        });
      }

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
