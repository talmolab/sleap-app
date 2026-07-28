/**
 * Active-Learning panel (issue #212): define the workflow config and drive the
 * Phase-1 loop — add starter frames, seed centroids (one click each), train a
 * centroid locator, then run it to predict centroids on the rest.
 *
 * This panel orchestrates; it doesn't do compute. Training/inference run
 * through the existing Training/Inference stores. "Dashboard + next-action": it
 * recommends steps but never gates.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppStore } from "../../stores/appStore";
import { useActiveLearningStore } from "../../stores/activeLearningStore";
import { useTrainingStore } from "../../stores/trainingStore";
import { useInferenceStore, centroidInferenceConfig } from "../../stores/inferenceStore";
import { configFromSkeleton } from "@/lib/activeLearning/config";
import { startCentroidLocatorTraining } from "@/lib/activeLearning/trainLocator";
import { rejectCurrentPassItem, skipCurrentPassItem } from "@/lib/activeLearning/passActions";
import {
  buildWorkList,
  passDims,
  nodeIndicesForPass,
  linearIndex,
  totalSteps,
  countSeededCentroids,
} from "@/lib/activeLearning/passEngine";
import type { Skeleton } from "@talmolab/sleap-io.js";
import { sampleFramesAcrossVideos } from "@/lib/suggestionStrategies";
import { commandContext, AddNodeCommand, PairPoseInstances } from "@/commands";
import { toast } from "@/lib/notify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ActiveLearningConfigDialog } from "@/components/dialogs/ActiveLearningConfigDialog";
import { CorrectionPanel } from "@/components/panels/CorrectionPanel";
import { cn } from "@/lib/utils";

/** Last path segment of a model directory, for a compact display. */
function modelBasename(path: string): string {
  const parts = path.replace(/[/\\]+$/, "").split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

export function ActiveLearningPanel() {
  const projectLoaded = useAppStore((s) => s.projectLoaded);
  const skeleton = useAppStore((s) => s.skeleton);
  const labelingMode = useAppStore((s) => s.labelingMode);
  const config = useActiveLearningStore((s) => s.config);
  const validation = useActiveLearningStore((s) => s.validation);
  const round = useActiveLearningStore((s) => s.round);
  const phase = useActiveLearningStore((s) => s.phase);
  // Label edits bump overlayVersion (see the seed click branch in VideoPlayer),
  // so it's our reactive trigger for recounting seeded centroids.
  const overlayVersion = useAppStore((s) => s.overlayVersion);
  const trainingStatus = useTrainingStore((s) => s.status);
  const modelDirs = useTrainingStore((s) => s.modelOutputDirs);
  const inferenceStatus = useInferenceStore((s) => s.status);
  // Phase-2 pass-engine state.
  const passCursor = useAppStore((s) => s.passCursor);
  const passDimsState = useAppStore((s) => s.passDims);
  const passZoomWindow = useAppStore((s) => s.passZoomWindow);
  // Reject is only meaningful on a locator detection, so the button only shows
  // when the cursor is parked on one.
  const currentItemPredicted = useAppStore(
    (s) => s.passWorkList[s.passCursor?.itemIdx ?? -1]?.predicted ?? false,
  );

  const fileRef = useRef<HTMLInputElement>(null);
  const seedCountRef = useRef<HTMLInputElement>(null);
  // Explicitly-picked centroid-model dir (survives restarts / new machines,
  // where this-session training state is empty). Falls back to the last model
  // trained this session.
  const [selectedModelDir, setSelectedModelDir] = useState<string | null>(null);
  const [configDialogOpen, setConfigDialogOpen] = useState(false);

  const nodeNames = skeleton?.nodes.map((n) => n.name);

  // Whether the Phase-2 sweep visits the locator's detections as well as human
  // seeds. Panel-local (like the correction setup fields): "Resume" rebuilds the
  // work list and `passJumpToUnlabeled` re-finds the first undecided point, so
  // the list needn't be byte-identical across starts. Declared HERE because the
  // seeded/labelable count below reads it during render.
  const [includePredicted, setIncludePredicted] = useState(true);

  // Live count of seeded frames/centroids (config-aware: with separate centroid
  // annotations only seeded `frame.centroids` count, so pose labels and the
  // paired empty pose instances never inflate it), and whether a suggested-frame
  // pool exists to seed on.
  const { seededFrames, seededCentroids, labelableCentroids, hasSuggestions, videoCount } = useMemo(() => {
    const labels = useAppStore.getState().labels;
    if (!labels) {
      return {
        seededFrames: 0,
        seededCentroids: 0,
        labelableCentroids: 0,
        hasSuggestions: false,
        videoCount: 0,
      };
    }
    // Two different questions. `seeded*` = human work, which is what gates
    // locator TRAINING (a prediction must never count toward "enough labels to
    // train on"). `labelable` = what the Phase-2 sweep would actually visit,
    // which includes the locator's detections when the sweep is set to.
    const { frames, centroids } = countSeededCentroids(labels, config);
    const labelable = countSeededCentroids(labels, config, { includePredicted }).centroids;
    return {
      seededFrames: frames,
      seededCentroids: centroids,
      labelableCentroids: labelable,
      hasSuggestions: labels.suggestions.length > 0,
      videoCount: labels.videos.length,
    };
    // overlayVersion drives the recount; labels is mutated in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayVersion, projectLoaded, config, includePredicted]);

  const trainThreshold = config?.localize.trainAfter ?? 100;
  const trainingRunning = trainingStatus === "running";
  const trainingDone = trainingStatus === "completed";
  const isSeeding = labelingMode === "seed";
  const isKeypointPass = labelingMode === "keypointPass";
  const isCorrecting = labelingMode === "correct";

  // Tab strip. "Correct" is deliberately NOT gated on `config`: the correction
  // sweep works on any project holding scored predictions, with or without an
  // active-learning workflow (that's the whole point of it being decoupled).
  const [tab, setTab] = useState("setup");
  const AL_TABS = [
    { value: "setup", label: "Setup", disabled: false },
    { value: "localize", label: "Localize", disabled: !config },
    { value: "keypoints", label: "Keypoints", disabled: !config },
    { value: "correct", label: "Correct", disabled: false },
  ];
  // Entering the sweep (from here, the top bar, or a shortcut) reveals the tab
  // that doubles as the live per-keypoint confidence readout.
  useEffect(() => {
    if (isCorrecting) setTab("correct");
  }, [isCorrecting]);
  // The model the locator runs on: an explicit pick wins, else the most recent
  // model trained this session.
  const effectiveModelDir = selectedModelDir ?? modelDirs[modelDirs.length - 1] ?? null;

  // The single recommended next step. Exactly one panel button is highlighted
  // (filled); everything else is a quiet outline, so the user always knows what
  // to click next. While actively seeding, the Seed button itself is the lit
  // one (it shows the active mode), so nothing else competes.
  type NextAction = "add-frames" | "seed" | "train" | "predict-centroids";
  const nextAction: NextAction =
    seededFrames === 0 && !hasSuggestions
      ? "add-frames"
      : seededFrames < trainThreshold
        ? "seed"
        : trainingRunning
          ? "seed"
          : trainingDone
            ? "predict-centroids"
            : "train";
  const primaryIs = (a: NextAction) => !isSeeding && nextAction === a;

  const adoptFromSkeleton = () => {
    if (!nodeNames || nodeNames.length === 0) {
      toast.error("This project has no skeleton nodes yet");
      return;
    }
    const result = useActiveLearningStore
      .getState()
      .setConfig(configFromSkeleton(nodeNames), nodeNames);
    if (result.ok) {
      toast.success(
        `Started a workflow from ${nodeNames.length} skeleton nodes — split "Keypoints" into ` +
          "ordered passes and set the centroid in the .yaml as you like",
      );
    } else {
      toast.warning(`Workflow loaded with ${result.errors.length} issue(s) — see below`);
    }
  };

  const adoptDefault = () => {
    const result = useActiveLearningStore.getState().useDefaultConfig(nodeNames);
    if (result.ok) toast.success("Adopted the default workflow");
    else toast.warning(`Workflow loaded with ${result.errors.length} issue(s) — see below`);
  };

  // Materialize a free "centroid" anchor and point the config at it, returning
  // the seed target ({ skeleton, nodeIdx }) or null. Two flavors:
  //  - separate=true: a first-class centroid annotation — seeds become
  //    `UserCentroid`s on `frame.centroids`, separate from the pose keypoints;
  //    the pose skeleton is left untouched.
  //  - separate=false: a synthetic "centroid" node added to the pose skeleton
  //    (grows every instance) and stripped from the passes.
  const ensureArbitraryAnchor = (
    separate: boolean,
  ): { skeleton: Skeleton; nodeIdx: number } | null => {
    const labels = useAppStore.getState().labels;
    const poseSkel = useAppStore.getState().skeleton;
    const currentConfig = useActiveLearningStore.getState().config;
    if (!labels || !poseSkel || !currentConfig) return null;
    const ANCHOR = "centroid";

    if (separate) {
      // First-class centroid annotations: NO dedicated skeleton. Seeds become
      // `UserCentroid`s on `frame.centroids` (see SeedCentroid), so we only need
      // to point the config at "centroid" mode. The returned target is a
      // success signal for callers; centroid seeding uses
      // enterSeedMode(centroidAnnotation=true), not this skeleton/nodeIdx.
      useActiveLearningStore.getState().setConfig(
        {
          ...currentConfig,
          localize: { ...currentConfig.localize, centroidNode: ANCHOR, separateCentroid: true },
        },
        poseSkel.nodes.map((n) => n.name),
      );
      useAppStore.getState().markChanged();
      useAppStore.getState().bumpOverlayVersion();
      return { skeleton: poseSkel, nodeIdx: 0 };
    }

    // AddNode also grows every existing instance's point array to match.
    if (!poseSkel.nodes.some((n) => n.name === ANCHOR)) {
      void commandContext.execute(AddNodeCommand, { name: ANCHOR });
    }
    const poseNow = useAppStore.getState().skeleton;
    if (!poseNow) return null;
    const names = poseNow.nodes.map((n) => n.name);
    useActiveLearningStore.getState().setConfig(
      {
        ...currentConfig,
        localize: { ...currentConfig.localize, centroidNode: ANCHOR, separateCentroid: false },
        labelKeypoints: {
          ...currentConfig.labelKeypoints,
          passes: currentConfig.labelKeypoints.passes
            .map((p) => ({ ...p, nodes: p.nodes.filter((n) => n !== ANCHOR) }))
            .filter((p) => p.nodes.length > 0),
        },
      },
      names,
    );
    useAppStore.getState().bumpOverlayVersion();
    return { skeleton: poseNow, nodeIdx: names.indexOf(ANCHOR) };
  };

  // Panel quick-link: switch to a separate first-class centroid annotation.
  // The pose-node anchor variant stays available via the config editor's
  // centroid picker.
  const useArbitraryCentroid = () => {
    if (!useActiveLearningStore.getState().config) {
      toast.error("Define a workflow first");
      return;
    }
    if (ensureArbitraryAnchor(true)) {
      toast.success(
        'Using a free "centroid" annotation — seed it anywhere; the pose skeleton stays all keypoints.',
      );
    }
  };

  const importYaml = async (file: File) => {
    try {
      const text = await file.text();
      const result = useActiveLearningStore.getState().loadConfigFromYaml(text, nodeNames);
      if (result.ok) toast.success(`Loaded workflow "${file.name}"`);
      else toast.warning(`Workflow loaded with ${result.errors.length} issue(s) — see below`);
    } catch (err) {
      toast.error(`Could not read workflow: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const addFrames = () => {
    const labels = useAppStore.getState().labels;
    if (!labels || labels.videos.length === 0) {
      toast.error("Open a project with a video first");
      return;
    }
    const count = Math.max(1, Number(seedCountRef.current?.value) || config?.localize.seedFrames || 200);
    // A TOTAL for the project, not a per-video count: `sampleFramesAcrossVideos`
    // splits the budget by video length, so a 3-video project gets `count`
    // frames rather than 3 × count.
    //
    // `spread` (stratified/jittered), not `random`: a seeding pool wants even
    // coverage of the whole recording. Sampling already excludes frames in the
    // pool, so each click ADDS a batch that interleaves with what's there.
    const added = sampleFramesAcrossVideos(labels, labels.videos, count, "spread");
    if (added.length === 0) {
      toast.error(
        "No frames to suggest — open a video (its length has to be known) or clear some of the existing pool.",
      );
      return;
    }
    labels.suggestions = [...(labels.suggestions ?? []), ...added];
    useAppStore.getState().markChanged();
    useAppStore.getState().bumpOverlayVersion();
    const short = added.length < count ? ` (${count} asked for; the rest are already queued)` : "";
    toast.success(
      `Added ${added.length} frames spread across ${labels.videos.length} video(s)${short} — press Space to step through them`,
    );
  };

  const toggleSeeding = () => {
    if (labelingMode === "seed") {
      useAppStore.getState().exitSeedMode();
      return;
    }
    if (!config || !skeleton) {
      toast.error("Define a workflow first");
      return;
    }
    // First-class centroid annotations: configure the "centroid" mode and seed
    // `UserCentroid`s on `frame.centroids` — no skeleton or node index involved.
    if (config.localize.separateCentroid) {
      ensureArbitraryAnchor(true);
      useAppStore.getState().enterSeedMode(undefined, true);
      toast.info(
        "Labeling centroids — click a body-center on each animal. Use the top bar (or Space) to advance frames.",
      );
      return;
    }

    // Resolve where seed clicks land: a synthetic pose "centroid" node or a
    // real pose node (NODE mode).
    let target: { skeleton: Skeleton; nodeIdx: number } | null;
    if (config.localize.centroidNode === null) {
      target = ensureArbitraryAnchor(false);
    } else {
      const idx = skeleton.nodes.findIndex((n) => n.name === config.localize.centroidNode);
      if (idx < 0) {
        toast.error(`Centroid node "${config.localize.centroidNode}" is not in the skeleton`);
        return;
      }
      target = { skeleton, nodeIdx: idx };
    }
    if (!target) {
      toast.error("Couldn't set up a centroid to seed.");
      return;
    }
    // Seeds always land on the active pose skeleton; `target.nodeIdx` selects
    // which node a click places.
    useAppStore.getState().enterSeedMode(target.nodeIdx);
    toast.info(
      "Labeling centroids — click a body-center on each animal. Use the top bar (or Space) to advance frames.",
    );
  };

  const startLocatorTraining = () => {
    if (config) void startCentroidLocatorTraining(config);
  };

  const selectLocatorModel = async () => {
    try {
      const { open: tauriOpen } = await import("@tauri-apps/plugin-dialog");
      const selected = await tauriOpen({
        directory: true,
        title: "Select centroid model directory",
      });
      if (typeof selected === "string") setSelectedModelDir(selected);
    } catch (e) {
      toast.error(
        `Couldn't open the model picker: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  const runLocatorPredict = () => {
    if (!effectiveModelDir) {
      toast.error("Select a trained centroid model first (or train one above).");
      return;
    }
    if (!config) {
      toast.error("Define a workflow first.");
      return;
    }
    // The locator runs `sleap-nn predict --data_path <the SAVED .slp>`, so any
    // unsaved seed or starter frame is invisible to it. Unsaved starter frames
    // are the trap: with `--only_suggested_frames` the run matches ZERO frames,
    // exits 0, and reports success having predicted nothing.
    if (useAppStore.getState().hasChanges) {
      toast.error("Save the project first — the locator reads the saved .slp, so unsaved seeds and starter frames are ignored.");
      return;
    }
    // Always ask for first-class `PredictedCentroid`s: that's the representation
    // Phase 2 pairs with a pose instance, and the one that round-trips through
    // the `.slp` centroid group for Python. The `instance` alternative emits a
    // DEDICATED 1-node "centroid" skeleton, which no pass can label — so it is
    // not a substitute here (see DEFAULT_ACTIVE_LEARNING_CONFIG.localize).
    void useInferenceStore.getState().startInference(
      centroidInferenceConfig([effectiveModelDir]),
    );
    if (!config.localize.separateCentroid) {
      // Anchor-node workflows have no centroid column for Phase 2 to read, so
      // the detections would render but never enter the sweep. Say so instead of
      // silently producing unreachable work.
      toast.warning(
        "This workflow anchors on a pose node, so predicted centroids won't enter the keypoint sweep — switch to a separate centroid annotation in Setup.",
      );
      return;
    }
    toast.info("Running the locator on the suggested frames — predicted centroids merge in when done.");
  };

  // Phase 2: skip training and label keypoints directly on the seeded/predicted
  // centroids — a guided, zoom-to-centroid multi-pass sweep over every instance.
  const startKeypointPasses = async (resume = false) => {
    const labels = useAppStore.getState().labels;
    if (!labels || !config || !skeleton) {
      toast.error("Define a workflow and seed some centroids first.");
      return;
    }
    // Separate centroid annotations: each seeded centroid needs a paired (empty)
    // pose instance for the passes to label. Create them up front (as ONE
    // undoable command) so the work list can pair them.
    if (config.localize.separateCentroid) {
      await commandContext.execute(PairPoseInstances);
    }
    const names = skeleton.nodes.map((n) => n.name);
    const workList = buildWorkList(labels, config, { includePredicted });
    if (workList.length === 0) {
      toast.error(
        includePredicted
          ? "Nothing to label yet — seed or predict some centroids first."
          : "No seeded centroids — tick “Also label on predicted centroids” to include the locator's detections.",
      );
      return;
    }
    const dims = passDims(config, workList, names);
    if (dims.nodeCountForPass.every((n) => n === 0)) {
      toast.error("No pass nodes match the skeleton — check the workflow's passes.");
      return;
    }
    const nodeIndices = config.labelKeypoints.passes.map((p) => nodeIndicesForPass(p, names));
    useActiveLearningStore.getState().setPhase("labelKeypoints");
    useAppStore.getState().enterKeypointPassMode({
      workList,
      dims,
      nodeIndices,
      zoomWindow: config.localize.cropSize,
    });
    if (resume) {
      // Skip the pre-seeded anchor + anything already labeled, landing on the
      // first node still needing a decision (see nextUnlabeledCursor).
      const found = useAppStore.getState().passJumpToUnlabeled();
      toast.info(
        found
          ? `Resumed at the next unlabeled node — ${workList.length} instance(s), ${dims.passCount} pass(es).`
          : `Everything's already labeled across ${workList.length} instance(s).`,
      );
    } else {
      toast.info(
        `Labeling keypoints on ${workList.length} instance(s) across ${dims.passCount} pass(es).`,
      );
    }
  };

  const stopKeypointPasses = () => {
    useAppStore.getState().exitKeypointPassMode();
  };

  if (!projectLoaded) {
    return (
      <div className="p-3 text-xs text-muted-foreground">
        Open a project to start an active-learning loop.
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      <Tabs
        value={tab}
        onValueChange={setTab}
        className="flex h-full min-h-0 flex-col gap-0"
      >
        {/* Underline tab strip docked flush to the top of the panel frame. The
            negative margins cancel the panel wrapper's p-2 so the strip spans
            the full width and its hairline reads as the frame's own divider;
            `sticky` keeps it put if the panel ever scrolls as a whole. */}
        <TabsList
          variant="line"
          className={cn(
            "sticky top-0 z-10 -mx-2 -mt-2 w-[calc(100%+1rem)] shrink-0 justify-start",
            "gap-0 rounded-none border-b border-border bg-card p-0 px-1",
            // Height comes from the triggers, NOT a fixed h-9. The primitive
            // hard-codes h-9 via a group-data variant, so the override has to
            // match that specificity to win.
            "group-data-[orientation=horizontal]/tabs:h-auto",
            // No overflow on either axis. An earlier `overflow-x-auto` here is what
            // produced the stray vertical scrollbar: per CSS, if one axis isn't
            // `visible` the other computes to `auto`, and the horizontal scrollbar
            // gutter then shrank the content box until the triggers no longer fit.
            // Four short labels fit the panel's width, so nothing needs to scroll.
            "overflow-visible",
          )}
        >
          {AL_TABS.map(({ value, label, disabled }) => (
            <TabsTrigger
              key={value}
              value={value}
              disabled={disabled}
              // `after:` is the primitive's active underline. Kept INSIDE the
              // trigger box (bottom-0, not a negative offset) so it can't be
              // clipped by the strip's overflow and needs no extra height; the
              // strip's own border-b sits directly beneath it, so the two still
              // read as one line.
              className={cn(
                "h-8 flex-none rounded-none border-0 px-2.5 text-xs",
                "after:bottom-0 after:h-[2px] after:bg-primary",
                "data-[state=active]:bg-transparent data-[state=active]:text-foreground",
              )}
            >
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* ---- Setup ---- */}
        <TabsContent value="setup" className="m-0 min-h-0 flex-1 overflow-y-auto">
          <div className="space-y-2 px-2 pb-3">
            {config ? (
              <div className="space-y-1 text-xs">
                <div>
                  Round <span className="font-medium">{round}</span> / {config.loop.maxRounds} · phase{" "}
                  <span className="font-medium">{phase ?? "idle"}</span>
                </div>
                <div className="text-muted-foreground">
                  {config.labelKeypoints.passes.length} pass(es) · centroid{" "}
                  {config.localize.centroidNode === null ? (
                    <code>arbitrary</code>
                  ) : (
                    <code>{config.localize.centroidNode}</code>
                  )}
                  {config.localize.separateCentroid
                    ? " (separate annotation)"
                    : config.localize.centroidNode === "centroid"
                      ? " (pose anchor)"
                      : ""}{" "}
                  · crop {config.localize.cropSize}px
                </div>
                {!config.localize.separateCentroid && (
                  <button
                    type="button"
                    className="text-[11px] text-primary underline underline-offset-2 hover:opacity-80"
                    onClick={useArbitraryCentroid}
                  >
                    Use a separate centroid annotation →
                  </button>
                )}
                {validation && validation.errors.length > 0 && (
                  <ul className="list-disc pl-4 text-destructive">
                    {validation.errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                )}
                {validation && validation.warnings.length > 0 && (
                  <ul className="list-disc pl-4 text-amber-600 dark:text-amber-500">
                    {validation.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                )}
                <div className="flex flex-wrap gap-1.5 pt-1">
                  <Button size="sm" onClick={() => setConfigDialogOpen(true)}>
                    Edit workflow…
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
                    Replace…
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => useActiveLearningStore.getState().clear()}
                  >
                    Clear
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Define the loop: rounds and which keypoints belong to each labeling pass.
                </p>
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" onClick={adoptFromSkeleton} disabled={!nodeNames?.length}>
                    From skeleton
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
                    Import .yaml…
                  </Button>
                  <Button size="sm" variant="ghost" onClick={adoptDefault}>
                    Use default
                  </Button>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  disabled={!nodeNames?.length}
                  onClick={() => setConfigDialogOpen(true)}
                >
                  Build workflow in the editor…
                </Button>
                {nodeNames?.length ? (
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    "From skeleton" starts a valid config with all {nodeNames.length} node(s) in one
                    pass — then use <span className="font-medium">Edit workflow…</span> to split it
                    into ordered passes.
                  </p>
                ) : null}
              </div>
            )}
          </div>
        </TabsContent>

        {/* ---- Localize (Phase 1) ---- */}
        <TabsContent value="localize" className="m-0 min-h-0 flex-1 overflow-y-auto">
          {config && (
            <div className="space-y-2 px-2 pb-3 pt-1">
              <p className="text-[11px] leading-snug text-muted-foreground">
                A loop, not one shot: seed a batch of body-centers → train the locator → keep
                seeding while it trains → run it to predict centroids on the rest. Repeat if it
                misses animals.
              </p>

              {/* Step 1 — build a pool of frames to seed on */}
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <Input
                    ref={seedCountRef}
                    type="number"
                    min={1}
                    defaultValue={config.localize.seedFrames}
                    className="h-8 w-20"
                    aria-label="Frames to add in total"
                  />
                  <Button
                    size="sm"
                    variant={primaryIs("add-frames") ? "default" : "outline"}
                    onClick={addFrames}
                  >
                    Add frames
                  </Button>
                </div>
                <p className="text-[11px] leading-snug text-muted-foreground">
                  Total across all {videoCount} video(s), spread evenly over each one (not
                  clumped, not strictly periodic). Click again to add another batch in the gaps.
                </p>
              </div>

              {/* Step 2 — seed one body-center per animal, one click each */}
              <Button
                size="sm"
                className="w-full"
                variant={isSeeding || primaryIs("seed") ? "default" : "outline"}
                onClick={toggleSeeding}
              >
                {isSeeding ? "Stop labeling centroids" : "Start labeling centroids"}
              </Button>

              <div className="text-xs">
                Seeded <span className="font-medium">{seededFrames}</span> / {trainThreshold} frames
                {seededCentroids !== seededFrames ? ` · ${seededCentroids} centroids` : ""}
              </div>

              {/* Step 3 — train the locator, prompted once enough frames are seeded */}
              {trainingRunning ? (
                <div className="rounded border border-border px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
                  Locator training in the background — keep seeding; new labels feed the next round.
                </div>
              ) : (
                /* Step 3 — train the locator. `trainAfter` is a RECOMMENDATION,
                   not a wall: this panel advises and never gates, and hiding the
                   button below the threshold made training unreachable from the
                   UI on any project smaller than it (default 100 frames) with no
                   override. Below the threshold it stays available, just not
                   styled as the recommended next step. */
                <div className="space-y-1">
                  <Button
                    size="sm"
                    className="w-full"
                    variant={
                      seededFrames >= trainThreshold && primaryIs("train") ? "default" : "outline"
                    }
                    disabled={seededFrames === 0}
                    onClick={startLocatorTraining}
                  >
                    Train centroid locator →
                  </Button>
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    {seededFrames === 0
                      ? "Seed at least one centroid to train on."
                      : seededFrames >= trainThreshold
                        ? "Enough seeded to train. It runs in the background — keep seeding meanwhile."
                        : `${trainThreshold - seededFrames} more frame(s) recommended, but you can train now on ${seededFrames} — it runs in the background.`}
                  </p>
                </div>
              )}

              {trainingDone && (
                <div className="rounded border border-emerald-600/40 px-2 py-1.5 text-[11px] leading-snug text-emerald-600 dark:text-emerald-500">
                  Locator trained. Run it to predict centroids on the rest of your frames, then
                  correct misses and retrain.
                </div>
              )}

              {/* Step 4 — run the locator to predict centroids (closes the loop). */}
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <Button size="sm" variant="outline" className="shrink-0" onClick={selectLocatorModel}>
                    {effectiveModelDir ? "Change model…" : "Select model…"}
                  </Button>
                  <span
                    className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
                    title={effectiveModelDir ?? undefined}
                  >
                    {effectiveModelDir ? modelBasename(effectiveModelDir) : "No centroid model selected"}
                  </span>
                </div>
                <Button
                  size="sm"
                  className="w-full"
                  variant={primaryIs("predict-centroids") ? "default" : "outline"}
                  disabled={!effectiveModelDir || inferenceStatus === "running"}
                  onClick={runLocatorPredict}
                >
                  {inferenceStatus === "running"
                    ? "Predicting centroids…"
                    : "Run locator → predict centroids"}
                </Button>
                {!effectiveModelDir && (
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    Train a locator above, or pick a trained centroid model directory (the run folder
                    containing <code>best.ckpt</code>).
                  </p>
                )}
              </div>
            </div>
          )}
        </TabsContent>

        {/* ---- Keypoints (Phase 2) ---- */}
        <TabsContent value="keypoints" className="m-0 min-h-0 flex-1 overflow-y-auto">
          {config && (
            <div className="space-y-2 px-2 pb-3 pt-1">
              <p className="text-[11px] leading-snug text-muted-foreground">
                Label keypoints directly on the seeded/predicted centroids: a guided sweep that zooms
                to each animal and walks the passes. Progress + the node sequence show in the top bar.
              </p>

              {!isKeypointPass ? (
                <>
                  <label className="flex items-start gap-2 text-[11px] leading-snug">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={includePredicted}
                      onChange={(e) => setIncludePredicted(e.target.checked)}
                    />
                    <span>
                      Also label on predicted centroids
                      <span className="block text-muted-foreground">
                        Include the locator&apos;s detections, not just your own seeds. Reject a
                        wrong one with <kbd>x</kbd> during the sweep.
                      </span>
                    </span>
                  </label>
                  <Button
                    size="sm"
                    className="w-full"
                    variant="outline"
                    // Gate on what the sweep can actually visit, NOT on human
                    // seeds: after "run locator" every centroid may be predicted,
                    // and gating on seeds alone would block the sweep on exactly
                    // the detections Phase 1 just produced.
                    disabled={labelableCentroids === 0}
                    onClick={() => startKeypointPasses()}
                  >
                    Label keypoints on {labelableCentroids || "seeded"} centroid(s) →
                  </Button>
                  {labelableCentroids > 0 && (
                    <Button
                      size="sm"
                      className="w-full"
                      variant="ghost"
                      onClick={() => startKeypointPasses(true)}
                    >
                      Resume where I left off →
                    </Button>
                  )}
                  {labelableCentroids === 0 && (
                    <p className="text-[11px] leading-snug text-muted-foreground">
                      {seededCentroids === 0 && !includePredicted
                        ? "No seeded centroids — tick the box above to label the locator's detections, or seed some by hand."
                        : "Seed (or predict) some centroids first — Phase 2 labels one instance per centroid."}
                    </p>
                  )}
                </>
              ) : (
                <div className="space-y-2">
                  {passCursor && passDimsState ? (
                    <div className="space-y-0.5 text-xs">
                      <div>
                        Pass{" "}
                        <span className="font-medium">
                          {passCursor.passIdx + 1}/{passDimsState.passCount}
                        </span>
                        {config.labelKeypoints.passes[passCursor.passIdx]?.name
                          ? ` · ${config.labelKeypoints.passes[passCursor.passIdx].name}`
                          : ""}
                      </div>
                      <div className="text-muted-foreground">
                        Instance {passCursor.itemIdx + 1}/{passDimsState.itemCount} · placement{" "}
                        {linearIndex(passCursor, passDimsState) + 1}/{totalSteps(passDimsState)}
                      </div>
                    </div>
                  ) : (
                    <div className="rounded border border-emerald-600/40 px-2 py-1.5 text-[11px] leading-snug text-emerald-600 dark:text-emerald-500">
                      All passes complete. Stop to review, then train a pose model.
                    </div>
                  )}

                  <div className="space-y-1">
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                      <span>Zoom window</span>
                      <span>{passZoomWindow}px</span>
                    </div>
                    <Slider
                      min={32}
                      max={1024}
                      step={16}
                      value={[passZoomWindow]}
                      onValueChange={(v) =>
                        useAppStore.getState().setPassZoomWindow(v[0] ?? passZoomWindow)
                      }
                    />
                  </div>

                  {passCursor && (
                    <Button
                      size="sm"
                      className="w-full"
                      variant="outline"
                      onClick={() => skipCurrentPassItem()}
                    >
                      Skip this instance (⇧S)
                    </Button>
                  )}
                  {currentItemPredicted && (
                    <Button
                      size="sm"
                      className="w-full text-destructive"
                      variant="outline"
                      onClick={() => rejectCurrentPassItem({ includePredicted })}
                    >
                      Reject this detection (X)
                    </Button>
                  )}

                  <Button size="sm" className="w-full" variant="default" onClick={stopKeypointPasses}>
                    Stop labeling keypoints
                  </Button>
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    Click = place · right-click = not visible · <kbd>s</kbd> skip node ·{" "}
                    <kbd>⇧s</kbd> skip the whole animal (bad pose — keeps the centroid) ·{" "}
                    <kbd>b</kbd> back · <kbd>x</kbd> reject a wrong prediction · <kbd>Esc</kbd> exit
                  </p>
                </div>
              )}
            </div>
          )}
        </TabsContent>

        {/* ---- Correct (Phase 3) ---- */}
        <TabsContent value="correct" className="m-0 min-h-0 flex-1 overflow-y-auto">
          <CorrectionPanel />
        </TabsContent>
      </Tabs>

      {/* Hidden import input (shared by Replace… / Import .yaml…). */}
      <input
        ref={fileRef}
        type="file"
        accept=".yaml,.yml"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importYaml(f);
          e.target.value = "";
        }}
      />

      <ActiveLearningConfigDialog
        open={configDialogOpen}
        onOpenChange={setConfigDialogOpen}
        nodeNames={nodeNames ?? []}
      />
    </div>
  );
}
