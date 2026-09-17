/**
 * Environment state store.
 *
 * Manages uv/Python detection results, selected interpreter,
 * and install operations. Persists selected Python path to localStorage.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  detectUv,
  detectGpu,
  detectAccelerator as detectAcceleratorCmd,
  detectSleapNnExtras,
  listUvTools,
  listPythonInterpreters,
  listDownloadablePythons,
  checkPython,
  installPython as installPythonCmd,
  installUvTool as installUvToolCmd,
  upgradeUvTool as upgradeUvToolCmd,
  updateUv as updateUvCmd,
  installUv as installUvCmd,
  type AcceleratorInfo,
  type SleapNnExtras,
  type UvInfo,
  type UvTool,
  type PythonInterpreter,
  type PythonInfo,
  type ProcessEvent,
} from "../platform/backend";
import { isTauri } from "../platform/index";
import { toast } from "@/lib/notify";
import { openExternal } from "@/lib/openExternal";

const SLEAP_NN_RELEASES_URL = "https://github.com/talmolab/sleap-nn/releases/tag";

// De-dupes concurrent callers of checkSleapNnUpdateAndNotify (e.g. App.tsx's
// startup check racing loadProject.ts's post-load check for a project opened
// via a CLI arg or file-association launch): without this, both calls await
// listUvTools() before either has written lastNotifiedSleapNnVersion, so both
// read the stale guard value and both fire the "update available" toast.
let sleapNnCheckInFlight: Promise<void> | null = null;

export type DetectionStatus = "idle" | "checking" | "done" | "error";
export type InstallStatus = "idle" | "installing" | "done" | "error";

export interface EnvironmentState {
  // Detection results (re-detected on launch)
  uv: UvInfo | null;
  tools: UvTool[];
  interpreters: PythonInterpreter[];
  downloadable: PythonInterpreter[];

  // Which accelerator the INSTALLED sleap-nn can actually use, straight from
  // the torch in its own venv. Never persisted: it describes the machine + the
  // current install, both of which can change between sessions (new driver,
  // reinstall with a different torch extra). `null` until probed, or while
  // sleap-nn isn't installed at all.
  accelerator: AcceleratorInfo | null;
  acceleratorStatus: DetectionStatus;

  // Which optional extras the installed sleap-nn carries (ONNX / TensorRT
  // export support). Not persisted, for the same reason as `accelerator`: it
  // describes the current install, which a reinstall can change.
  extras: SleapNnExtras | null;
  extrasStatus: DetectionStatus;

  // Selected environment (persisted)
  selectedPythonPath: string | null;
  pythonCheck: PythonInfo | null;

  // Last sleap-nn version we already showed an "update available" toast for
  // (persisted, so we don't nag on every project open — only on new
  // versions). sleap-app's own version has no equivalent toast anymore —
  // see the Environment badge (appStore's stableUpdateAvailable) instead.
  lastNotifiedSleapNnVersion: string | null;

  // Status
  detectionStatus: DetectionStatus;
  detectionError: string | null;

  // Install progress
  installStatus: InstallStatus;
  installLog: string[];
  installTarget: string | null;

  // Actions
  refresh: () => Promise<void>;
  detectAccelerator: () => Promise<void>;
  detectExtras: () => Promise<void>;
  selectPython: (path: string) => Promise<void>;
  clearSelection: () => void;
  doInstallPython: (version: string) => Promise<void>;
  doInstallTool: (pkg: string) => Promise<void>;
  /**
   * (Re)install sleap-nn WITH the ONNX/TensorRT export extras so exported-model
   * export + `--runtime onnx|tensorrt` inference work. `uv tool install` REPLACES
   * the tool env, so this reinstalls the FULL extra set (torch + export[,tensorrt]).
   */
  installExportExtra: (withTensorrt: boolean) => Promise<void>;
  /**
   * Reinstall sleap-nn so its extras match `want` exactly. Because
   * `uv tool install` REPLACES the tool env, this is the only way to change
   * extras — and it means UNCHECKING one removes it on the next apply.
   */
  installExtras: (want: { onnx: boolean; tensorrt: boolean }) => Promise<void>;
  doUpgradeTool: (pkg: string) => Promise<void>;
  doReinstallTool: (pkg: string) => Promise<void>;
  doUpdateUv: () => Promise<void>;
  doInstallUv: () => Promise<void>;
  clearInstallLog: () => void;
  checkSleapNnUpdateAndNotify: () => Promise<void>;
}

/** Keys persisted to localStorage. */
const PERSISTED_KEYS: (keyof EnvironmentState)[] = [
  "selectedPythonPath",
  "lastNotifiedSleapNnVersion",
];

