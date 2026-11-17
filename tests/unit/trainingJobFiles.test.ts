/**
 * The configs and scripts behind the Training Configuration dialog's "Copy to
 * clipboard" and "Save configuration files..." buttons (PyQt's
 * runners.write_pipeline_files, with sleap-nn commands). Ported from
 * alicup29's talmolab/sleap-app#485, without the training job package.
 */
import { describe, it, expect } from "../bun-test";
import yaml from "js-yaml";
import { Skeleton, Video, Labels, LabeledFrame, Instance } from "@talmolab/sleap-io.js";
import { useTrainingStore, getConfigSlots, type ConfigFile, type ModelType } from "@/stores/trainingStore";
import { getRecommendedProfileForHead, slotToHeadType } from "@/lib/trainingProfiles";
import {
  buildTrainingJobFiles,
  shellQuote,
  trainingConfigsClipboardText,
  trainingJobZipName,
  type TrainingJobInputs,
} from "@/lib/trainingJobFiles";
import { browserConfigsReadme } from "@/commands/trainingConfigExport";

function makeLabels(): Labels {
  const skeleton = new Skeleton({ nodes: ["a", "b"], name: "s" });
  const video = new Video({
    filename: "/data/session1.mp4",
    backendMetadata: { shape: [50, 512, 512, 1] },
    openBackend: false,
  });
  const lf = new LabeledFrame({ video, frameIdx: 0 });
  const inst = Instance.empty({ skeleton });
  inst.points[0].xy = [10, 10];
  inst.points[0].visible = true;
  inst.points[1].xy = [60, 40];
  inst.points[1].visible = true;
  lf.instances.push(inst);
  return new Labels({ videos: [video], skeletons: [skeleton], labeledFrames: [lf] });
}

/** The configs the dialog would hold for `modelType`, from the app's baseline profiles. */
function baselineConfigs(modelType: ModelType): ConfigFile[] {
  return getConfigSlots(modelType).map((slot) => {
    const profile = getRecommendedProfileForHead(slotToHeadType(modelType, slot), null)!;
    return useTrainingStore.getState().parseYamlConfig(profile.content, profile.filename, slot)!;
  });
}

function inputs(over: Partial<TrainingJobInputs> = {}, target = "suggestions"): TrainingJobInputs {
  const labels = makeLabels();
  return {
    modelType: "top_down",
    configs: baselineConfigs("top_down"),
    labels,
    labelsPath: "/data/proj.slp",
    inference: {
      target,
      sampleCount: 5,
      skipUserLabeled: false,
      video: labels.videos[0],
    },
    runTimestamp: "261116_120000",
    random: () => 0.5,
    ...over,
  };
}

const fileText = (job: ReturnType<typeof buildTrainingJobFiles>, name: string) =>
  job.files.find((f) => f.name === name)?.text ?? "";

