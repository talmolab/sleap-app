/**
 * Platform abstraction layer.
 *
 * Routes file I/O and platform-specific operations through Tauri APIs
 * when running in the desktop shell, or through browser APIs when
 * running standalone.
 */

export interface FileFilter {
  name: string;
  extensions: string[];
}

export interface PlatformAPI {
  /** Whether we're running inside Tauri desktop shell. */
  isTauri: boolean;
  /** Read a file and return its contents as a Uint8Array. */
  readFile(path: string): Promise<Uint8Array>;
  /** Write binary data to a file. */
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Show a file open dialog. Returns path(s)/File(s) or null if cancelled. */
  showOpenDialog(options?: {
    filters?: FileFilter[];
    multiple?: boolean;
    directory?: boolean;
    /**
     * Web only: when true, drop the File System Access picker's implicit
     * "All Files (*.*)" option so the user is confined to the declared
     * `filters` (e.g. project open → *.slp only). Ignored on Tauri, whose
     * native dialog already restricts to the filter extensions.
     */
    excludeAcceptAll?: boolean;
  }): Promise<string | string[] | File | File[] | null>;
  /** Show a file save dialog. Returns path or null if cancelled. */
  showSaveDialog(options?: {
    filters?: FileFilter[];
    defaultName?: string;
  }): Promise<string | null>;
  /** Check if a file exists at the given path. */
  exists(path: string): Promise<boolean>;
}

/** Detect if running inside Tauri. */
function detectTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)
  );
}

/** Create the browser-based platform implementation. */
/**
 * The FileSystemFileHandle(s) from the most recent browser File System Access
 * open, retained so a later re-save can re-read the source with a FRESH
 * `getFile()`. A plain `File` snapshot goes stale after focus changes (e.g. the
 * native Save dialog), elapsed time, or on network volumes — reading it then
 * throws "permission problems that have occurred after a reference to a file was
 * acquired". Reset at the start of every showOpenDialog call; empty for the
 * `<input>` fallback (which yields no handles).
 */
let _lastBrowserFileHandles: FileSystemFileHandle[] = [];
/**
 * Take (and clear) the handle from the most recent File System Access open.
 * Cleared on read so a later non-picker open (e.g. drag-drop, which sets no
 * handle) can't accidentally reuse a stale handle from a prior pick.
 */
export function consumeLastBrowserFileHandle(): FileSystemFileHandle | null {
  const h = _lastBrowserFileHandles[0] ?? null;
  _lastBrowserFileHandles = [];
  return h;
}

function createWebPlatform(): PlatformAPI {
  return {
    isTauri: false,

    async readFile(_path: string): Promise<Uint8Array> {
      throw new Error(
        "readFile by path is not supported in browser mode. Use File objects."
      );
    },

    async writeFile(_path: string, _data: Uint8Array): Promise<void> {
      throw new Error("writeFile by path is not supported in browser mode.");
    },

    async showOpenDialog(options): Promise<File | File[] | null> {
      const multi = options?.multiple ?? false;
      _lastBrowserFileHandles = []; // reset; filled below only on the FSA path

      // Try File System Access API first (Chrome/Edge)
      if ("showOpenFilePicker" in window) {
        console.log(`[platform] showOpenDialog (browser File System Access API, multiple=${multi})`);
        try {
          const types = options?.filters?.map((f) => ({
            description: f.name,
            accept: {
              "application/octet-stream": f.extensions.map((e) => `.${e}`),
            },
          }));
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const handles = await (window as any).showOpenFilePicker({
            types,
            multiple: multi,
            // Confine to the declared types (drop the implicit "All Files"
            // option) when the caller asks — e.g. project open → *.slp only.
            excludeAcceptAllOption: options?.excludeAcceptAll ?? false,
          });
          // Retain the handles so a later re-save can re-read the source fresh.
          _lastBrowserFileHandles = handles as FileSystemFileHandle[];
          const files: File[] = await Promise.all(
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            handles.map((h: any) => h.getFile() as Promise<File>)
          );
          if (files.length === 0) return null;
          return multi ? files : files[0];
        } catch {
          return null; // User cancelled
        }
      }

      // Fallback: use hidden input element
      console.log(`[platform] showOpenDialog (browser <input> fallback, multiple=${multi})`);
      return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        if (multi) input.multiple = true;
        if (options?.filters) {
          input.accept = options.filters
            .flatMap((f) => f.extensions.map((e) => `.${e}`))
            .join(",");
        }
        input.onchange = () => {
          const files = input.files ? Array.from(input.files) : [];
          if (files.length === 0) return resolve(null);
          resolve(multi ? files : files[0]);
        };
        input.oncancel = () => resolve(null);
        input.click();
      });
    },

    async showSaveDialog(_options): Promise<string | null> {
      // File System Access API
      if ("showSaveFilePicker" in window) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const handle = await (window as any).showSaveFilePicker({
            suggestedName: _options?.defaultName,
          });
          return handle.name;
        } catch {
          return null;
        }
      }
      // No save dialog in plain browser mode
      return null;
    },

    async exists(_path: string): Promise<boolean> {
      return false;
    },
  };
}

