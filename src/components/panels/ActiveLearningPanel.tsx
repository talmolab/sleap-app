/**
 * Active-Learning panel (issue #212): define the workflow config and drive the
 * Phase-1 loop — add starter frames, seed centroids (one click each), train a
 * centroid locator, then run it to predict centroids on the rest.
 *
 * This panel orchestrates; it doesn't do compute. Training/inference run
 * through the existing Training/Inference stores. "Dashboard + next-action": it
 * recommends steps but never gates.
 */

import { useMemo, useRef, useState } from "react";
import { useAppStore } from "../../stores/appStore";
import { useActiveLearningStore } from "../../stores/activeLearningStore";
import { useTrainingStore } from "../../stores/trainingStore";
import { useInferenceStore, centroidInferenceConfig } from "../../stores/inferenceStore";
import { configFromSkeleton } from "@/lib/activeLearning/config";
import { startCentroidLocatorTraining } from "@/lib/activeLearning/trainLocator";
import {
  buildWorkList,
  passDims,
  nodeIndicesForPass,
  linearIndex,
  totalSteps,
  countSeededCentroids,
} from "@/lib/activeLearning/passEngine";
import type { Skeleton } from "@talmolab/sleap-io.js";
import { generateSuggestionFrames } from "@/lib/suggestionStrategies";
import { commandContext, AddNodeCommand, PairPoseInstances } from "@/commands";
import { toast } from "@/lib/notify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ActiveLearningConfigDialog } from "@/components/dialogs/ActiveLearningConfigDialog";

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

  const fileRef = useRef<HTMLInputElement>(null);
  const seedCountRef = useRef<HTMLInputElement>(null);
  // Explicitly-picked centroid-model dir (survives restarts / new machines,
  // where this-session training state is empty). Falls back to the last model
  // trained this session.
  const [selectedModelDir, setSelectedModelDir] = useState<string | null>(null);
  const [configDialogOpen, setConfigDialogOpen] = useState(false);

  const nodeNames = skeleton?.nodes.map((n) => n.name);

  // Live count of seeded frames/centroids (config-aware: with separate centroid
  // annotations only seeded `frame.centroids` count, so pose labels and the
  // paired empty pose instances never inflate it), and whether a suggested-frame
  // pool exists to seed on.
  const { seededFrames, seededCentroids, hasSuggestions } = useMemo(() => {
    const labels = useAppStore.getState().labels;
    if (!labels) {
      return { seededFrames: 0, seededCentroids: 0, hasSuggestions: false };
    }
    const { frames, centroids } = countSeededCentroids(labels, config);
    return {
      seededFrames: frames,
      seededCentroids: centroids,
      hasSuggestions: labels.suggestions.length > 0,
    };
    // overlayVersion drives the recount; labels is mutated in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayVersion, projectLoaded, config]);

  const trainThreshold = config?.localize.trainAfter ?? 100;
  const trainingRunning = trainingStatus === "running";
  const trainingDone = trainingStatus === "completed";
  const isSeeding = labelingMode === "seed";
  const isKeypointPass = labelingMode === "keypointPass";
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
    const next = generateSuggestionFrames(labels, {
      method: "random",
      videos: labels.videos,
      perVideo: count,
    });
    labels.suggestions = next;
    useAppStore.getState().markChanged();
    useAppStore.getState().bumpOverlayVersion();
    toast.success(`Added ${next.length} suggested frames — press Space to step through them`);
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
    void useInferenceStore.getState().startInference(centroidInferenceConfig([effectiveModelDir]));
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
    const workList = buildWorkList(labels, config);
    if (workList.length === 0) {
      toast.error("Nothing to label yet — seed or predict some centroids first.");
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
      <Tabs defaultValue="setup" className="flex h-full min-h-0 flex-col gap-0">
        <TabsList className="m-2 shrink-0">
          <TabsTrigger value="setup">Setup</TabsTrigger>
          <TabsTrigger value="localize" disabled={!config}>
            Localize
          </TabsTrigger>
          <TabsTrigger value="keypoints" disabled={!config}>
            Keypoints
          </TabsTrigger>
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
              <div className="flex items-center gap-1.5">
                <Input
                  ref={seedCountRef}
                  type="number"
                  min={1}
                  defaultValue={config.localize.seedFrames}
                  className="h-8 w-20"
                />
                <Button
                  size="sm"
                  variant={primaryIs("add-frames") ? "default" : "outline"}
                  onClick={addFrames}
                >
                  Add frames
                </Button>
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
              ) : seededFrames >= trainThreshold ? (
                <div className="space-y-1">
                  <Button
                    size="sm"
                    className="w-full"
                    variant={primaryIs("train") ? "default" : "outline"}
                    onClick={startLocatorTraining}
                  >
                    Train centroid locator →
                  </Button>
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    Enough seeded to train. It runs in the background — keep seeding meanwhile.
                  </p>
                </div>
              ) : (
                <p className="text-[11px] leading-snug text-muted-foreground">
                  Seed {trainThreshold - seededFrames} more frame(s) to kick off locator training.
                </p>
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
                  <Button
                    size="sm"
                    className="w-full"
                    variant="outline"
                    disabled={seededFrames === 0}
                    onClick={() => startKeypointPasses()}
                  >
                    Label keypoints on {seededCentroids || "seeded"} centroid(s) →
                  </Button>
                  {seededFrames > 0 && (
                    <Button
                      size="sm"
                      className="w-full"
                      variant="ghost"
                      onClick={() => startKeypointPasses(true)}
                    >
                      Resume where I left off →
                    </Button>
                  )}
                  {seededFrames === 0 && (
                    <p className="text-[11px] leading-snug text-muted-foreground">
                      Seed (or predict) some centroids first — Phase 2 labels one instance per centroid.
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

                  <Button size="sm" className="w-full" variant="default" onClick={stopKeypointPasses}>
                    Stop labeling keypoints
                  </Button>
                  <p className="text-[11px] leading-snug text-muted-foreground">
                    Click = place · right-click = not visible · <kbd>s</kbd> skip · <kbd>b</kbd> back ·{" "}
                    <kbd>Esc</kbd> exit
                  </p>
                </div>
              )}
            </div>
          )}
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