describe("training config files", () => {
  // PyQt writes one config per model plus the two scripts and jobs.yaml.
  it("writes a config per model, both scripts and jobs.yaml", () => {
    const job = buildTrainingJobFiles(inputs());
    expect(job.files.map((f) => f.name)).toEqual([
      "centroid.yaml",
      "centered_instance.yaml",
      "train-script.sh",
      "inference-script.sh",
      "jobs.yaml",
    ]);
  });

  // The configs must load as YAML and point at the project file and the run folder.
  it("writes valid sleap-nn YAML pointing at the project and a run folder", () => {
    const job = buildTrainingJobFiles(inputs());
    for (const name of job.configNames) {
      const doc = yaml.load(fileText(job, name)) as Record<string, Record<string, unknown>>;
      expect(doc.data_config.train_labels_path).toEqual(["/data/proj.slp"]);
      expect(doc.trainer_config.ckpt_dir).toBe("models");
      expect(String(doc.trainer_config.run_name)).toMatch(/^261116_120000\.(centroid|centered_instance)\.n=1$/);
    }
    expect(job.runDirs).toEqual([
      "models/261116_120000.centroid.n=1",
      "models/261116_120000.centered_instance.n=1",
    ]);
  });

  // The Training panel's Validation Labels file goes into every config.
  it("writes the validation labels path when one is set", () => {
    const job = buildTrainingJobFiles(inputs({ validationLabelsPath: "/data/val.slp" }));
    const doc = yaml.load(fileText(job, "centroid.yaml")) as { data_config: Record<string, unknown> };
    expect(doc.data_config.val_labels_path).toEqual(["/data/val.slp"]);
  });

  // ZMQ ports only matter when this app watches the run; a shared file must never carry a W&B key.
  it("clears the app's ZMQ ports and drops any W&B API key", () => {
    const base = inputs();
    base.configs = base.configs.map((c) => ({
      ...c,
      hyperparams: { ...c.hyperparams, useWandb: true, wandbApiKey: "secret-key-123" },
    }));
    const job = buildTrainingJobFiles(base);
    for (const name of job.configNames) {
      const text = fileText(job, name);
      expect(text).not.toContain("secret-key-123");
      const zmq = (yaml.load(text) as { trainer_config: { zmq: Record<string, unknown> } }).trainer_config.zmq;
      expect(zmq.controller_port).toBeNull();
      expect(zmq.publish_port).toBeNull();
    }
  });

  // Centroid must train before centered instance, each with its own config and run name.
  it("trains every model in pipeline order with sleap-nn", () => {
    const job = buildTrainingJobFiles(inputs());
    const lines = fileText(job, "train-script.sh").split("\n").filter((l) => l.startsWith("sleap-nn"));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("sleap-nn train --config-name centroid.yaml --config-dir .");
    expect(lines[0]).toContain(`'trainer_config.run_name="261116_120000.centroid.n=1"'`);
    expect(lines[1]).toContain("--config-name centered_instance.yaml");
    expect(fileText(job, "train-script.sh").startsWith("#!/bin/bash\n")).toBe(true);
  });

  // Suggestions are in the project file: inference reads it, with both trained models in order.
  it("runs inference on suggested frames from the project file", () => {
    const job = buildTrainingJobFiles(inputs());
    const lines = fileText(job, "inference-script.sh").split("\n").filter((l) => l.startsWith("sleap-nn"));
    expect(lines).toHaveLength(1);
    const line = lines[0];
    expect(line).toContain("sleap-nn track --data_path /data/proj.slp");
    expect(line).toContain(
      "--model_paths models/261116_120000.centroid.n=1 --model_paths models/261116_120000.centered_instance.n=1",
    );
    expect(line).toContain("--only_suggested_frames");
    expect(line).toContain("--output_path proj.slp.predictions.slp");
    expect(line).not.toContain("--gui");
  });

  // "Nothing" means no inference lines, like PyQt's empty inference script.
  it("leaves the inference script empty for Nothing", () => {
    const job = buildTrainingJobFiles(inputs({}, "nothing"));
    expect(fileText(job, "inference-script.sh")).not.toContain("sleap-nn");
    expect((yaml.load(fileText(job, "jobs.yaml")) as { inference: unknown[] }).inference).toEqual([]);
  });

  // Video targets read the original video file, as PyQt does.
  it("reads the original video file for video targets", () => {
    for (const target of ["video", "all_videos", "random", "random_video"]) {
      const line = fileText(buildTrainingJobFiles(inputs({}, target)), "inference-script.sh");
      expect(line).toContain("--data_path /data/session1.mp4");
      expect(line).not.toContain("--video_index");
    }
  });

  // "Current frame" reads the video file at the current frame (#479's targets).
  it("scripts the current frame against the original video", () => {
    const base = inputs({}, "frame");
    const line = fileText(
      buildTrainingJobFiles({ ...base, inference: { ...base.inference, frameIdx: 7 } }),
      "inference-script.sh",
    );
    expect(line).toContain("--data_path /data/session1.mp4");
    expect(line).toContain("--frames 7");
    expect(line).not.toContain("--video_index");
  });

  // "Selected clip" becomes a frame range; with nothing selected it's left out with a note.
  it("scripts a selected clip as a frame range", () => {
    const base = inputs({}, "clip");
    const job = buildTrainingJobFiles({ ...base, inference: { ...base.inference, frameRange: [20, 10] } });
    expect(fileText(job, "inference-script.sh")).toContain("--frames 10-20");

    const none = buildTrainingJobFiles(inputs({}, "clip"));
    expect(fileText(none, "inference-script.sh")).not.toContain("sleap-nn");
    expect(none.notes).toHaveLength(1);
  });

  // A video with no file of its own reads the project .slp with --video_index.
  it("uses the project file and --video_index for an embedded video", () => {
    const base = inputs({}, "video");
    Object.defineProperty(base.labels!.videos[0], "hasEmbeddedImages", { value: true });
    const line = fileText(buildTrainingJobFiles(base), "inference-script.sh");
    expect(line).toContain("--data_path /data/proj.slp --model_paths");
    expect(line).toContain("--video_index 0");
  });

  // Random samples are picked when the files are written, within the video's frame count.
  it("writes concrete frame numbers for random samples", () => {
    const job = buildTrainingJobFiles(inputs({}, "random"));
    const m = fileText(job, "inference-script.sh").match(/--frames ([\d,]+)/);
    expect(m).toBeTruthy();
    const frames = m![1].split(",").map(Number);
    expect(frames).toHaveLength(5);
    expect(frames.every((f) => f >= 0 && f < 50)).toBe(true);
  });

  // jobs.yaml lists the same jobs as data (PyQt's format).
  it("describes the jobs in jobs.yaml", () => {
    const job = buildTrainingJobFiles(inputs());
    const jobs = yaml.load(fileText(job, "jobs.yaml")) as {
      training: { cfg: string; run_path: string; train_labels: string }[];
      inference: { data_path: string; models: string[]; only_suggested_frames: boolean }[];
    };
    expect(jobs.training.map((t) => t.cfg)).toEqual(["centroid.yaml", "centered_instance.yaml"]);
    expect(jobs.training.every((t) => t.train_labels === "/data/proj.slp")).toBe(true);
    expect(jobs.inference[0].data_path).toBe("/data/proj.slp");
    expect(jobs.inference[0].only_suggested_frames).toBe(true);
  });

  // Single-model pipelines name the config after their head, like PyQt.
  it("names a single-model config after its head", () => {
    const job = buildTrainingJobFiles(inputs({ modelType: "bottom_up", configs: baselineConfigs("bottom_up") }));
    expect(job.configNames).toEqual(["bottomup.yaml"]);
  });
});

