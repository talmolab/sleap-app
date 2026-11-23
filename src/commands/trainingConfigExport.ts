/**
 * The Training Configuration dialog's three footer buttons, as in PyQt SLEAP
 * (`sleap/gui/learning/dialog.py`: `copy`, `save`, `export_package`):
 *
 * - **Copy to clipboard** — every model's sleap-nn config as YAML.
 * - **Save configuration files...** — the configs plus `train-script.sh`,
 *   `inference-script.sh` and `jobs.yaml` into a folder (desktop), or as a
 *   `.zip` download (browser, which can't write into a folder).
 * - **Export Training Job Package...** — `<labels>.training_job.zip`: a
 *   `.pkg.slp` with the images of the user-labeled frames embedded (plus the
 *   suggested frames when inference targets suggestions, as PyQt), and the
 *   same configs and scripts pointing at that package, to train on a machine
 *   without the original videos. The package is built with the Export Labels
 *   Package code (#438). On desktop it is written to a temp file and streamed
 *   into the zip; in the browser it is built in memory and downloaded.
 *
 * The files are built by `buildTrainingJobFiles`. Ported from alicup29's
 * talmolab/sleap-app#485.
 */
import { strToU8, zipSync, type Zippable } from "fflate";
import { ExportCancelled } from "@talmolab/sleap-io.js";
import { useAppStore } from "@/stores/appStore";
import { useTrainingStore, type ConfigFile, type ModelType } from "@/stores/trainingStore";
import {
  buildTrainingJobFiles,
  trainingConfigsClipboardText,
  trainingJobZipName,
  type TrainingJobFiles,
} from "@/lib/trainingJobFiles";
import {
  canStreamPackage,
  derivePackageFilename,
  labelsPackageBytes,
  warnUnembedded,
  withEmbedProgress,
  withExportLock,
  writeLabelsPackageToPath,
  type ExportPackageLevel,
} from "@/commands/exportPackageCommands";
import { saveBytesFile } from "@/commands/fileCommands";
import { writeZip, textSource, ZipCancelled, ZIP_SIZE_LIMIT, type ZipSource } from "@/lib/streamingZip";
import { toastExported } from "@/lib/exportToast";
import { toast } from "@/lib/notify";
import { getPlatform } from "@/platform";
import type { PackageImageOptions } from "@/lib/packageImageFormat";

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

/** The project file the configs point at when they aren't packaged. */
function projectLabelsPath(): string {
  const { projectPath, filename } = useAppStore.getState();
  return projectPath || filename || "labels.slp";
}

function buildJob(req: TrainingConfigRequest, labelsPath: string, selfContained = false): TrainingJobFiles {
  const { labels, video, frameIdx, frameRange } = useAppStore.getState();
  return buildTrainingJobFiles({
    modelType: req.modelType,
    configs: req.configs,
    labels,
    labelsPath,
    // The package doesn't include a separate validation labels file.
    validationLabelsPath: selfContained
      ? undefined
      : useTrainingStore.getState().config.validationLabelsPath || undefined,
    selfContained,
    inference: {
      target: req.inferenceTarget,
      sampleCount: req.sampleCount,
      skipUserLabeled: req.skipUserLabeled,
      video,
      frameIdx,
      frameRange,
    },
  });
}

