/**
 * PR5b §5b.2 — the launcher wizard (design §4.3): start a new job on data
 * that already lives on a worker. Opened from `WorkerJobs`' "+ New job", or
 * seeded from a past run's config for "Run again" (`WorkerJobs`' row
 * action, §5b.3, via {@link seedWizardFromRun}).
 *
 * The worker is always pre-selected (step 1 — this wizard is opened already
 * scoped to one worker), so the interactive flow starts with a Train /
 * Inference job-type choice (`jobKind`), then step 2:
 *  - Train: browse to a worker-side `.slp`, pick where the training config
 *    comes from, and optionally chain post-train inference.
 *  - Inference: browse to a worker-side `.slp`, pick a completed training
 *    run on this worker (or browse a model folder manually — needed for a
 *    split top-down run's two model dirs), and a target. This is the ONLY
 *    way to start remote inference now — `WorkerJobs` used to offer a
 *    per-row "Run inference" action on every completed train job, which
 *    broke for a split multi-model run (centroid + centered_instance = two
 *    rows, two buttons, neither runnable alone).
 * Step 3 is a read-only summary before submitting via `submitJobsOn`
 * (fire-and-forget — this window doesn't wait for the job).
 *
 * The wizard's config state lives entirely here (`configs`/`modelType`), not
 * in `useTrainingStore` — `TrainingConfigDialog`'s `configActions` override
 * (PR5a.5) routes every edit through wizard-local state instead, so nothing
 * here ever touches the Training panel's own config.
 */
import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/lib/notify";
import type { Labels } from "@talmolab/sleap-io.js";
import type { JobStatus, JobSummary, WorkerClient } from "@/lib/protocolV1/client";
import { useConnectStore, pathRulesFor } from "@/stores/connectStore";
import {
  useTrainingStore,
  getConfigSlots,
  buildPostTrainingInferenceConfig,
  type ConfigFile,
  type ConfigHyperparams,
  type ModelType,
} from "@/stores/trainingStore";
import { getDefaultProfileForHead, slotToHeadType } from "@/lib/trainingProfiles";
import {
  loadWorkerLabels,
  checkWorkerFileVideos,
  needsLabelsRepoint,
  videoChecksToVisibility,
  type WorkerFileVideoCheck,
} from "@/lib/workerLabels";
import { inferRuleFromLocate } from "@/lib/remoteVisibility";
import {
  buildLauncherTrainSpec,
  buildRunInferenceSpecs,
  inferModelType,
  seedFromJobSpec,
} from "@/lib/launcherSpec";
import { projectTag } from "@/lib/projectTag";
import { timeAgo } from "@/lib/timestamp";
import { TrainingConfigDialog, type TrainingConfigActions } from "@/components/dialogs/TrainingConfigDialog";
import { RemoteFileBrowser } from "@/components/dialogs/RemoteFileBrowser";

/** Last path segment of a worker path (handles both `/` and `\`). */
function basename(p: string): string {
  const parts = p.split(/[\\/]/);
  return parts[parts.length - 1] || p;
}

const MODEL_TYPE_OPTIONS: { value: ModelType; label: string }[] = [
  { value: "single_animal", label: "Single Animal" },
  { value: "top_down", label: "Top-Down" },
  { value: "bottom_up", label: "Bottom-Up" },
  { value: "top_down_id", label: "Top-Down + ID" },
  { value: "bottom_up_id", label: "Bottom-Up + ID" },
];

/**
 * Post-training inference targets valid for a worker-file launch — there's
 * no open project, so no "current frame"/"current video" the way
 * `TrainingPanel`'s own select offers (design §4.3; see `launcherSpec.ts`'s
 * `buildLauncherTrainSpec` doc on why `currentFrameIdx`/`activeVideoFrameCount`
 * are always 0 there).
 */
export const WORKER_FILE_INFERENCE_TARGETS: { value: string; label: string }[] = [
  { value: "suggestions", label: "Suggested frames" },
  { value: "user_labeled", label: "User labeled frames" },
  { value: "predicted", label: "Frames with predictions" },
  { value: "all_videos", label: "All videos" },
  { value: "random", label: "Random sample (all videos)" },
];

/** Reads a whole small worker-side text file (a YAML config) via repeated `fs.read` calls — unbounded by the worker's per-call cap, unlike a single `fsRead`. */
async function readWholeWorkerFile(client: WorkerClient, path: string): Promise<string> {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (;;) {
    const { content, eof } = await client.fsRead(path, offset);
    chunks.push(content);
    offset += content.length;
    if (eof || content.length === 0) break;
  }
  const total = new Uint8Array(offset);
  let pos = 0;
  for (const c of chunks) {
    total.set(c, pos);
    pos += c.length;
  }
  return new TextDecoder().decode(total);
}

