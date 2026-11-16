/**
 * The files PyQt SLEAP's training dialog writes for running a training job
 * yourself — its "Copy to clipboard", "Save configuration files..." and
 * "Export Training Job Package..." buttons (`sleap/gui/learning/dialog.py`
 * `copy` / `save` / `export_package`, and `runners.write_pipeline_files`):
 *
 * - one sleap-nn config per model, `<head>.yaml` (e.g. `centroid.yaml`),
 * - `train-script.sh`, one `sleap-nn train` line per model, in pipeline order,
 * - `inference-script.sh`, the post-training inference as `sleap-nn track`
 *   lines (empty when the target is "Nothing"), and
 * - `jobs.yaml`, the same jobs as data.
 *
 * PyQt's scripts call `sleap train` / `sleap track`; these call sleap-nn
 * directly, which is what this app runs. `track` (not `predict`) because
 * every sleap-nn version has it, and the scripts may run on another machine.
 *
 * Pure: the caller passes the labels and the current frame/clip, so it can
 * be unit-tested and shared by the three buttons.
 */
import yaml from "js-yaml";
import type { Labels } from "@talmolab/sleap-io.js";
import {
  applyHyperparamsToYaml,
  buildPostTrainingInferenceConfig,
  getConfigSlots,
  resolveRemoteMaxStride,
  resolveRemoteRunName,
  type ConfigFile,
  type ModelType,
} from "@/stores/trainingStore";
import { slotToHeadType } from "@/lib/trainingProfiles";
import { detectVideoChannels, resolveInputChannels } from "@/lib/modelStats";
import { buildInferenceArgs } from "@/platform/inferenceArgs";
import { resolvePostTrainingTarget } from "@/lib/postTrainingTarget";
import { formatRunTimestamp } from "@/lib/timestamp";

/** Where the scripts put trained models, relative to the folder they run in (PyQt: `models`). */
export const JOB_MODELS_DIR = "models";

export interface TrainingJobFile {
  name: string;
  text: string;
}

export interface TrainingJobInputs {
  modelType: ModelType;
  configs: ConfigFile[];
  /** The open project (for run names, Auto max stride, input channels, and video paths). */
  labels: Labels | null;
  /**
   * The labels file the configs and scripts point at: the package's
   * `.pkg.slp` file name for a training job package, or the project's own
   * path for "Save configuration files...".
   */
  labelsPath: string;
  /** Validation labels file (Training panel "Validation Labels"), if any. */
  validationLabelsPath?: string;
  /**
   * True when `labelsPath` is a package with the frames' images inside it.
   * Then every inference line reads the package, never the original videos,
   * so the package also works on a machine without them.
   */
  selfContained?: boolean;
  inference: {
    /** A Post-Training Inference Target value (see postTrainingTarget.ts). */
    target: string;
    sampleCount: number;
    skipUserLabeled: boolean;
    /** App state the target is resolved against. */
    video: Labels["videos"][number] | null;
    frameIdx: number;
    frameRange: readonly [number, number] | null;
  };
  /** Shared timestamp for every run name; defaults to now. */
  runTimestamp?: string;
  /** Injectable RNG for random-sample targets (tests). */
  random?: () => number;
}

export interface TrainingJobFiles {
  files: TrainingJobFile[];
  /** `<head>.yaml` per model, in pipeline order. */
  configNames: string[];
  /** The run folder each model trains into (`models/<run name>`), in pipeline order. */
  runDirs: string[];
  /** Notes for the user (e.g. why inference was left out). */
  notes: string[];
}

/** Quote one argument for bash: plain words stay bare, anything else is single-quoted. */
export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'"'"'`)}'`;
}

/** A Hydra override with a double-quoted value (PyQt's form), so `=` in a run name survives. */
function hydraOverride(key: string, value: string): string {
  return shellQuote(`${key}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`);
}

const SCRIPT_HEADER =
  "#!/bin/bash\n" +
  "# Run from anywhere: paths below are relative to this script's folder.\n" +
  'cd "$(dirname "$0")"\n';