// Training job package mode: the configs and scripts point at the packaged .pkg.slp.
describe("training job package files", () => {
  const pkg = (target = "suggestions") => inputs({ labelsPath: "proj.pkg.slp", selfContained: true }, target);

  it("points the configs and suggestion inference at the package", () => {
    const job = buildTrainingJobFiles(pkg());
    const doc = yaml.load(fileText(job, "centroid.yaml")) as { data_config: { train_labels_path: string[] } };
    expect(doc.data_config.train_labels_path).toEqual(["proj.pkg.slp"]);
    expect(fileText(job, "inference-script.sh")).toContain("--data_path proj.pkg.slp");
  });

  // Video targets still read the original video: the package's video indices differ and it holds only labeled frames.
  it("still reads the original video file for video targets", () => {
    const line = fileText(buildTrainingJobFiles(pkg("video")), "inference-script.sh");
    expect(line).toContain("--data_path /data/session1.mp4");
    expect(line).not.toContain("proj.pkg.slp --");
  });

  // A video with no file of its own can't be scripted from a package; leave it out with a note.
  it("leaves out an embedded video's line, with a note", () => {
    const base = pkg("video");
    Object.defineProperty(base.labels!.videos[0], "hasEmbeddedImages", { value: true });
    const job = buildTrainingJobFiles(base);
    expect(fileText(job, "inference-script.sh")).not.toContain("sleap-nn");
    expect(job.notes.some((n) => n.includes("no video file of its own"))).toBe(true);
  });

  // Same name PyQt suggests: `<labels file>.training_job.zip`.
  it("names the zip after the labels file", () => {
    expect(trainingJobZipName("labels.v001.slp")).toBe("labels.v001.slp.training_job.zip");
    expect(trainingJobZipName("/a/b/proj.slp")).toBe("proj.slp.training_job.zip");
    expect(trainingJobZipName(null)).toBe("labels.slp.training_job.zip");
  });
});

describe("clipboard text, quoting and the browser README", () => {
  // The clipboard must hold every model's config, and still parse as YAML.
  it("copies every config as one multi-document YAML", () => {
    const job = buildTrainingJobFiles(inputs());
    const docs = yaml.loadAll(trainingConfigsClipboardText(job)) as Record<string, unknown>[];
    expect(docs).toHaveLength(2);
    expect(docs.every((d) => "trainer_config" in d && "model_config" in d)).toBe(true);
  });

  // Paths with spaces or quotes must survive bash.
  it("shell-quotes unsafe arguments", () => {
    expect(shellQuote("models/run.n=3")).toBe("models/run.n=3");
    expect(shellQuote("/my data/v.mp4")).toBe("'/my data/v.mp4'");
    expect(shellQuote("it's")).toBe(`'it'"'"'s'`);
  });

  // The browser zip names the labels file relative to itself, so say where to put it.
  it("tells browser users to put the .slp next to the files", () => {
    const readme = browserConfigsReadme("flies.slp");
    expect(readme).toContain(`read the labels file "flies.slp" from THIS folder`);
    expect(readme).toContain("bash train-script.sh");
  });
});
