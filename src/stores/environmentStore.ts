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
  checkSleapNnVersions,
  listUvTools,
  listPythonInterpreters,
  listDownloadablePythons,
  checkPython,
  installPython as installPythonCmd,
  installUvTool as installUvToolCmd,
  upgradeUvTool as upgradeUvToolCmd,
  uninstallUvTool as uninstallUvToolCmd,
  updateUv as updateUvCmd,
  installUv as installUvCmd,
  type AcceleratorInfo,
  type PyPiPackageVersions,
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
import {
  DEFAULT_SLEAP_NN_CHANNEL,
  SLEAP_NN_PYTHON_SPEC,
  exportExtras,
  isPep440Prerelease,
  isPythonVersionCompatible,
  isSleapNnVersionBelowCap,
  reconcileSleapNnTool,
  sleapNnInstallSpec,
  sleapNnUvExtraArgs,
  sleapNnVersionSpecifier,
  type SleapNnChannel,
} from "@/lib/sleapNnVersion";

const SLEAP_NN_RELEASES_URL = "https://github.com/talmolab/sleap-nn/releases/tag";

/** Best-effort PyPI check; tolerates offline/error/partial test mocks. */
async function safeCheckSleapNnVersions(): Promise<PyPiPackageVersions | null> {
  if (typeof checkSleapNnVersions !== "function") return null;
  try {
    const res = await checkSleapNnVersions();
    return res ?? null;
  } catch {
    return null;
  }
}

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
  /** Unadjusted `listUvTools()` snapshot so toggling `sleapNnChannel` recomputes immediately. */
  rawTools: UvTool[];
  interpreters: PythonInterpreter[];
  downloadable: PythonInterpreter[];

  /** Release channel preference for `sleap-nn` (`stable` vs `prerelease`). Persisted. */
  sleapNnChannel: SleapNnChannel;
  /** Whether the user has explicitly picked `sleapNnChannel` in the dropdown. Persisted. */
  sleapNnChannelExplicitlySet: boolean;
  /** Latest non-yanked PyPI version lists for `sleap-nn` and `sleap-io`. */
  pypiVersions: PyPiPackageVersions | null;
  pypiVersionsStatus: DetectionStatus;

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
  fetchPypiVersions: () => Promise<PyPiPackageVersions | null>;
  setSleapNnChannel: (channel: SleapNnChannel) => void;
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
  installExtras: (want: {
    onnx: boolean;
    tensorrt: boolean;
    backbones?: boolean;
  }) => Promise<void>;
  doUpgradeTool: (pkg: string) => Promise<void>;
  /**
   * Switch an installed `sleap-nn` tool onto the currently selected
   * `sleapNnChannel` (e.g. moving from `0.4.0a0` back to `stable` `0.3.5`).
   * Uses `--force` so `uv` cleanly replaces the tool venv even when moving to
   * an older version, while preserving detected optional extras.
   */
  doSwitchSleapNnChannel: () => Promise<void>;
  doReinstallTool: (pkg: string) => Promise<void>;
  /**
   * Replace a `sleap-rtc` uv tool (the SLEAP Connect worker's PyPI name up
   * to 0.0.7) with `sleap-connect`. Uninstalls first: both provide the same
   * executables. The worker's settings (~/.sleap-connect) aren't touched.
   */
  switchToSleapConnect: () => Promise<void>;
  doUpdateUv: () => Promise<void>;
  doInstallUv: () => Promise<void>;
  clearInstallLog: () => void;
  checkSleapNnUpdateAndNotify: () => Promise<void>;
}

/** Keys persisted to localStorage. */
const PERSISTED_KEYS: (keyof EnvironmentState)[] = [
  "selectedPythonPath",
  "lastNotifiedSleapNnVersion",
  "sleapNnChannel",
  "sleapNnChannelExplicitlySet",
];

