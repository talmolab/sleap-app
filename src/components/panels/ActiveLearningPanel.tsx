/**
 * Active-Learning panel (issue #212): define the workflow config and drive the
 * Phase-1 loop — add starter frames, seed centroids (one click each), and
 * generate crops for Phase-2 labeling.
 *
 * This panel orchestrates; it doesn't do compute. Training/inference run
 * through the existing Training/Inference panels (centroid-only wiring lands
 * separately). "Dashboard + next-action": it recommends steps but never gates.
 */

import { useMemo, useRef } from "react";
import { useAppStore } from "../../stores/appStore";
import { useActiveLearningStore } from "../../stores/activeLearningStore";
import { useTrainingStore } from "../../stores/trainingStore";
import { generateCrops } from "@/lib/activeLearning/generateCrops";
import { configFromSkeleton } from "@/lib/activeLearning/config";
import { startCentroidLocatorTraining } from "@/lib/activeLearning/trainLocator";
import { generateSuggestionFrames } from "@/lib/suggestionStrategies";
import { toast } from "@/lib/notify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Small labeled section wrapper matching the other panels' density. */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-border px-2 py-2 space-y-2">
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      {children}
    </div>
  );
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

  const fileRef = useRef<HTMLInputElement>(null);
  const seedCountRef = useRef<HTMLInputElement>(null);

  const nodeNames = skeleton?.nodes.map((n) => n.name);

  // Live count of seeded frames (frames with ≥1 user instance), centroids, and
  // whether a suggested-frame pool exists to seed on.
  const { seededFrames, seededCentroids, hasSuggestions } = useMemo(() => {
    const labels = useAppStore.getState().labels;
    let frames = 0;
    let centroids = 0;
    if (labels) {
      for (const lf of labels.labeledFrames) {
        const n = lf.userInstances.length;
        if (n > 0) frames++;
        centroids += n;
      }
    }
    return {
      seededFrames: frames,
      seededCentroids: centroids,
      hasSuggestions: !!labels && labels.suggestions.length > 0,
    };
    // overlayVersion drives the recount; labels is mutated in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayVersion, projectLoaded]);

  const trainThreshold = config?.localize.trainAfter ?? 100;
  const trainingRunning = trainingStatus === "running";
  const trainingDone = trainingStatus === "completed";
  const isSeeding = labelingMode === "seed";

  // The single recommended next step. Exactly one panel button is highlighted
  // (filled); everything else is a quiet outline, so the user always knows what
  // to click next. While actively seeding, the Seed button itself is the lit
  // one (it shows the active mode), so nothing else competes.
  type NextAction = "add-frames" | "seed" | "train" | "generate-crops";
  const nextAction: NextAction =
    seededFrames === 0 && !hasSuggestions
      ? "add-frames"
      : seededFrames < trainThreshold
        ? "seed"
        : trainingDone
          ? "generate-crops"
          : trainingRunning
            ? "seed"
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
    const idx = skeleton.nodes.findIndex((n) => n.name === config.localize.centroidNode);
    if (idx < 0) {
      toast.error(`Centroid node "${config.localize.centroidNode}" is not in the skeleton`);
      return;
    }
    useAppStore.getState().enterSeedMode(idx);
    toast.info(
      "Labeling centroids — click a body-center on each animal. Use the top bar (or Space) to advance frames.",
    );
  };

  const startLocatorTraining = () => {
    if (config) void startCentroidLocatorTraining(config);
  };

  const doGenerateCrops = () => {
    const labels = useAppStore.getState().labels;
    if (!labels || !config) {
      toast.error("Define a workflow and seed some frames first");
      return;
    }
    // Crop around user-seeded centroids (the minimal path needs no locator).
    const result = generateCrops(labels, config, { from: "user" });
    if (result.count === 0) {
      if (result.unopened > 0) {
        toast.error(
          `Can't crop ${result.unopened} instance(s) — view the source video first so its ` +
            "decoder opens, then try again.",
        );
      } else {
        toast.error("No seeded centroids found. Seed some frames before generating crops.");
      }
      return;
    }
    useAppStore.getState().setLabels(result.labels, "crops.slp");
    useActiveLearningStore.getState().setPhase("labelKeypoints");
    const extra = [
      result.skipped ? `skipped ${result.skipped}` : "",
      result.unopened ? `${result.unopened} need the video opened` : "",
    ]
      .filter(Boolean)
      .join(", ");
    toast.success(
      `Generated ${result.count} crop(s)${extra ? ` (${extra})` : ""}. ` +
        "Now in the crop project for Phase-2 labeling — save to keep it.",
    );
  };

  if (!projectLoaded) {
    return (
      <div className="p-3 text-xs text-muted-foreground">
        Open a project to start an active-learning loop.
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto text-sm">
      <Section title="Workflow">
        {config ? (
          <div className="space-y-1 text-xs">
            <div>
              Round <span className="font-medium">{round}</span> / {config.loop.maxRounds} ·
              phase <span className="font-medium">{phase ?? "idle"}</span>
            </div>
            <div className="text-muted-foreground">
              {config.labelKeypoints.passes.length} pass(es) · centroid node{" "}
              <code>{config.localize.centroidNode}</code> · crop {config.localize.cropSize}px
            </div>
            {validation && validation.errors.length > 0 && (
              <ul className="text-destructive list-disc pl-4">
                {validation.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
            {validation && validation.warnings.length > 0 && (
              <ul className="text-amber-600 dark:text-amber-500 list-disc pl-4">
                {validation.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
            <div className="flex gap-1.5 pt-1">
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
            {nodeNames?.length ? (
              <p className="text-[11px] text-muted-foreground leading-snug">
                "From skeleton" starts a valid config with all {nodeNames.length} node(s) in one
                pass — split it into ordered passes in the .yaml.
              </p>
            ) : null}
          </div>
        )}
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
      </Section>

      {config && (
        <Section title="Phase 1 · Localize (iterative)">
          <p className="text-[11px] text-muted-foreground leading-snug">
            A loop, not one shot: seed a batch of body-centers → train the locator → keep
            seeding while it trains → when its accuracy plateaus, generate crops. Repeat if it
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
            <div className="rounded border border-border px-2 py-1.5 text-[11px] text-muted-foreground leading-snug">
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
              <p className="text-[11px] text-muted-foreground leading-snug">
                Enough seeded to train. It runs in the background — keep seeding meanwhile.
              </p>
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground leading-snug">
              Seed {trainThreshold - seededFrames} more frame(s) to kick off locator training.
            </p>
          )}

          {trainingDone && (
            <div className="rounded border border-emerald-600/40 px-2 py-1.5 text-[11px] text-emerald-600 dark:text-emerald-500 leading-snug">
              Locator trained. If it's matching well on held-out frames, generate crops — otherwise
              seed the misses and retrain.
            </div>
          )}

          {/* Step 4 — crops for Phase 2 */}
          <Button
            size="sm"
            className="w-full"
            variant={primaryIs("generate-crops") ? "default" : "outline"}
            onClick={doGenerateCrops}
          >
            Generate crops for Phase 2
          </Button>
        </Section>
      )}
    </div>
  );
}
