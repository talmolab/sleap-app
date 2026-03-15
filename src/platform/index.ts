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

      // Try File System Access API first (Chrome/Edge)
      if ("showOpenFilePicker" in window) {
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
          });
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
      return await readFile(path);
    },

    async writeFile(path: string, data: Uint8Array): Promise<void> {
      await writeFile(path, data);
    },

    async showOpenDialog(options): Promise<string | string[] | null> {
      const multi = options?.multiple ?? false;
      const selected = await open({
        multiple: multi,
        filters: options?.filters?.map((f) => ({
          name: f.name,
          extensions: f.extensions,
        })),
      });
      if (multi) {
        // multiple: return string[] or null
        if (Array.isArray(selected)) return selected.length > 0 ? selected : null;
        return selected ? [selected] : null;
      }
      // single: return string or null
      if (Array.isArray(selected)) return selected[0] ?? null;
      return selected;
    },

    async showSaveDialog(options): Promise<string | null> {
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
    _platform = await createTauriPlatform();
  } else {
    _platform = createWebPlatform();
  }

  return _platform;
}

/** Synchronous check for Tauri. */
export const isTauri = detectTauri();
