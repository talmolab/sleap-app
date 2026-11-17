/**
 * The Training Configuration dialog's "Copy to clipboard" and "Save
 * configuration files..." buttons (PyQt's TrainingEditorWidget.copy / .save in
 * sleap/gui/learning/dialog.py). The files themselves are built by
 * `buildTrainingJobFiles`. Ported from alicup29's talmolab/sleap-app#485,
 * without its training job package.
 */
import { strToU8, zipSync, type Zippable } from "fflate";
import { useAppStore } from "@/stores/appStore";
import { useTrainingStore, type ConfigFile, type ModelType } from "@/stores/trainingStore";
import { buildTrainingJobFiles, trainingConfigsClipboardText, type TrainingJobFiles } from "@/lib/trainingJobFiles";
import { saveBytesFile } from "@/commands/fileCommands";
import { toastExported } from "@/lib/exportToast";
import { toast } from "@/lib/notify";
import { getPlatform } from "@/platform";

/** What the dialog knows about the job (the rest is read from the app). */
export interface TrainingConfigRequest {
  modelType: ModelType;
  configs: ConfigFile[];
  inferenceTarget: string;
  sampleCount: number;
  skipUserLabeled: boolean;
}

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/** The project file the configs point at. */
function projectLabelsPath(): string {
  const { projectPath, filename } = useAppStore.getState();
  return projectPath || filename || "labels.slp";
}

function buildJob(req: TrainingConfigRequest, labelsPath: string): TrainingJobFiles {
  const { labels, video } = useAppStore.getState();
  return buildTrainingJobFiles({
    modelType: req.modelType,
    configs: req.configs,
    labels,
    labelsPath,
    validationLabelsPath: useTrainingStore.getState().config.validationLabelsPath || undefined,
    inference: {
      target: req.inferenceTarget,
      sampleCount: req.sampleCount,
      skipUserLabeled: req.skipUserLabeled,
      video,
    },
  });
}

function failed(title: string, err: unknown) {
  console.error(`[trainingConfigExport] ${title}:`, err);
  toast.error(title, { description: err instanceof Error ? err.message : String(err) });
}

/** "Copy to clipboard": every model's sleap-nn config as YAML. */
export async function copyTrainingConfigsToClipboard(req: TrainingConfigRequest): Promise<boolean> {
  try {
    const job = buildJob(req, projectLabelsPath());
    await navigator.clipboard.writeText(trainingConfigsClipboardText(job));
    toast.success("Training configs copied", {
      description: `${job.configNames.join(", ")} as sleap-nn YAML`,
    });
    return true;
  } catch (err) {
    failed("Couldn't copy the training configs", err);
    return false;
  }
}

/**
 * "Save configuration files...": desktop asks for a folder (default:
 * `models/` next to the project, as PyQt) and writes the files there; the
 * browser can't write into a folder, so it downloads them as
 * `<labels>.training_configs.zip`.
 */
export async function saveTrainingConfigFiles(req: TrainingConfigRequest): Promise<string | null> {
  try {
    const platform = await getPlatform();
    if (platform.isTauri) {
      const job = buildJob(req, projectLabelsPath());
      const [{ open }, { dirname, join }] = await Promise.all([
        import("@tauri-apps/plugin-dialog"),
        import("@tauri-apps/api/path"),
      ]);
      const { projectPath } = useAppStore.getState();
      const defaultPath = projectPath ? await join(await dirname(projectPath), "models") : undefined;
      const dir = await open({ directory: true, title: "Select directory to save scripts", defaultPath });
      if (!dir || Array.isArray(dir)) return null;
      for (const f of job.files) await platform.writeFile(await join(dir, f.name), strToU8(f.text));
      toastExported("Configuration files saved", dir, true);
      return dir;
    }
    // The browser only knows the project's file name, not where it is on
    // disk, so the configs and scripts name it relative to their own folder.
    const labelsName = baseName(projectLabelsPath());
    const job = buildJob(req, labelsName);
    const zippable: Zippable = { "README.txt": strToU8(browserConfigsReadme(labelsName)) };
    for (const f of job.files) zippable[f.name] = strToU8(f.text);
    const saved = await saveBytesFile(zipSync(zippable), `${labelsName}.training_configs.zip`, {
      name: "Zip archive",
      ext: "zip",
    });
    if (!saved) return null;
    toast.success("Configuration files saved", {
      description: `${saved} — unzip it and put ${labelsName} in the same folder before running the scripts.`,
    });
    return saved;
  } catch (err) {
    failed("Couldn't save the configuration files", err);
    return null;
  }
}

/** README for the browser's configs zip: where the labels file has to go. */
export function browserConfigsReadme(labelsName: string): string {
  return [
    "SLEAP training configuration files",
    "",
    `The configs and scripts here read the labels file "${labelsName}" from THIS folder.`,
    `Before running them, copy ${labelsName} (saved from SLEAP) next to these files.`,
    "Save your project first, so the copy has your latest labels.",
    "",
    "Then, with sleap-nn installed:",
    "  bash train-script.sh       # trains every model into models/",
    "  bash inference-script.sh   # runs the trained models (post-training inference target)",
    "",
    "Inference lines for a video target read the video at the path it had on the computer",
    "this was exported from; edit inference-script.sh if the video is elsewhere.",
    "",
  ].join("\n");
}