export const useEnvironmentStore = create<EnvironmentState>()(
  persist(
    (set, get) => ({
      // Detection results
      uv: null,
      tools: [],
      interpreters: [],
      downloadable: [],
      accelerator: null,
      acceleratorStatus: "idle",
      extras: null,
      extrasStatus: "idle",

      // Selected environment
      selectedPythonPath: null,
      pythonCheck: null,
      lastNotifiedSleapNnVersion: null,

      // Status
      detectionStatus: "idle",
      detectionError: null,

      // Install
      installStatus: "idle",
      installLog: [],
      installTarget: null,

      // Actions

      refresh: async () => {
        set({ detectionStatus: "checking", detectionError: null });
        console.log("[env] Starting environment detection...");

        try {
          const uvInfo = await detectUv();
          console.log("[env] uv:", uvInfo);
          set({ uv: uvInfo });

          if (!uvInfo.available) {
            set({
              tools: [],
              interpreters: [],
              downloadable: [],
              accelerator: null,
              acceleratorStatus: "idle",
              extras: null,
              extrasStatus: "idle",
              detectionStatus: "done",
            });
            return;
          }

          // Run discovery in parallel
          const [uvTools, pythons, downloadablePythons] = await Promise.all([
            listUvTools(),
            listPythonInterpreters(),
            listDownloadablePythons(),
          ]);
          console.log("[env] tools:", uvTools);
          console.log("[env] interpreters:", pythons);
          console.log("[env] downloadable:", downloadablePythons);

          set({
            tools: uvTools,
            interpreters: pythons,
            downloadable: downloadablePythons,
          });

          // Not awaited: the probe has to import torch in sleap-nn's venv,
          // which takes seconds, and nothing else in the panel depends on it.
          // Only meaningful once sleap-nn exists — the probe runs ITS python.
          if (uvTools.some((t) => t.name === "sleap-nn")) {
            void get().detectAccelerator();
            void get().detectExtras();
          } else {
            set({
              accelerator: null,
              acceleratorStatus: "idle",
              extras: null,
              extrasStatus: "idle",
            });
          }

          // Verify selected Python still exists
          const { selectedPythonPath } = get();
          if (selectedPythonPath) {
            const stillExists = pythons.some(
              (p) => p.path === selectedPythonPath
            );
            if (stillExists) {
              const check = await checkPython(selectedPythonPath);
              console.log("[env] selected Python check:", check);
              set({ pythonCheck: check });
            } else {
              console.log(
                "[env] Previously selected Python no longer available:",
                selectedPythonPath
              );
              set({ selectedPythonPath: null, pythonCheck: null });
            }
          }

          set({ detectionStatus: "done" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[env] Detection failed:", err);
          set({ detectionStatus: "error", detectionError: msg });
        }
      },

      detectAccelerator: async () => {
        set({ acceleratorStatus: "checking" });
        try {
          const info = await detectAcceleratorCmd();
          console.log("[env] accelerator:", info);
          set({ accelerator: info, acceleratorStatus: "done" });
        } catch (err) {
          // detect_accelerator reports its own failures in `error` rather than
          // rejecting, so getting here means the IPC call itself failed.
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[env] Accelerator detection failed:", err);
          set({
            accelerator: {
              accelerator: null,
              gpuCount: 0,
              gpus: [],
              torchVersion: null,
              cudaVersion: null,
              driverVersion: null,
              driverCompatible: null,
              driverMinRequired: null,
              os: "",
              error: msg,
            },
            acceleratorStatus: "done",
          });
        }
      },

      detectExtras: async () => {
        set({ extrasStatus: "checking" });
        try {
          const info = await detectSleapNnExtras();
          console.log("[env] extras:", info);
          set({ extras: info, extrasStatus: "done" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error("[env] Extras detection failed:", err);
          set({
            extras: {
              onnx: false,
              tensorrt: false,
              tensorrtSupported: false,
              error: msg,
            },
            extrasStatus: "done",
          });
        }
      },

      selectPython: async (path: string) => {
        set({ selectedPythonPath: path, pythonCheck: null });
        console.log("[env] Selecting Python:", path);
        try {
          const check = await checkPython(path);
          console.log("[env] Python check:", check);
          set({ pythonCheck: check });
        } catch (err) {
          console.error("[env] Failed to check Python:", err);
        }
      },

      clearSelection: () => {
        set({ selectedPythonPath: null, pythonCheck: null });
      },

      doInstallPython: async (version: string) => {
        set({
          installStatus: "installing",
          installTarget: `Python ${version}`,
          installLog: [],
        });

        const onEvent = (event: ProcessEvent) => {
          if (event.event === "stdout" || event.event === "stderr") {
            set((state) => ({
              installLog: [...state.installLog, event.data.line],
            }));
          } else if (event.event === "finished") {
            set({
              installStatus: event.data.success ? "done" : "error",
            });
          }
        };

        try {
          await installPythonCmd(version, onEvent);
          // Refresh to pick up newly installed interpreter
          await get().refresh();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          set((state) => ({
            installStatus: "error",
            installLog: [...state.installLog, `Error: ${msg}`],
          }));
        }
      },

      doInstallTool: async (pkg: string) => {
        const { selectedPythonPath } = get();
        set({
          installStatus: "installing",
          installTarget: pkg,
          installLog: [],
        });

        const onEvent = (event: ProcessEvent) => {
          if (event.event === "stdout" || event.event === "stderr") {
            set((state) => ({
              installLog: [...state.installLog, event.data.line],
            }));
          } else if (event.event === "finished") {
            set({
              installStatus: event.data.success ? "done" : "error",
            });
          }
        };

        try {
          let installPkg = pkg;
          let extraArgs: string[] | undefined;

          // For sleap-nn, detect GPU and install with appropriate torch extra
          if (pkg === "sleap-nn") {
            const gpu = await detectGpu();
            console.log("[env] Detected GPU type:", gpu);
            const torchExtra = gpu === "cuda" ? "torch-cuda130" : "torch-cpu";
            installPkg = `sleap-nn[${torchExtra}]`;
            extraArgs = ["--torch-backend=auto"];
            set((state) => ({
              installLog: [
                ...state.installLog,
                `[env] GPU: ${gpu} → installing ${installPkg}`,
              ],
            }));
          }

          await installUvToolCmd(
            installPkg,
            selectedPythonPath,
            false,
            onEvent,
            extraArgs
          );
          await get().refresh();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          set((state) => ({
            installStatus: "error",
            installLog: [...state.installLog, `Error: ${msg}`],
          }));
        }
      },

      installExportExtra: async (withTensorrt: boolean) => {
        // Kept as the name the export dialog + post-training export path call;
        // "export support" has always meant ONNX, plus TensorRT on request.
        await get().installExtras({ onnx: true, tensorrt: withTensorrt });
      },

      installExtras: async ({ onnx, tensorrt }) => {
        const { selectedPythonPath } = get();
        // TensorRT export is built on top of the ONNX toolchain, so `tensorrt`
        // always brings `export` with it — selecting TensorRT alone would
        // produce an env that can't export at all.
        const wantOnnx = onnx || tensorrt;
        const extras = [
          wantOnnx ? "export" : null,
          tensorrt ? "tensorrt" : null,
        ].filter(Boolean);
        set({
          installStatus: "installing",
          installTarget: tensorrt
            ? "sleap-nn ONNX + TensorRT support"
            : wantOnnx
              ? "sleap-nn ONNX support"
              : "sleap-nn without export extras",
          installLog: [],
        });

        const onEvent = (event: ProcessEvent) => {
          if (event.event === "stdout" || event.event === "stderr") {
            set((state) => ({
              installLog: [...state.installLog, event.data.line],
            }));
          } else if (event.event === "finished") {
            set({ installStatus: event.data.success ? "done" : "error" });
          }
        };

        try {
          const gpu = await detectGpu();
          const torchExtra = gpu === "cuda" ? "torch-cuda130" : "torch-cpu";
          // `uv tool install` REPLACES the tool env — it can't add or drop an
          // extra incrementally — so every apply names the FULL extra set and
          // forces a reinstall. That's also what makes unchecking work: the
          // omitted extra simply isn't in the new env. The torch backend has
          // to be restated for the same reason, or it would be dropped.
          const installPkg = `sleap-nn[${[torchExtra, ...extras].join(",")}]`;
          set((state) => ({
            installLog: [
              ...state.installLog,
              `[env] GPU: ${gpu} → installing ${installPkg}`,
            ],
          }));
          await installUvToolCmd(
            installPkg,
            selectedPythonPath,
            true,
            onEvent,
            ["--torch-backend=auto"]
          );
          await get().refresh();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          set((state) => ({
            installStatus: "error",
            installLog: [...state.installLog, `Error: ${msg}`],
          }));
        }
      },

      doUpgradeTool: async (pkg: string) => {
        set({
          installStatus: "installing",
          installTarget: `${pkg} (upgrade)`,
          installLog: [],
        });

        const onEvent = (event: ProcessEvent) => {
          if (event.event === "stdout" || event.event === "stderr") {
            set((state) => ({
              installLog: [...state.installLog, event.data.line],
            }));
          } else if (event.event === "finished") {
            set({
              installStatus: event.data.success ? "done" : "error",
            });
          }
        };

        try {
          await upgradeUvToolCmd(pkg, onEvent);
          await get().refresh();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          set((state) => ({
            installStatus: "error",
            installLog: [...state.installLog, `Error: ${msg}`],
          }));
        }
      },

      doReinstallTool: async (pkg: string) => {
        const { selectedPythonPath } = get();
        set({
          installStatus: "installing",
          installTarget: `${pkg} (reinstall)`,
          installLog: [],
        });

        const onEvent = (event: ProcessEvent) => {
          if (event.event === "stdout" || event.event === "stderr") {
            set((state) => ({
              installLog: [...state.installLog, event.data.line],
            }));
          } else if (event.event === "finished") {
            set({
              installStatus: event.data.success ? "done" : "error",
            });
          }
        };

        try {
          let installPkg = pkg;
          let extraArgs: string[] | undefined;

          if (pkg === "sleap-nn") {
            const gpu = await detectGpu();
            const torchExtra = gpu === "cuda" ? "torch-cuda130" : "torch-cpu";
            installPkg = `sleap-nn[${torchExtra}]`;
            extraArgs = ["--torch-backend=auto"];
            set((state) => ({
              installLog: [
                ...state.installLog,
                `[env] GPU: ${gpu} → reinstalling ${installPkg}`,
              ],
            }));
          }

          await installUvToolCmd(
            installPkg,
            selectedPythonPath,
            true,
            onEvent,
            extraArgs
          );
          await get().refresh();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          set((state) => ({
            installStatus: "error",
            installLog: [...state.installLog, `Error: ${msg}`],
          }));
        }
      },

      doUpdateUv: async () => {
        set({
          installStatus: "installing",
          installTarget: "uv (update)",
          installLog: [],
        });

        const onEvent = (event: ProcessEvent) => {
          if (event.event === "stdout" || event.event === "stderr") {
            set((state) => ({
              installLog: [...state.installLog, event.data.line],
            }));
          } else if (event.event === "finished") {
            set({
              installStatus: event.data.success ? "done" : "error",
            });
          }
        };

        try {
          await updateUvCmd(onEvent);
          await get().refresh();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          set((state) => ({
            installStatus: "error",
            installLog: [...state.installLog, `Error: ${msg}`],
          }));
        }
      },

      doInstallUv: async () => {
        set({
          installStatus: "installing",
          installTarget: "uv (install)",
          installLog: [],
        });

        const onEvent = (event: ProcessEvent) => {
          if (event.event === "stdout" || event.event === "stderr") {
            set((state) => ({
              installLog: [...state.installLog, event.data.line],
            }));
          } else if (event.event === "finished") {
            set({
              installStatus: event.data.success ? "done" : "error",
            });
          }
        };

        try {
          await installUvCmd(onEvent);
          await get().refresh();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          set((state) => ({
            installStatus: "error",
            installLog: [...state.installLog, `Error: ${msg}`],
          }));
        }
      },

      clearInstallLog: () => {
        set({ installStatus: "idle", installLog: [], installTarget: null });
      },

      // Lightweight, best-effort check (just `uv --version` + `uv tool list`,
      // not the full interpreters/downloadable-Pythons detection `refresh()`
      // does) — meant to run on every project open without adding noticeable
      // latency. Also the ONLY thing that populates `uv`/`tools` before the
      // Environment panel has ever been opened (refresh() otherwise only
      // runs on that panel's mount) — App.tsx's startup effect relies on
      // that so the Environment badge can reflect "uv/sleap-nn missing" from
      // the Welcome screen, not just sleap-nn update availability.
      checkSleapNnUpdateAndNotify: () => {
        if (!isTauri) return Promise.resolve();
        if (sleapNnCheckInFlight) return sleapNnCheckInFlight;

        sleapNnCheckInFlight = (async () => {
          try {
            const [uvInfo, uvTools] = await Promise.all([
              detectUv(),
              listUvTools(),
            ]);
            set({ uv: uvInfo, tools: uvTools });

            const tool = uvTools.find((t) => t.name === "sleap-nn");
            if (!tool?.updateAvailable || !tool.latestVersion) return;
            if (tool.latestVersion === get().lastNotifiedSleapNnVersion) return;

            set({ lastNotifiedSleapNnVersion: tool.latestVersion });
            toast.info(`sleap-nn v${tool.latestVersion} is available`, {
              description: `You're on v${tool.version}.`,
              action: {
                label: "Release notes",
                onClick: () =>
                  openExternal(`${SLEAP_NN_RELEASES_URL}/v${tool.latestVersion}`),
              },
            });
          } catch (err) {
            console.error("[env] sleap-nn update check failed:", err);
          } finally {
            sleapNnCheckInFlight = null;
          }
        })();
        return sleapNnCheckInFlight;
      },
    }),
    {
      name: "sleap-app-environment",
      partialize: (state) =>
        Object.fromEntries(
          PERSISTED_KEYS.map((key) => [key, state[key]])
        ) as Partial<EnvironmentState>,
    }
  )
);
