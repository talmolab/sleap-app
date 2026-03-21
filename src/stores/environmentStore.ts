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
  listUvTools,
  listPythonInterpreters,
  listDownloadablePythons,
  checkPython,
  installPython as installPythonCmd,
  installUvTool as installUvToolCmd,
  upgradeUvTool as upgradeUvToolCmd,
  updateUv as updateUvCmd,
  installUv as installUvCmd,
  type UvInfo,
  type UvTool,
  type PythonInterpreter,
  type PythonInfo,
  type ProcessEvent,
} from "../platform/backend";

export type DetectionStatus = "idle" | "checking" | "done" | "error";
export type InstallStatus = "idle" | "installing" | "done" | "error";

export interface EnvironmentState {
  // Detection results (re-detected on launch)
  uv: UvInfo | null;
  tools: UvTool[];
  interpreters: PythonInterpreter[];
  downloadable: PythonInterpreter[];

  // Selected environment (persisted)
  selectedPythonPath: string | null;
  pythonCheck: PythonInfo | null;

  // Status
  detectionStatus: DetectionStatus;
  detectionError: string | null;

  // Install progress
  installStatus: InstallStatus;
  installLog: string[];
  installTarget: string | null;

  // Actions
  refresh: () => Promise<void>;
  selectPython: (path: string) => Promise<void>;
  clearSelection: () => void;
  doInstallPython: (version: string) => Promise<void>;
  doInstallTool: (pkg: string) => Promise<void>;
  doUpgradeTool: (pkg: string) => Promise<void>;
  doReinstallTool: (pkg: string) => Promise<void>;
  doUpdateUv: () => Promise<void>;
  doInstallUv: () => Promise<void>;
  clearInstallLog: () => void;
}

/** Keys persisted to localStorage. */
const PERSISTED_KEYS: (keyof EnvironmentState)[] = ["selectedPythonPath"];

export const useEnvironmentStore = create<EnvironmentState>()(
  persist(
    (set, get) => ({
      // Detection results
      uv: null,
      tools: [],
      interpreters: [],
      downloadable: [],

      // Selected environment
      selectedPythonPath: null,
      pythonCheck: null,

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
    }),
    {
      name: "sleap-label-environment",
      partialize: (state) =>
        Object.fromEntries(
          PERSISTED_KEYS.map((key) => [key, state[key]])
        ) as Partial<EnvironmentState>,
    }
  )
);