/** One baseline config per slot `modelType` needs — the plain per-head default (`getDefaultProfileForHead`), not `TrainingConfigDialog`'s own size-aware recommendation (there's no labels loaded yet the moment a "defaults" start is first picked). Mirrors that dialog's own auto-load effect closely enough that opening "Edit hyperparameters…" afterward never re-seeds anything (every slot is already filled). */
function defaultConfigsFor(modelType: ModelType): ConfigFile[] {
  const { parseYamlConfig } = useTrainingStore.getState();
  const configs: ConfigFile[] = [];
  for (const slot of getConfigSlots(modelType)) {
    const headType = slotToHeadType(modelType, slot);
    const baseline = getDefaultProfileForHead(headType);
    if (!baseline) continue;
    const parsed = parseYamlConfig(baseline.content, baseline.filename, slot);
    if (parsed) configs.push({ ...parsed, hyperparams: { ...parsed.hyperparams, maxStride: null } });
  }
  return configs;
}

/** Merges a train run's sibling job specs (by `run.id`, ordered by `run.index`) into the one `seedFromJobSpec` expects, and resolves the run's own labels path — shared by the wizard's "a past job on this worker" start option and `WorkerJobs`' "Run again" row action so the two never drift. `null` when the specs don't parse into a recognized pipeline or no labels path is known. */
export async function seedWizardFromRun(
  jobDetail: (workerId: string, jobId: string) => Promise<JobStatus>,
  workerId: string,
  jobIds: string[],
): Promise<NewJobWizardSeed | null> {
  const details = await Promise.all(jobIds.map((id) => jobDetail(workerId, id)));
  const configContents: string[] = [];
  const modelTypes: string[] = [];
  for (const d of details) {
    const spec = d.spec as { config_contents?: string[]; model_types?: string[] } | undefined;
    configContents.push(...(spec?.config_contents ?? []));
    modelTypes.push(...(spec?.model_types ?? []));
  }
  const seeded = seedFromJobSpec({ config_contents: configContents, model_types: modelTypes });
  if (!seeded) return null;
  const labelsPath = details[0]?.labelsPath;
  if (!labelsPath) return null;
  return { labelsPath, modelType: seeded.modelType, configs: seeded.configs };
}

export interface NewJobWizardSeed {
  labelsPath: string;
  modelType: ModelType;
  configs: ConfigFile[];
}

export interface NewJobWizardProps {
  workerId: string;
  workerLabel: string;
  /** Pre-fills labels + config from a past run ("Run again", §5b.3) — the user can still change everything before submitting. */
  seed?: NewJobWizardSeed | null;
  onClose: () => void;
  /** Called after each successful submit, so `WorkerJobs` can refresh its job list. */
  onSubmitted?: () => void;
}

type StartFrom = "past" | "yaml" | "defaults";
type JobKind = "train" | "inference";
/** `RemoteFileBrowser` is shared by every browse target this wizard has — a worker-side `.slp` (train or inference), a training YAML, (Inference's Models step) a model folder, or (an unresolved video's "Locate on worker…") a video file. */
type BrowseTarget = "slp" | "yaml" | "model" | "locate";

/**
 * Per-video resolution summary lines for videos that needed something other
 * than their recorded path — "N video(s) found via a remembered location"
 * (a saved path rule) / "found next to the labels file" (SLEAP's usual
 * "videos live beside the .slp" layout). A video found at its exact recorded
 * path, or embedded, says nothing (matches the long-standing silent-when-fine
 * behavior). Exported for direct testing.
 */
export function summarizeVideoCheck(check: WorkerFileVideoCheck[]): string[] {
  const countVia = (via: WorkerFileVideoCheck["via"]) => check.filter((v) => v.via === via).length;
  const lines: string[] = [];
  const ruleCount = countVia("rule");
  if (ruleCount > 0) {
    lines.push(`${ruleCount} video${ruleCount === 1 ? "" : "s"} found via a remembered location`);
  }
  const nextToCount = countVia("next-to-labels");
  if (nextToCount > 0) {
    lines.push(`${nextToCount} video${nextToCount === 1 ? "" : "s"} found next to the labels file`);
  }
  return lines;
}

interface PastRun {
  runId: string;
  jobIds: string[];
  label: string;
}

/**
 * A training run on this worker whose EVERY sibling job (by `run.count`, not
 * just however many happen to be `completed`) has finished — the Inference
 * flow's "Models" step only offers these, since `buildRunInferenceSpecs`
 * needs every sibling's own trained model dir (a split top-down run's
 * centroid + centered_instance) and there's nowhere to get a still-running
 * sibling's dir from. Distinct from `PastRun` (used by "Start config from a
 * past job", Train-only): that one's fine with a lone finished job even when
 * a sibling is still running.
 */