/** Create the Tauri-based platform implementation. */
async function createTauriPlatform(): Promise<PlatformAPI> {
  // Dynamic imports so these don't fail in browser mode
  const { readFile, writeFile, exists } = await import("@tauri-apps/plugin-fs");
  const { open, save } = await import("@tauri-apps/plugin-dialog");

  return {
    isTauri: true,

    async readFile(path: string): Promise<Uint8Array> {
      console.log(`[platform] readFile: ${path}`);
      return await readFile(path);
    },

    async writeFile(path: string, data: Uint8Array): Promise<void> {
      console.log(`[platform] writeFile: ${path} (${data.byteLength} bytes)`);
      await writeFile(path, data);
    },

    async showOpenDialog(options): Promise<string | string[] | null> {
      const multi = options?.multiple ?? false;
      const directory = options?.directory ?? false;
      console.log(
        `[platform] showOpenDialog (Tauri native, multiple=${multi}, directory=${directory})`
      );
      const selected = await open({
        multiple: multi,
        directory,
        // Tauri ignores filters in directory mode; omit them.
        filters: directory
          ? undefined
          : options?.filters?.map((f) => ({
              name: f.name,
              extensions: f.extensions,
            })),
      });
      if (multi) {
        if (Array.isArray(selected)) return selected.length > 0 ? selected : null;
        return selected ? [selected] : null;
      }
      if (Array.isArray(selected)) return selected[0] ?? null;
      return selected;
    },

    async showSaveDialog(options): Promise<string | null> {
      console.log(`[platform] showSaveDialog (Tauri native, default=${options?.defaultName})`);
      return await save({
        defaultPath: options?.defaultName,
        filters: options?.filters?.map((f) => ({
          name: f.name,
          extensions: f.extensions,
        })),
      });
    },

    async exists(path: string): Promise<boolean> {
      return await exists(path);
    },
  };
}

/** Singleton platform instance. */
let _platform: PlatformAPI | null = null;

/** Get the platform API (auto-detects Tauri vs browser). */
export async function getPlatform(): Promise<PlatformAPI> {
  if (_platform) return _platform;

  if (detectTauri()) {
    console.log("[platform] Detected Tauri desktop shell, using native file I/O");
    _platform = await createTauriPlatform();
  } else {
    const hasFileAccess = typeof window !== "undefined" && "showOpenFilePicker" in window;
    console.log(
      `[platform] Running in browser mode (File System Access API: ${hasFileAccess ? "available" : "unavailable"})`
    );
    _platform = createWebPlatform();
  }

  return _platform;
}

/** Synchronous check for Tauri. */
export const isTauri = detectTauri();