function showNotes(job: TrainingJobFiles) {
  for (const note of job.notes) toast.info("Inference left out of the scripts", { description: note });
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
      showNotes(job);
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
    showNotes(job);
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

/** Run `work` under the progress overlay while zipping, with Cancel. */
async function withZipProgress<T>(work: (onProgress: (done: number, total: number) => boolean) => Promise<T>): Promise<T> {
  const { setLoading, setLoadingCancel } = useAppStore.getState();
  let cancelled = false;
  setLoading(true, "Zipping package…", 0);
  setLoadingCancel(() => {
    cancelled = true;
    setLoading(true, "Cancelling…");
  });
  try {
    return await work((done, total) => {
      if (cancelled) return false;
      setLoading(true, "Zipping package…", total > 0 ? Math.round((100 * done) / total) : 0);
      return true;
    });
  } finally {
    setLoading(false);
  }
}

function tooLarge(bytes: number): Error {
  return new Error(
    `The package would be ${(bytes / 2 ** 30).toFixed(1)} GB, more than a .zip can hold (4 GB). ` +
      "Use File > Export Labels Package and Save configuration files... instead.",
  );
}

/** Stream `sources` into a new zip at `zipPath` with the native write handle. */
async function writeZipFile(
  zipPath: string,
  sources: ZipSource[],
  onProgress: (done: number, total: number) => boolean,
): Promise<void> {
  const { withNativeWriteHandle, writeOpen, writeAt, writeClose, removeFile } = await import("@/lib/nativeWrite");
  await withNativeWriteHandle(async () => {
    await writeOpen(zipPath);
    let offset = 0;
    try {
      await writeZip(
        sources,
        async (chunk) => {
          await writeAt(offset, chunk);
          offset += chunk.byteLength;
        },
        { onProgress },
      );
    } catch (err) {
      await writeClose().catch(() => {});
      await removeFile(zipPath).catch(() => {}); // don't leave a broken zip behind
      throw err;
    }
    await writeClose();
  });
}

/**
 * "Export Training Job Package...". Returns where the zip was saved, or
 * null if nothing was written (cancelled or failed). `options.image` is the
 * package's frame format; the Training dialog passes none, so its packages
 * keep PNG frames.
 */
export async function exportTrainingJobPackage(
  req: TrainingConfigRequest,
  options: { image?: PackageImageOptions } = {},
): Promise<string | null> {
  const { labels, filename } = useAppStore.getState();
  if (!labels) return null;
  // The package holds a 2.x copy of the project: a View only project asks to
  // allow editing first, and nodes not labeled are announced as hidden.
  const { ensureWritable, confirmUnlabeledAsHidden } = await import("@/lib/slpAccess");
  if (!(await ensureWritable(labels, "export"))) return null;
  if (!(await confirmUnlabeledAsHidden(labels, "training"))) return null;
  // PyQt: embed the suggested frames too only when inference targets them.
  const level: ExportPackageLevel = req.inferenceTarget === "suggestions" ? "training" : "user";
  const pkgName = baseName(derivePackageFilename(filename));
  const zipName = trainingJobZipName(filename);

  return withExportLock(async () => {
    try {
      const job = buildJob(req, pkgName, true);
      const texts = job.files.map((f) => textSource(f.name, f.text));
      const textBytes = texts.reduce((n, s) => n + s.size, 0);
      const platform = await getPlatform();

      if (platform.isTauri) {
        const zipPath = await platform.showSaveDialog({
          filters: [{ name: "Training Job Package", extensions: ["zip"] }],
          defaultName: zipName,
        });
        if (!zipPath) return null;
        const [{ tempDir, join }, { fileSize, readRange }, { removeFile }] = await Promise.all([
          import("@tauri-apps/api/path"),
          import("@/lib/nativeRange"),
          import("@/lib/nativeWrite"),
        ]);
        const tmpPkg = await join(await tempDir(), `sleap_training_job_${Date.now()}_${pkgName}`);
        let unembedded = false;
        try {
          const twoPasses = !(await canStreamPackage());
          unembedded = await withEmbedProgress(twoPasses, (onProgress) =>
            writeLabelsPackageToPath(labels, level, tmpPkg, onProgress, options.image),
          );
          const pkgSize = await fileSize(tmpPkg);
          if (pkgSize + textBytes > ZIP_SIZE_LIMIT) throw tooLarge(pkgSize + textBytes);
          const pkgSource: ZipSource = {
            name: pkgName,
            size: pkgSize,
            read: (offset, length) => readRange(tmpPkg, offset, length),
          };
          await withZipProgress((onProgress) => writeZipFile(zipPath, [pkgSource, ...texts], onProgress));
        } finally {
          await removeFile(tmpPkg).catch(() => {});
        }
        toastExported("Training job package exported", zipPath, true);
        if (unembedded) warnUnembedded();
        showNotes(job);
        return zipPath;
      }

      // Browser: build the package in memory, zip it, then download / save.
      const bytes = await withEmbedProgress(true, (onProgress) =>
        labelsPackageBytes(labels, level, onProgress, options.image),
      );
      if (bytes.byteLength + textBytes > ZIP_SIZE_LIMIT) throw tooLarge(bytes.byteLength + textBytes);
      const zippable: Zippable = { [pkgName]: [bytes, { level: 0 }] };
      for (const f of job.files) zippable[f.name] = strToU8(f.text);
      const saved = await saveBytesFile(zipSync(zippable), zipName, { name: "Training Job Package", ext: "zip" });
      if (!saved) return null;
      toastExported("Training job package exported", saved, false);
      showNotes(job);
      return saved;
    } catch (err) {
      if (err instanceof ExportCancelled || err instanceof ZipCancelled) {
        toast.info("Export cancelled", { description: "No training job package was written." });
        return null;
      }
      failed("Failed to export the training job package", err);
      return null;
    }
  });
}