export const useEnvironmentStore = create<EnvironmentState>()(
  persist(
    (set, get) => ({
      // Detection results
      uv: null,
      tools: [],
      rawTools: [],
      interpreters: [],
      downloadable: [],
      sleapNnChannel: DEFAULT_SLEAP_NN_CHANNEL,
      sleapNnChannelExplicitlySet: false,
      pypiVersions: null,
      pypiVersionsStatus: "idle",
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
              rawTools: [],
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

          // Run discovery in parallel (including best-effort PyPI version lookup)
          const [uvTools, pythons, downloadablePythons, pypi] =
            await Promise.all([
              listUvTools(),
              listPythonInterpreters(),
              listDownloadablePythons(),
              safeCheckSleapNnVersions(),
            ]);
          console.log("[env] tools:", uvTools);
          console.log("[env] interpreters:", pythons);
          console.log("[env] downloadable:", downloadablePythons);
          if (pypi) console.log("[env] PyPI versions:", pypi);

          const installedNn = uvTools.find((t) => t.name === "sleap-nn");
          let channel = get().sleapNnChannel;
          if (
            !get().sleapNnChannelExplicitlySet &&
            installedNn?.version &&
            isPep440Prerelease(installedNn.version)
          ) {
            channel = "prerelease";
          }

          const nextPypi = pypi ?? get().pypiVersions;
          set({
            sleapNnChannel: channel,
            rawTools: uvTools,
            pypiVersions: nextPypi,
            pypiVersionsStatus: "done",
            tools: uvTools.map((t) => reconcileSleapNnTool(t, channel, nextPypi)),
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

      fetchPypiVersions: async () => {
        set({ pypiVersionsStatus: "checking" });
        const pypi = await safeCheckSleapNnVersions();
        const channel = get().sleapNnChannel;
        const baseTools =
          get().rawTools.length > 0 ? get().rawTools : get().tools;
        set({
          pypiVersions: pypi ?? get().pypiVersions,
          pypiVersionsStatus: "done",
          tools: baseTools.map((t) =>
            reconcileSleapNnTool(t, channel, pypi ?? get().pypiVersions)
          ),
        });
        return pypi;
      },

      setSleapNnChannel: (channel: SleapNnChannel) => {
        const { rawTools, tools, pypiVersions } = get();
        const baseTools = rawTools.length > 0 ? rawTools : tools;
        set({
          sleapNnChannel: channel,
          sleapNnChannelExplicitlySet: true,
          tools: baseTools.map((t) =>
            reconcileSleapNnTool(t, channel, pypiVersions)
          ),
        });
        if (isTauri && !pypiVersions) {
          void get().fetchPypiVersions();
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
              backbones: false,
              pythonVersion: null,
              sleapIoVersion: null,
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
        const { selectedPythonPath, interpreters, pythonCheck } = get();
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
          let pythonArg: string | null = selectedPythonPath;

          // For sleap-nn, detect GPU and install with appropriate torch extra
          if (pkg === "sleap-nn") {
            const channel = get().sleapNnChannel;
            const gpu = await detectGpu();
            console.log("[env] Detected GPU type:", gpu);
            const torchExtra = gpu === "cuda" ? "torch-cuda130" : "torch-cpu";
            installPkg = sleapNnInstallSpec([torchExtra], channel);
            extraArgs = sleapNnUvExtraArgs([], channel);
            const selectedVersion = selectedPythonPath
              ? (interpreters.find((i) => i.path === selectedPythonPath)?.version ??
                pythonCheck?.version ??
                null)
              : null;
            if (!selectedPythonPath) {
              pythonArg = SLEAP_NN_PYTHON_SPEC;
            } else if (selectedVersion && !isPythonVersionCompatible(selectedVersion)) {
              pythonArg = SLEAP_NN_PYTHON_SPEC;
              set((state) => ({
                installLog: [
                  ...state.installLog,
                  `[env] Selected Python ${selectedVersion} is outside ${SLEAP_NN_PYTHON_SPEC} required by sleap-nn → using ${SLEAP_NN_PYTHON_SPEC}`,
                ],
              }));
            }
            set((state) => ({
              installLog: [
                ...state.installLog,
                `[env] GPU: ${gpu} (${channel}) → installing ${installPkg}`,
              ],
            }));
          }

          await installUvToolCmd(
            installPkg,
            pythonArg,
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
        // Preserve already-installed backbones extra so enabling export never wipes it.
        const currentBackbones = Boolean(get().extras?.backbones);
        await get().installExtras({
          onnx: true,
          tensorrt: withTensorrt,
          backbones: currentBackbones,
        });
      },

      installExtras: async ({ onnx, tensorrt, backbones }) => {
        const { selectedPythonPath, interpreters, pythonCheck, extras: currentExtras } = get();
        // TensorRT export is built on top of the ONNX toolchain, so `tensorrt`
        // always brings `export` with it — selecting TensorRT alone would
        // produce an env that can't export at all.
        // Callers that omit `backbones` keep whatever is currently installed.
        const wantBackbones =
          backbones !== undefined ? backbones : Boolean(currentExtras?.backbones);
        const extras = exportExtras({ onnx, tensorrt, backbones: wantBackbones });
        const labels = [
          onnx || tensorrt ? (tensorrt ? "ONNX + TensorRT" : "ONNX") : null,
          wantBackbones ? "pretrained backbones" : null,
        ].filter(Boolean);
        set({
          installStatus: "installing",
          installTarget:
            labels.length > 0
              ? `sleap-nn ${labels.join(" + ")} support`
              : "sleap-nn without optional extras",
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
          const channel = get().sleapNnChannel;
          const gpu = await detectGpu();
          const torchExtra = gpu === "cuda" ? "torch-cuda130" : "torch-cpu";
          // `uv tool install` REPLACES the tool env — it can't add or drop an
          // extra incrementally — so every apply names the FULL extra set and
          // forces a reinstall. That's also what makes unchecking work: the
          // omitted extra simply isn't in the new env. The torch backend has
          // to be restated for the same reason, or it would be dropped.
          const installPkg = sleapNnInstallSpec([torchExtra, ...extras], channel);
          let pythonArg: string | null = selectedPythonPath ?? SLEAP_NN_PYTHON_SPEC;
          const selectedVersion = selectedPythonPath
            ? (interpreters.find((i) => i.path === selectedPythonPath)?.version ??
              pythonCheck?.version ??
              null)
            : null;
          if (selectedVersion && !isPythonVersionCompatible(selectedVersion)) {
            pythonArg = SLEAP_NN_PYTHON_SPEC;
            set((state) => ({
              installLog: [
                ...state.installLog,
                `[env] Selected Python ${selectedVersion} is outside ${SLEAP_NN_PYTHON_SPEC} required by sleap-nn → using ${SLEAP_NN_PYTHON_SPEC}`,
              ],
            }));
          }
          set((state) => ({
            installLog: [
              ...state.installLog,
              `[env] GPU: ${gpu} (${channel}) → installing ${installPkg}`,
            ],
          }));
          await installUvToolCmd(
            installPkg,
            pythonArg,
            true,
            onEvent,
            sleapNnUvExtraArgs([], channel)
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
          if (pkg === "sleap-nn") {
            const channel = get().sleapNnChannel;
            // `uv tool upgrade` follows the version range recorded when the
            // tool was installed, and installs made before the cap recorded
            // none, so it would move them past the cap. Re-run the install
            // with the bounded requirement and `--upgrade` instead: it moves to
            // the newest version in range and records the constraint.
            const current = get().tools.find((t) => t.name === "sleap-nn");
            if (current?.version && !isSleapNnVersionBelowCap(current.version)) {
              // The capped install would move this env DOWN. Never do that
              // from a button that says Update.
              throw new Error(
                `sleap-nn ${current.version} is newer than this version of the ` +
                  `app installs (${sleapNnVersionSpecifier(channel)}), so there is ` +
                  "nothing to update to. Reinstall installs the newest " +
                  "supported version."
              );
            }
            // An install replaces the tool's requirements, so the extras the
            // env has now are restated, as in installExtras. If they can't be
            // read now, the last good reading is used; with neither, stop
            // without installing anything.
            const [gpu, probed] = await Promise.all([
              detectGpu(),
              detectSleapNnExtras(),
            ]);
            const lastGood = get().extras;
            const installed = !probed.error
              ? probed
              : lastGood && !lastGood.error
                ? lastGood
                : null;
            if (!installed) {
              throw new Error(
                `Could not tell which optional extras sleap-nn has (${probed.error}), ` +
                  "so the update was not started. Reinstall installs sleap-nn " +
                  "without optional extras; add them again afterwards."
              );
            }
            const torchExtra = gpu === "cuda" ? "torch-cuda130" : "torch-cpu";
            const installPkg = sleapNnInstallSpec(
              [torchExtra, ...exportExtras(installed)],
              channel
            );
            // Keep the interpreter the env already has when it satisfies
            // sleap-nn's Python requirement (`>=3.11,<3.14`). If upgrading
            // an older venv on Python 3.10 (or 3.14+), switch to `>=3.11,<3.14`
            // so the upgrade does not fail with a Python-version mismatch.
            let upgradePython: string | null = null;
            if (
              installed.pythonVersion &&
              !isPythonVersionCompatible(installed.pythonVersion)
            ) {
              upgradePython = SLEAP_NN_PYTHON_SPEC;
              set((state) => ({
                installLog: [
                  ...state.installLog,
                  `[env] Current sleap-nn Python ${installed.pythonVersion} is outside ${SLEAP_NN_PYTHON_SPEC} → switching to ${SLEAP_NN_PYTHON_SPEC}`,
                ],
              }));
            }
            set((state) => ({
              installLog: [
                ...state.installLog,
                `[env] GPU: ${gpu} (${channel}) → updating ${installPkg}`,
                "[env] Extras or install options added outside the app are not kept.",
              ],
            }));
            await installUvToolCmd(
              installPkg,
              upgradePython,
              false,
              onEvent,
              sleapNnUvExtraArgs(["--upgrade"], channel)
            );
          } else {
            await upgradeUvToolCmd(pkg, onEvent);
          }
          await get().refresh();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          set((state) => ({
            installStatus: "error",
            installLog: [...state.installLog, `Error: ${msg}`],
          }));
        }
      },

      doSwitchSleapNnChannel: async () => {
        const {
          selectedPythonPath,
          interpreters,
          pythonCheck,
          extras: lastGood,
          sleapNnChannel: channel,
        } = get();
        set({
          installStatus: "installing",
          installTarget: `sleap-nn (${channel} channel)`,
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
          const [gpu, probed] = await Promise.all([
            detectGpu(),
            detectSleapNnExtras().catch(() => null),
          ]);
          const installed =
            probed && !probed.error
              ? probed
              : lastGood && !lastGood.error
                ? lastGood
                : null;
          const torchExtra = gpu === "cuda" ? "torch-cuda130" : "torch-cpu";
          const preserved = installed ? exportExtras(installed) : [];
          const installPkg = sleapNnInstallSpec(
            [torchExtra, ...preserved],
            channel
          );
          const extraArgs = sleapNnUvExtraArgs([], channel);

          let pythonArg: string | null = selectedPythonPath;
          const selectedVersion = selectedPythonPath
            ? (interpreters.find((i) => i.path === selectedPythonPath)?.version ??
              pythonCheck?.version ??
              null)
            : null;
          if (!selectedPythonPath) {
            pythonArg = SLEAP_NN_PYTHON_SPEC;
          } else if (
            selectedVersion &&
            !isPythonVersionCompatible(selectedVersion)
          ) {
            pythonArg = SLEAP_NN_PYTHON_SPEC;
            set((state) => ({
              installLog: [
                ...state.installLog,
                `[env] Selected Python ${selectedVersion} is outside ${SLEAP_NN_PYTHON_SPEC} required by sleap-nn → using ${SLEAP_NN_PYTHON_SPEC}`,
              ],
            }));
          }
          set((state) => ({
            installLog: [
              ...state.installLog,
              `[env] GPU: ${gpu} (${channel}) → switching to ${installPkg}`,
            ],
          }));

          await installUvToolCmd(installPkg, pythonArg, true, onEvent, extraArgs);
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
        const { selectedPythonPath, interpreters, pythonCheck, extras: lastGood } = get();
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
          let pythonArg: string | null = selectedPythonPath;

          if (pkg === "sleap-nn") {
            const channel = get().sleapNnChannel;
            const [gpu, probed] = await Promise.all([
              detectGpu(),
              detectSleapNnExtras().catch(() => null),
            ]);
            const installed =
              probed && !probed.error
                ? probed
                : lastGood && !lastGood.error
                  ? lastGood
                  : null;
            const torchExtra = gpu === "cuda" ? "torch-cuda130" : "torch-cpu";
            const preserved = installed ? exportExtras(installed) : [];
            installPkg = sleapNnInstallSpec([torchExtra, ...preserved], channel);
            extraArgs = sleapNnUvExtraArgs([], channel);
            const selectedVersion = selectedPythonPath
              ? (interpreters.find((i) => i.path === selectedPythonPath)?.version ??
                pythonCheck?.version ??
                null)
              : null;
            if (!selectedPythonPath) {
              pythonArg = SLEAP_NN_PYTHON_SPEC;
            } else if (selectedVersion && !isPythonVersionCompatible(selectedVersion)) {
              pythonArg = SLEAP_NN_PYTHON_SPEC;
              set((state) => ({
                installLog: [
                  ...state.installLog,
                  `[env] Selected Python ${selectedVersion} is outside ${SLEAP_NN_PYTHON_SPEC} required by sleap-nn → using ${SLEAP_NN_PYTHON_SPEC}`,
                ],
              }));
            }
            set((state) => ({
              installLog: [
                ...state.installLog,
                `[env] GPU: ${gpu} (${channel}) → reinstalling ${installPkg}`,
              ],
            }));
          }

          await installUvToolCmd(
            installPkg,
            pythonArg,
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

      switchToSleapConnect: async () => {
        const { selectedPythonPath } = get();
        set({
          installStatus: "installing",
          installTarget: "sleap-connect (replacing sleap-rtc)",
          installLog: [],
        });
        let failed = false;
        const onEvent = (event: ProcessEvent) => {
          if (event.event === "stdout" || event.event === "stderr") {
            set((state) => ({
              installLog: [...state.installLog, event.data.line],
            }));
          } else if (event.event === "finished" && !event.data.success) {
            failed = true;
          }
        };

        try {
          await uninstallUvToolCmd("sleap-rtc", onEvent);
          if (!failed) {
            await installUvToolCmd(
              "sleap-connect",
              selectedPythonPath,
              false,
              onEvent
            );
          }
          set({ installStatus: failed ? "error" : "done" });
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
            const [uvInfo, listedTools, pypi] = await Promise.all([
              detectUv(),
              listUvTools(),
              safeCheckSleapNnVersions(),
            ]);
            const installedNn = listedTools.find((t) => t.name === "sleap-nn");
            let channel = get().sleapNnChannel;
            if (
              !get().sleapNnChannelExplicitlySet &&
              installedNn?.version &&
              isPep440Prerelease(installedNn.version)
            ) {
              channel = "prerelease";
            }
            const nextPypi = pypi ?? get().pypiVersions;
            // An update at or above the sleap-nn cap (or a channel downgrade) is not announced.
            const uvTools = listedTools.map((t) =>
              reconcileSleapNnTool(t, channel, nextPypi)
            );
            set({
              uv: uvInfo,
              sleapNnChannel: channel,
              rawTools: listedTools,
              pypiVersions: nextPypi,
              tools: uvTools,
            });

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