/** File-name-safe basename of a path (either separator). */
function baseName(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

/**
 * The sleap-nn config one model trains with, as written to `<head>.yaml`.
 * Same resolution as a local run (Auto max stride, input channels, run name),
 * plus what a hand-run job needs: the labels path and run folder baked in.
 * ZMQ ports are cleared (they only matter when this app is watching the run)
 * and a W&B API key is never written into a file meant to be shared.
 */
export function buildJobConfigYaml(
  cf: ConfigFile,
  opts: {
    labels: Labels | null;
    labelsPath: string;
    validationLabelsPath?: string;
    runName: string;
  },
): string {
  const resolvedMaxStride = resolveRemoteMaxStride(cf.hyperparams, opts.labels);
  const resolvedInChannels = resolveInputChannels(
    cf.hyperparams.colorMode,
    detectVideoChannels(opts.labels),
  );
  const text = applyHyperparamsToYaml(
    cf.content,
    { ...cf.hyperparams, wandbApiKey: "" },
    cf.checkpointPath,
    resolvedMaxStride,
    resolvedInChannels,
  );
  const doc = (yaml.load(text) ?? {}) as Record<string, Record<string, unknown>>;
  doc.data_config ??= {};
  doc.trainer_config ??= {};
  doc.data_config.train_labels_path = [opts.labelsPath];
  if (opts.validationLabelsPath) doc.data_config.val_labels_path = [opts.validationLabelsPath];
  doc.trainer_config.run_name = opts.runName;
  doc.trainer_config.ckpt_dir = JOB_MODELS_DIR;
  const zmq = doc.trainer_config.zmq as Record<string, unknown> | undefined;
  if (zmq && typeof zmq === "object") {
    zmq.controller_port = null;
    zmq.publish_port = null;
  }
  const wandb = doc.trainer_config.wandb as Record<string, unknown> | undefined;
  if (wandb && typeof wandb === "object") delete wandb.api_key;
  return yaml.dump(doc, { lineWidth: -1 });
}

/** Configs sorted into pipeline order (centroid before centered instance). */
function inPipelineOrder(modelType: ModelType, configs: ConfigFile[]): ConfigFile[] {
  const order = getConfigSlots(modelType);
  return [...configs]
    .filter((c) => order.includes(c.slot))
    .sort((a, b) => order.indexOf(a.slot) - order.indexOf(b.slot));
}

/** Sample `count` distinct sorted frame indices from [0, total). */
function sampleFrames(total: number, count: number, random: () => number): number[] {
  const all = Array.from({ length: total }, (_, i) => i);
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, Math.min(count, total)).sort((a, b) => a - b);
}

/**
 * Build every file of the job. Throws only on a programming error; targets
 * that can't be scripted (e.g. "Selected clip" with nothing selected) are
 * left out of `inference-script.sh` with a note.
 */
