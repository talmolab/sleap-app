/**
 * Active-Learning panel (issue #212): define the workflow config and drive the
 * Phase-1 loop — add starter frames, seed centroids (one click each), and
 * generate crops for Phase-2 labeling.
 *
 * This panel orchestrates; it doesn't do compute. Training/inference run
 * through the existing Training/Inference panels (centroid-only wiring lands
 * separately). "Dashboard + next-action": it recommends steps but never gates.
 */

import { useRef } from "react";
import { useAppStore } from "../../stores/appStore";
import { useActiveLearningStore } from "../../stores/activeLearningStore";
import { generateCrops } from "@/lib/activeLearning/generateCrops";
import { configFromSkeleton } from "@/lib/activeLearning/config";
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

  const fileRef = useRef<HTMLInputElement>(null);
  const seedCountRef = useRef<HTMLInputElement>(null);

  const nodeNames = skeleton?.nodes.map((n) => n.name);

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
    toast.info("Seeding: click to drop a centroid · right-click to remove · Space = next frame · Esc = stop");
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
        <Section title="Phase 1 · Localize">
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5">
              <Input
                ref={seedCountRef}
                type="number"
                min={1}
                defaultValue={config.localize.seedFrames}
                className="h-8 w-20"
              />
              <Button size="sm" variant="outline" onClick={addFrames}>
                Add frames
              </Button>
            </div>
            <Button
              size="sm"
              className="w-full"
              variant={labelingMode === "seed" ? "default" : "outline"}
              onClick={toggleSeeding}
            >
              {labelingMode === "seed" ? "Stop seeding" : "Seed centroids"}
            </Button>
            <Button size="sm" className="w-full" onClick={doGenerateCrops}>
              Generate crops for Phase 2
            </Button>
            <p className="text-[11px] text-muted-foreground leading-snug">
              Seed a body-center on each frame (one click per animal), then generate crops
              centered on those points.
            </p>
          </div>
        </Section>
      )}
    </div>
  );
}