interface CompletedRun {
  runId: string;
  jobIds: string[];
  /** Each sibling's own head type, in `run.index` order — `inferModelType`'s input. */
  modelTypes: string[];
  labelsPath: string;
  createdAt: string;
}

/**
 * Groups `jobs` (a worker's full `listJobs` result) into {@link CompletedRun}s
 * for the Inference flow's "Models" step — pure so the "every sibling
 * completed" rule is directly unit-testable. A job without `run` is its own
 * one-job run (`run.count` defaults to 1). A run is included only once EVERY
 * sibling `run.count` expects is present in `jobs` AND `completed` — a
 * top-down run with its centered_instance job still `running`/`queued` (or
 * missing from `jobs` entirely) is left out, not offered with a partial
 * model set.
 */
export function groupCompletedRuns(jobs: JobSummary[]): CompletedRun[] {
  const byRun = new Map<string, JobSummary[]>();
  for (const j of jobs) {
    if (j.kind !== "train") continue;
    const key = j.run?.id ?? j.jobId;
    byRun.set(key, [...(byRun.get(key) ?? []), j]);
  }
  const runs: CompletedRun[] = [];
  for (const [runId, runJobs] of byRun.entries()) {
    const expectedCount = runJobs[0]?.run?.count ?? 1;
    if (runJobs.length < expectedCount) continue;
    if (!runJobs.every((j) => j.state === "completed")) continue;
    const sorted = [...runJobs].sort((a, b) => (a.run?.index ?? 0) - (b.run?.index ?? 0));
    const last = sorted[sorted.length - 1]!;
    runs.push({
      runId,
      jobIds: sorted.map((j) => j.jobId),
      modelTypes: sorted.map((j) => j.modelTypes[0] ?? "model"),
      labelsPath: sorted[0]?.labelsPath ?? "",
      createdAt: last.createdAt,
    });
  }
  return runs;
}