export function buildTrainingJobFiles(inputs: TrainingJobInputs): TrainingJobFiles {
  const { labels, labelsPath, modelType } = inputs;
  const runTimestamp = inputs.runTimestamp ?? formatRunTimestamp();
  const random = inputs.random ?? Math.random;
  const notes: string[] = [];

  const configs = inPipelineOrder(modelType, inputs.configs);
  const files: TrainingJobFile[] = [];
  const configNames: string[] = [];
  const runDirs: string[] = [];
  const trainingJobs: Record<string, string>[] = [];
  let trainScript = SCRIPT_HEADER;

  for (const cf of configs) {
    const head = slotToHeadType(modelType, cf.slot);
    const configName = `${head}.yaml`;
    const runName = resolveRemoteRunName(cf.hyperparams, cf.modelType, labels, { runTimestamp });
    files.push({
      name: configName,
      text: buildJobConfigYaml(cf, {
        labels,
        labelsPath,
        validationLabelsPath: inputs.validationLabelsPath,
        runName,
      }),
    });
    configNames.push(configName);
    const runDir = `${JOB_MODELS_DIR}/${runName}`;
    runDirs.push(runDir);
    trainScript +=
      [
        "sleap-nn train",
        "--config-name", shellQuote(configName),
        "--config-dir", ".",
        hydraOverride("trainer_config.ckpt_dir", JOB_MODELS_DIR),
        hydraOverride("trainer_config.run_name", runName),
      ].join(" ") + "\n";
    trainingJobs.push({ cfg: configName, run_path: runDir, train_labels: labelsPath });
  }

  // ── Inference ──────────────────────────────────────────────────
  let inferenceScript = SCRIPT_HEADER;
  const inferenceJobs: Record<string, unknown>[] = [];
  const { target } = inputs.inference;
  if (target !== "nothing" && runDirs.length > 0) {
    const resolved = resolvePostTrainingTarget(target, {
      labels,
      video: inputs.inference.video,
      frameRange: inputs.inference.frameRange,
    });
    if ("skip" in resolved) {
      notes.push(resolved.skip);
    } else {
      const config = buildPostTrainingInferenceConfig({
        modelType,
        modelPaths: runDirs,
        inferenceTarget: resolved.frameRange,
        videoIndex: resolved.videoIndex,
        sampleCount: inputs.inference.sampleCount,
        skipUserLabeled: inputs.inference.skipUserLabeled,
      });
      const videos = labels?.videos ?? [];
      // A video-scoped line reads the video's own file (PyQt does the same),
      // unless the labels file is a self-contained package or the video has
      // no file of its own.
      const videoFile = (vi: number): string | null => {
        if (inputs.selfContained) return null;
        const v = videos[vi];
        const f = v?.filename;
        return v && !v.hasEmbeddedImages && typeof f === "string" ? f : null;
      };
      const lines: { args: string[]; dataPath: string; outputPath: string; type: string }[] = [];
      const addLine = (
        cfg: typeof config,
        vi: number | null,
        extra: { sampledFrames?: number[]; currentFrameIdx?: number } = {},
      ) => {
        const own = vi != null ? videoFile(vi) : null;
        const dataPath = own ?? labelsPath;
        const outputPath = `${baseName(dataPath)}${vi != null && !own ? `.video${vi}` : ""}.predictions.slp`;
        const args = buildInferenceArgs(cfg, {
          dataPath,
          outputPath,
          suppressVideoIndex: own != null,
          subcommand: "track",
          ...extra,
        }).filter((a) => a !== "--gui");
        lines.push({ args, dataPath, outputPath, type: own ? "video" : "labels" });
      };

      if (config.frameRange === "random") {
        videos.forEach((v, vi) => {
          const n = v.shape?.[0] ?? 0;
          if (n === 0) return;
          addLine({ ...config, videoIndex: vi, frameRange: "random_video" }, vi, {
            sampledFrames: sampleFrames(n, config.sampleCount, random),
          });
        });
      } else if (config.frameRange === "all_videos") {
        // One line per video, as PyQt's "All videos" makes one item per video.
        videos.forEach((_v, vi) => addLine({ ...config, videoIndex: vi, frameRange: "video" }, vi));
      } else if (config.frameRange === "random_video") {
        const vi = config.videoIndex === "all" ? 0 : config.videoIndex;
        const n = videos[vi]?.shape?.[0] ?? 0;
        if (n > 0) addLine(config, vi, { sampledFrames: sampleFrames(n, config.sampleCount, random) });
        else notes.push("The current video's frame count is unknown, so random-sample inference was left out.");
      } else if (config.frameRange === "frame") {
        addLine(config, config.videoIndex === "all" ? 0 : config.videoIndex, {
          currentFrameIdx: inputs.inference.frameIdx,
        });
      } else if (config.videoIndex !== "all") {
        addLine(config, config.videoIndex); // "video" or a selected clip
      } else {
        addLine(config, null); // suggestions / user_labeled / predicted
      }

      for (const line of lines) {
        inferenceScript += `sleap-nn ${line.args.map(shellQuote).join(" ")}\n`;
        inferenceJobs.push({
          data_path: line.dataPath,
          models: runDirs,
          output_path: line.outputPath,
          type: line.type,
          only_suggested_frames: config.frameRange === "suggestions",
        });
      }
    }
  }

  files.push({ name: "train-script.sh", text: trainScript });
  files.push({ name: "inference-script.sh", text: inferenceScript });
  files.push({
    name: "jobs.yaml",
    text: yaml.dump({ training: trainingJobs, inference: inferenceJobs }, { lineWidth: -1 }),
  });

  return { files, configNames, runDirs, notes };
}

/**
 * What "Copy to clipboard" copies: every model's sleap-nn config, as one
 * multi-document YAML (PyQt copies the same configs, one after another).
 */
export function trainingConfigsClipboardText(job: TrainingJobFiles): string {
  return job.configNames
    .map((name) => {
      const text = job.files.find((f) => f.name === name)?.text ?? "";
      return `# ${name}\n${text}`;
    })
    .join("---\n");
}

/** PyQt's package name: `<labels file>.training_job.zip` (e.g. `labels.v001.slp.training_job.zip`). */
export function trainingJobZipName(projectFilename: string | null): string {
  return `${baseName(projectFilename || "labels.slp")}.training_job.zip`;
}