export function NewJobWizard({ workerId, workerLabel, seed, onClose, onSubmitted }: NewJobWizardProps) {
  const clientFor = useConnectStore((s) => s.clientFor);
  const listJobs = useConnectStore((s) => s.listJobs);
  const jobDetail = useConnectStore((s) => s.jobDetail);
  const mountsFor = useConnectStore((s) => s.mountsFor);
  const submitJobsOn = useConnectStore((s) => s.submitJobsOn);
  const addPathRule = useConnectStore((s) => s.addPathRule);

  const [jobKind, setJobKind] = useState<JobKind>("train");

  const [mounts, setMounts] = useState<string[]>([]);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [browserTarget, setBrowserTarget] = useState<BrowseTarget>("slp");
  /** Which unresolved video's "Locate on worker…" opened the browser — read by its `onSelect` when `browserTarget === "locate"`. */
  const [browsingVideoIndex, setBrowsingVideoIndex] = useState<number | null>(null);

  const [labelsPath, setLabelsPath] = useState<string | null>(seed?.labelsPath ?? null);
  const [labels, setLabels] = useState<Labels | null>(null);
  const [loadingLabels, setLoadingLabels] = useState(false);
  const [labelsError, setLabelsError] = useState<string | null>(null);
  const [videoCheck, setVideoCheck] = useState<WorkerFileVideoCheck[] | null>(null);

  const [modelType, setModelType] = useState<ModelType>(seed?.modelType ?? "top_down");
  const [configs, setConfigs] = useState<ConfigFile[]>(
    () => seed?.configs ?? defaultConfigsFor(seed?.modelType ?? "top_down"),
  );
  const [startFrom, setStartFrom] = useState<StartFrom>(seed ? "past" : "defaults");
  const [pastRuns, setPastRuns] = useState<PastRun[]>([]);
  const [seedingFromPast, setSeedingFromPast] = useState(false);
  const [configDialogOpen, setConfigDialogOpen] = useState(false);

  const [postInferenceEnabled, setPostInferenceEnabled] = useState(false);
  const [inferenceTarget, setInferenceTarget] = useState("suggestions");
  const [sampleCount, setSampleCount] = useState(20);

  // Inference flow's "Models" step: completed runs to pick from, the
  // currently-chosen model dir(s) (from a picked run, manually browsed
  // folders, or both), and the head types behind them (just for
  // inferModelType's cosmetic `pipeline` guess — see its own doc).
  const [completedRuns, setCompletedRuns] = useState<CompletedRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [loadingRunModels, setLoadingRunModels] = useState(false);
  const [modelDirs, setModelDirs] = useState<string[]>([]);
  const [modelHeadTypes, setModelHeadTypes] = useState<string[]>([]);

  const [submitting, setSubmitting] = useState(false);
  const [justSubmitted, setJustSubmitted] = useState(false);

  // TrainingConfigDialog's own post-training-inference controls (target/
  // sample-count/skip-user-labeled/existing-predictions) are hidden entirely
  // in mode="worker-file" (this wizard owns that toggle + its own restricted
  // target list instead — see the dialog's own doc on why), so the inferenceTarget/
  // sampleCount/skipUserLabeled/existingPredictions props below are supplied
  // as plain literals: unreachable, nothing renders that could read or write
  // them. W&B auto-open and export format/use-for-inference stay visible
  // regardless of mode (not post-training-inference controls), so those keep
  // real state.
  const [dlgAutoOpenWandb, setDlgAutoOpenWandb] = useState(false);
  const [dlgExportFormat, setDlgExportFormat] = useState<"none" | "onnx" | "tensorrt">("none");
  const [dlgUseExportedForInference, setDlgUseExportedForInference] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void mountsFor(workerId)
      .then((m) => {
        if (!cancelled) setMounts(m.map((x) => x.path));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workerId, mountsFor]);

  useEffect(() => {
    let cancelled = false;
    void listJobs(workerId)
      .then((jobs) => {
        if (cancelled) return;
        const trains = jobs.filter((j) => j.kind === "train" && j.state === "completed");
        const byRun = new Map<string, typeof trains>();
        for (const j of trains) {
          const key = j.run?.id ?? j.jobId;
          byRun.set(key, [...(byRun.get(key) ?? []), j]);
        }
        const runs: PastRun[] = Array.from(byRun.entries()).map(([runId, runJobs]) => {
          const sorted = [...runJobs].sort((a, b) => (a.run?.index ?? 0) - (b.run?.index ?? 0));
          return {
            runId,
            jobIds: sorted.map((j) => j.jobId),
            label: `Train ${sorted.map((j) => j.modelTypes[0] ?? "model").join(" + ")}`,
          };
        });
        setPastRuns(runs);
        setCompletedRuns(groupCompletedRuns(jobs));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [workerId, listJobs]);

  const loadLabels = useMemo(
    () => async (path: string) => {
      setLabelsPath(path);
      setLabels(null);
      setVideoCheck(null);
      setLabelsError(null);
      setLoadingLabels(true);
      try {
        const client = await clientFor(workerId);
        const loaded = await loadWorkerLabels(client, path);
        setLabels(loaded);
        const check = await checkWorkerFileVideos(client, loaded, path, pathRulesFor(workerId));
        setVideoCheck(check);
      } catch (err) {
        setLabelsError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoadingLabels(false);
      }
    },
    [clientFor, workerId],
  );

  // A "Run again" seed's own labels path auto-loads once, on open.
  useEffect(() => {
    if (seed?.labelsPath) void loadLabels(seed.labelsPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * "Locate on worker…" for one unresolved video (`RemoteFileBrowser`'s
   * `onSelect` when `browserTarget === "locate"`): saves a path rule from
   * the recorded path to the one the user just picked (same convention the
   * Training panel's own Locate flow uses, `remoteVisibility.ts`'s
   * `inferRuleFromLocate`), then re-runs `checkWorkerFileVideos` against the
   * already-loaded `labels` — no need to re-fetch the worker's own `.slp`
   * structure just to pick up one new rule.
   */
  const handleLocateVideo = async (index: number, pickedPath: string) => {
    if (!labels || !labelsPath || !videoCheck) return;
    const recorded = videoCheck.find((v) => v.index === index)?.path;
    if (recorded === undefined) return;
    addPathRule(workerId, inferRuleFromLocate(recorded, pickedPath));
    try {
      const client = await clientFor(workerId);
      const check = await checkWorkerFileVideos(client, labels, labelsPath, pathRulesFor(workerId));
      setVideoCheck(check);
    } catch (err) {
      setLabelsError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleModelTypeChange = (mt: ModelType) => {
    setModelType(mt);
    if (startFrom === "defaults") setConfigs(defaultConfigsFor(mt));
  };

  const chooseDefaults = () => {
    setStartFrom("defaults");
    setConfigs(defaultConfigsFor(modelType));
  };

  const choosePastRun = async (run: PastRun) => {
    setStartFrom("past");
    setSeedingFromPast(true);
    try {
      const seeded = await seedWizardFromRun(jobDetail, workerId, run.jobIds);
      if (!seeded) {
        toast.error("Couldn't read that job's configuration.");
        return;
      }
      setModelType(seeded.modelType);
      setConfigs(seeded.configs);
      void loadLabels(seeded.labelsPath);
    } catch (err) {
      toast.error("Couldn't read that job's configuration.", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSeedingFromPast(false);
    }
  };

  const chooseYaml = () => {
    setStartFrom("yaml");
    setBrowserTarget("yaml");
    setBrowserOpen(true);
  };

  const handleYamlPicked = async (path: string) => {
    try {
      const client = await clientFor(workerId);
      const text = await readWholeWorkerFile(client, path);
      const slot = getConfigSlots(modelType)[0] ?? "config";
      const { parseYamlConfig } = useTrainingStore.getState();
      const parsed = parseYamlConfig(text, basename(path), slot);
      if (!parsed) {
        toast.error("Couldn't parse that YAML file.");
        return;
      }
      setConfigs((prev) => [...prev.filter((c) => c.slot !== slot), parsed]);
    } catch (err) {
      toast.error("Couldn't read that file.", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  };

  /** Inference flow's "Models" step: fetches each sibling's own trained model dir (`jobDetail(...).result.model_dir`, `run.index` order) and replaces `modelDirs` with the run's own — mirrors the removed `WorkerJobs` row action's `RunInferenceDialog`. */
  const chooseModelsFromRun = async (run: CompletedRun) => {
    setSelectedRunId(run.runId);
    setLoadingRunModels(true);
    try {
      const details = await Promise.all(run.jobIds.map((id) => jobDetail(workerId, id)));
      const dirs = details
        .map((d) => (d.result as { model_dir?: string } | null)?.model_dir)
        .filter((d): d is string => !!d);
      if (dirs.length !== run.jobIds.length) {
        toast.error("Couldn't find this run's trained model(s).");
        setSelectedRunId(null);
        return;
      }
      setModelDirs(dirs);
      setModelHeadTypes(run.modelTypes);
    } catch (err) {
      toast.error("Couldn't read that job's configuration.", {
        description: err instanceof Error ? err.message : String(err),
      });
      setSelectedRunId(null);
    } finally {
      setLoadingRunModels(false);
    }
  };

  /** Manually browsed model folder (directory mode) — appended rather than replacing, since a split top-down run needs two. Deselects any picked run: the list no longer reflects that run's own dirs alone. */
  const handleModelFolderPicked = (path: string) => {
    setModelDirs((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setSelectedRunId(null);
  };

  const removeModelDir = (path: string) => {
    setModelDirs((prev) => prev.filter((d) => d !== path));
    setSelectedRunId(null);
  };

  const onUpdateSlot = (slot: string, updates: Partial<ConfigHyperparams>) =>
    setConfigs((prev) =>
      prev.map((c) => (c.slot === slot ? { ...c, hyperparams: { ...c.hyperparams, ...updates } } : c)),
    );

  const configActions: TrainingConfigActions = useMemo(
    () => ({
      addConfigFile: (file) => setConfigs((prev) => [...prev.filter((c) => c.slot !== file.slot), file]),
      updateConfigCheckpointPath: (slot, path) =>
        setConfigs((prev) => prev.map((c) => (c.slot === slot ? { ...c, checkpointPath: path } : c))),
      resetConfigHyperparams: (slot) =>
        setConfigs((prev) =>
          prev.map((c) => (c.slot === slot ? { ...c, hyperparams: { ...c.originalHyperparams } } : c)),
        ),
    }),
    [],
  );

  const missingVideos = videoCheck?.filter((v) => !v.found) ?? [];
  const allVideosFound = videoCheck != null && missingVideos.length === 0;
  // At least one video only resolved via a remembered rule or next-to-labels
  // (workerLabels.ts's needsLabelsRepoint) — its .slp-recorded path isn't one
  // the worker (or sleap-nn running on it) can actually open, so the job
  // needs re-pointed labels_content instead of a bare labels_path.
  const needsRepoint = needsLabelsRepoint(videoCheck ?? []);
  const slots = getConfigSlots(modelType);
  const configsReady = slots.every((slot) => configs.some((c) => c.slot === slot));
  const canSubmit = !!labels && !!labelsPath && allVideosFound && configsReady && !submitting;
  // Inference needs the videos too (it reads them, not just the .slp's
  // metadata) — same allVideosFound gate as Train. Unlike Train, a
  // TrackJobSpec has no labels_content concept at all (sleap-connect's
  // `_materialize_labels_content` is a no-op for it), so re-pointed videos
  // block Inference outright instead of being sent inline.
  const canSubmitInference =
    !!labels && !!labelsPath && allVideosFound && !needsRepoint && modelDirs.length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!labels || !labelsPath) return;
    setSubmitting(true);
    try {
      let labelsContent: string | null = null;
      if (needsRepoint && videoCheck) {
        const { buildRemoteLabelsPayload } = await import("@/lib/remoteLabelsPayload");
        const visibility = videoChecksToVisibility(videoCheck);
        const payload = await buildRemoteLabelsPayload(labels, visibility, { embedFramesToPredict: false });
        labelsContent = payload.labelsContent;
      }
      const postInference = postInferenceEnabled
        ? buildPostTrainingInferenceConfig({
            modelType,
            modelPaths: [], // filled in by the worker once training finishes (sleap-connect PR5w) — see buildLauncherTrainSpec's post_inference doc.
            inferenceTarget,
            videoIndex: "all",
            sampleCount,
          })
        : null;
      const spec = buildLauncherTrainSpec({
        labels,
        labelsPath,
        labelsContent,
        modelType,
        configs,
        postInference,
        project: projectTag(labelsPath),
      });
      await submitJobsOn(workerId, spec, { source: "worker-file" });
      toast.success(`Added to ${workerLabel} queue`, {
        description: `Train ${modelType.replace(/_/g, " ")} on ${basename(labelsPath)}`,
      });
      onSubmitted?.();
      setJustSubmitted(true);
    } catch (err) {
      toast.error("Couldn't submit job", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  /** Submits standalone track job(s) against `modelDirs` — unlike `handleSubmit`'s `post_inference` (chained by the worker once training finishes), these model dirs are already known, so this calls `submitJobsOn` directly per spec `buildRunInferenceSpecs` returns (one, except "random sample", which returns one per video — see its own doc). */
  const handleSubmitInference = async () => {
    if (!labels || !labelsPath || modelDirs.length === 0) return;
    setSubmitting(true);
    try {
      const config = buildPostTrainingInferenceConfig({
        modelType: inferModelType(modelHeadTypes) ?? "top_down",
        modelPaths: modelDirs,
        inferenceTarget,
        videoIndex: "all",
        sampleCount,
      });
      const specs = buildRunInferenceSpecs(labelsPath, modelDirs, config, labels);
      for (const spec of specs) {
        await submitJobsOn(workerId, spec, { source: "worker-file" });
      }
      toast.success(`Added to ${workerLabel} queue`, {
        description: `Inference on ${basename(labelsPath)}`,
      });
      onSubmitted?.();
      setJustSubmitted(true);
    } catch (err) {
      toast.error("Couldn't submit inference job", {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="sm:max-w-[560px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-sm">New job on {workerLabel}</DialogTitle>
          <DialogDescription className="text-xs">
            Starts a job on data that already lives on this worker.
          </DialogDescription>
        </DialogHeader>

        {justSubmitted ? (
          <div className="space-y-3">
            <div className="rounded-md border border-green-800 bg-green-950/40 p-3 text-xs text-green-300">
              Added to {workerLabel}&apos;s queue.
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setJustSubmitted(false)}>
                Add another
              </Button>
              <Button onClick={onClose}>Done</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex gap-1.5">
              <Button
                variant="outline"
                size="sm"
                className={`flex-1 h-7 text-xs ${jobKind === "train" ? "border-primary" : ""}`}
                onClick={() => setJobKind("train")}
              >
                Train
              </Button>
              <Button
                variant="outline"
                size="sm"
                className={`flex-1 h-7 text-xs ${jobKind === "inference" ? "border-primary" : ""}`}
                onClick={() => setJobKind("inference")}
              >
                Inference
              </Button>
            </div>

            <div className="space-y-1.5">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                Labels (on {workerLabel})
              </p>
              <div className="flex gap-2">
                <div className="flex-1 flex items-center h-8 px-2.5 border border-border rounded-md bg-muted/30 font-mono text-xs truncate">
                  {labelsPath ?? "No file selected"}
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setBrowserTarget("slp");
                    setBrowserOpen(true);
                  }}
                >
                  Browse…
                </Button>
              </div>
              {loadingLabels && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Reading worker file…
                </div>
              )}
              {labelsError && <p className="text-xs text-red-400">{labelsError}</p>}
              {labels && !loadingLabels && (
                <p className="text-xs text-muted-foreground">
                  {labels.skeletons[0]?.name ?? "Skeleton"} · {labels.videos.length} video
                  {labels.videos.length === 1 ? "" : "s"} · {labels.labeledFrames.length} labeled frame
                  {labels.labeledFrames.length === 1 ? "" : "s"}
                </p>
              )}
              {videoCheck && !loadingLabels && (
                <>
                  {summarizeVideoCheck(videoCheck).map((line) => (
                    <p key={line} className="text-xs text-muted-foreground">
                      {line}
                    </p>
                  ))}
                  {missingVideos.length > 0 && (
                    <div className="space-y-1">
                      <p className="text-xs text-yellow-400">
                        {missingVideos.length} of {videoCheck.length} video{videoCheck.length === 1 ? "" : "s"} not
                        found on {workerLabel}:
                      </p>
                      {missingVideos.map((v) => (
                        <div
                          key={v.index}
                          className="flex items-center gap-2 h-7 px-2 border border-border rounded-md bg-muted/30 font-mono text-[11px]"
                        >
                          <span className="flex-1 truncate">{basename(v.path)}</span>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 shrink-0 px-2 text-[11px] font-sans"
                            onClick={() => {
                              setBrowsingVideoIndex(v.index);
                              setBrowserTarget("locate");
                              setBrowserOpen(true);
                            }}
                          >
                            Locate on worker…
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                  {jobKind === "inference" && needsRepoint && (
                    <p className="text-xs text-yellow-400">
                      Videos in this file point to another computer; inference can&apos;t send re-pointed labels
                      inline the way training can. Use &quot;Locate on worker…&quot; above to point every video at a
                      path already on {workerLabel}, or run Train on this file instead.
                    </p>
                  )}
                </>
              )}
            </div>

            {jobKind === "train" ? (
              <>
                <div className="space-y-1.5">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    Model type
                  </p>
                  <Select value={modelType} onValueChange={(v) => handleModelTypeChange(v as ModelType)}>
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MODEL_TYPE_OPTIONS.map((o) => (
                        <SelectItem key={o.value} value={o.value}>
                          {o.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    Start config from
                  </p>
                  <div className="space-y-1">
                    {pastRuns.map((run) => (
                      <Button
                        key={run.runId}
                        variant="outline"
                        size="sm"
                        className={`w-full justify-start h-8 text-xs ${startFrom === "past" ? "border-primary" : ""}`}
                        disabled={seedingFromPast}
                        onClick={() => void choosePastRun(run)}
                      >
                        Past job: {run.label}
                      </Button>
                    ))}
                    <Button
                      variant="outline"
                      size="sm"
                      className={`w-full justify-start h-8 text-xs ${startFrom === "yaml" ? "border-primary" : ""}`}
                      onClick={chooseYaml}
                    >
                      YAML on {workerLabel}…
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className={`w-full justify-start h-8 text-xs ${startFrom === "defaults" ? "border-primary" : ""}`}
                      onClick={chooseDefaults}
                    >
                      Defaults for {MODEL_TYPE_OPTIONS.find((o) => o.value === modelType)?.label}
                    </Button>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 text-xs"
                    disabled={!labels || !configsReady}
                    onClick={() => setConfigDialogOpen(true)}
                  >
                    Edit hyperparameters…
                  </Button>
                  {!labels && (
                    <p className="text-[10px] text-muted-foreground">Pick a labels file first</p>
                  )}
                </div>

                <div className="space-y-1.5">
                  <label className="flex items-center gap-2 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={postInferenceEnabled}
                      onChange={(e) => setPostInferenceEnabled(e.target.checked)}
                    />
                    Run inference after training
                  </label>
                  {postInferenceEnabled && (
                    <div className="flex items-center gap-2 pl-5">
                      <Select value={inferenceTarget} onValueChange={setInferenceTarget}>
                        <SelectTrigger className="h-7 text-xs w-56">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {WORKER_FILE_INFERENCE_TARGETS.map((o) => (
                            <SelectItem key={o.value} value={o.value}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      {inferenceTarget === "random" && (
                        <Input
                          type="number"
                          min={1}
                          value={sampleCount}
                          onChange={(e) => setSampleCount(Math.max(1, Number(e.target.value)))}
                          className="h-7 text-xs w-20"
                        />
                      )}
                    </div>
                  )}
                </div>

                {labels && labelsPath && (
                  <div className="flex flex-col gap-1 rounded-md border border-border bg-muted/30 p-2.5 text-xs">
                    <span>
                      {MODEL_TYPE_OPTIONS.find((o) => o.value === modelType)?.label} · {configs.length} config
                      {configs.length === 1 ? "" : "s"}
                    </span>
                    <span className="text-muted-foreground font-mono truncate">Labels: {labelsPath}</span>
                    <span className="text-muted-foreground">
                      Then: {postInferenceEnabled
                        ? `inference on ${WORKER_FILE_INFERENCE_TARGETS.find((o) => o.value === inferenceTarget)?.label.toLowerCase()}`
                        : "nothing"}
                    </span>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="space-y-1.5">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Models</p>
                  <div className="space-y-1">
                    {completedRuns.map((run) => (
                      <Button
                        key={run.runId}
                        variant="outline"
                        size="sm"
                        className={`w-full justify-start h-8 text-xs ${selectedRunId === run.runId ? "border-primary" : ""}`}
                        disabled={loadingRunModels}
                        onClick={() => void chooseModelsFromRun(run)}
                      >
                        {run.modelTypes.join(" + ")} · {basename(run.labelsPath) || "—"} · {timeAgo(run.createdAt)}
                      </Button>
                    ))}
                    <Button
                      variant="outline"
                      size="sm"
                      className="w-full justify-start h-8 text-xs"
                      onClick={() => {
                        setBrowserTarget("model");
                        setBrowserOpen(true);
                      }}
                    >
                      Browse model folder on {workerLabel}…
                    </Button>
                  </div>
                  {modelDirs.length > 0 && (
                    <div className="space-y-1">
                      {modelDirs.map((dir) => (
                        <div
                          key={dir}
                          className="flex items-center gap-2 h-7 px-2 border border-border rounded-md bg-muted/30 font-mono text-[11px]"
                        >
                          <span className="flex-1 truncate">{dir}</span>
                          <button
                            type="button"
                            aria-label={`Remove ${dir}`}
                            className="text-muted-foreground hover:text-foreground shrink-0"
                            onClick={() => removeModelDir(dir)}
                          >
                            &times;
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-1.5">
                  <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    Inference on
                  </p>
                  <div className="flex items-center gap-2">
                    <Select value={inferenceTarget} onValueChange={setInferenceTarget}>
                      <SelectTrigger className="h-8 text-xs flex-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {WORKER_FILE_INFERENCE_TARGETS.map((o) => (
                          <SelectItem key={o.value} value={o.value}>
                            {o.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {inferenceTarget === "random" && (
                      <Input
                        type="number"
                        min={1}
                        value={sampleCount}
                        onChange={(e) => setSampleCount(Math.max(1, Number(e.target.value)))}
                        className="h-8 text-xs w-20"
                      />
                    )}
                  </div>
                </div>

                {labels && labelsPath && (
                  <div className="flex flex-col gap-1 rounded-md border border-border bg-muted/30 p-2.5 text-xs">
                    <span>
                      Inference · {modelDirs.length} model dir{modelDirs.length === 1 ? "" : "s"}
                    </span>
                    <span className="text-muted-foreground font-mono truncate">Labels: {labelsPath}</span>
                    <span className="text-muted-foreground">
                      On: {WORKER_FILE_INFERENCE_TARGETS.find((o) => o.value === inferenceTarget)?.label.toLowerCase()}
                    </span>
                  </div>
                )}
              </>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                disabled={jobKind === "train" ? !canSubmit : !canSubmitInference}
                onClick={() => void (jobKind === "train" ? handleSubmit() : handleSubmitInference())}
              >
                {submitting ? "Adding…" : "Add to queue"}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>

      <RemoteFileBrowser
        open={browserOpen}
        onClose={() => setBrowserOpen(false)}
        onSelect={(path) => {
          if (browserTarget === "slp") void loadLabels(path);
          else if (browserTarget === "yaml") void handleYamlPicked(path);
          else if (browserTarget === "locate") {
            if (browsingVideoIndex !== null) void handleLocateVideo(browsingVideoIndex, path);
          } else handleModelFolderPicked(path);
        }}
        mounts={mounts}
        workerId={workerId}
        mode={browserTarget === "model" ? "directory" : "file"}
        fileFilter={browserTarget === "slp" ? ".slp" : browserTarget === "yaml" ? ".yaml" : undefined}
      />

      {configDialogOpen && labels && (
        <TrainingConfigDialog
          open={configDialogOpen}
          onClose={() => setConfigDialogOpen(false)}
          modelType={modelType}
          configs={configs}
          onUpdateSlot={onUpdateSlot}
          configActions={configActions}
          labelsOverride={labels}
          mode="worker-file"
          // Unreachable: TrainingConfigDialog hides its post-training-
          // inference controls entirely in mode="worker-file" (this wizard's
          // own toggle below owns that instead), so nothing ever reads or
          // calls these.
          inferenceTarget="nothing"
          onInferenceTargetChange={() => {}}
          remoteEnabled={false}
          onRemoteEnabledChange={() => {}}
          sampleCount={20}
          onSampleCountChange={() => {}}
          skipUserLabeled={false}
          onSkipUserLabeledChange={() => {}}
          existingPredictions="replace"
          onExistingPredictionsChange={() => {}}
          autoOpenWandb={dlgAutoOpenWandb}
          onAutoOpenWandbChange={setDlgAutoOpenWandb}
          exportFormat={dlgExportFormat}
          onExportFormatChange={setDlgExportFormat}
          useExportedForInference={dlgUseExportedForInference}
          onUseExportedForInferenceChange={setDlgUseExportedForInference}
        />
      )}
    </Dialog>
  );
}
