/**
 * Visual editor for the active-learning workflow config (issue #212).
 *
 * Replaces hand-editing the YAML: every field gets a control across General /
 * Localize / Passes / Mine tabs, with a raw YAML tab as the escape hatch
 * (view · copy · apply · import). The centerpiece is the Passes editor — name
 * passes, assign skeleton nodes to each in click order, reorder both — since
 * that's the part that's painful in YAML. Edits apply to a local draft and only
 * hit the store on Save, so Cancel is always safe. Validation is shown live but
 * never blocks saving (the app's config philosophy is dashboard-not-gate).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { toast } from "@/lib/notify";
import {
  DEFAULT_ACTIVE_LEARNING_CONFIG,
  configFromSkeleton,
  serializeActiveLearningConfig,
  parseActiveLearningConfig,
  validateActiveLearningConfig,
  allPassNodes,
  type ActiveLearningConfig,
  type MineStrategy,
} from "@/lib/activeLearning/config";
import { useActiveLearningStore } from "@/stores/activeLearningStore";
import { useAppStore } from "@/stores/appStore";
import { getPlatform, isTauri } from "@/platform";
import { downloadFile } from "@/lib/exportUtils";
import { ArrowUp, ArrowDown, Download, Plus, Trash2, X } from "lucide-react";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Skeleton node names — the pool passes assign from + validation target. */
  nodeNames: string[];
}

// Centroid Select sentinels for the two free-anchor flavors (vs. a real node).
const FREE_SEPARATE = "__free_separate__"; // separate first-class centroid annotation (frame.centroids)
const FREE_POSE = "__free_pose__"; // synthetic anchor node added to the pose skeleton

/** Deep clone via JSON (config is plain JSON data). */
function clone(c: ActiveLearningConfig): ActiveLearningConfig {
  return JSON.parse(JSON.stringify(c));
}

/** Move item at `from` by `delta`, returning a new array (no-op at the ends). */
function moved<T>(arr: T[], from: number, delta: number): T[] {
  const to = from + delta;
  if (to < 0 || to >= arr.length) return arr;
  const copy = [...arr];
  const [x] = copy.splice(from, 1);
  copy.splice(to, 0, x);
  return copy;
}

/** Compact labeled row. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-3 py-1.5 text-sm">
      <span className="w-40 shrink-0 text-muted-foreground">{label}</span>
      <span className="flex-1 min-w-0">{children}</span>
    </label>
  );
}

function NumberInput({
  value,
  onChange,
  step,
  min,
}: {
  value: number;
  onChange: (n: number) => void;
  step?: number;
  min?: number;
}) {
  return (
    <Input
      type="number"
      className="h-8 w-28"
      value={value}
      step={step}
      min={min}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (Number.isFinite(n)) onChange(n);
      }}
    />
  );
}

function Check({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (b: boolean) => void;
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 py-1.5 text-sm">
      <input
        type="checkbox"
        className="h-4 w-4 accent-primary"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

export function ActiveLearningConfigDialog({ open, onOpenChange, nodeNames }: Props) {
  const [draft, setDraft] = useState<ActiveLearningConfig>(DEFAULT_ACTIVE_LEARNING_CONFIG);
  const [yamlText, setYamlText] = useState("");
  const [yamlError, setYamlError] = useState<string | null>(null);

  // Seed the draft from the store config ONLY on the open transition (false→
  // true), never on later re-renders. `nodeNames` is a fresh array every parent
  // render, so depending on it to re-seed would wipe unsaved edits whenever an
  // upstream store change (e.g. a training/inference status tick) re-renders the
  // panel while the dialog is open.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      const cur = useActiveLearningStore.getState().config;
      const base =
        cur ?? (nodeNames.length ? configFromSkeleton(nodeNames) : DEFAULT_ACTIVE_LEARNING_CONFIG);
      setDraft(clone(base));
      setYamlText(serializeActiveLearningConfig(base));
      setYamlError(null);
    }
    wasOpen.current = open;
  }, [open, nodeNames]);

  const validation = useMemo(
    () => validateActiveLearningConfig(draft, nodeNames.length ? nodeNames : undefined),
    [draft, nodeNames],
  );

  /** Apply a mutation to a fresh clone of the draft. */
  const edit = (fn: (d: ActiveLearningConfig) => void) => {
    setDraft((prev) => {
      const next = clone(prev);
      fn(next);
      return next;
    });
  };

  const assigned = new Set(allPassNodes(draft));
  const unassigned = nodeNames.filter(
    (n) => !assigned.has(n) && n !== draft.localize.centroidNode,
  );

  const save = () => {
    const result = useActiveLearningStore.getState().setConfig(draft, nodeNames);
    // Mark the project dirty so the workflow gets written into the .slp on the
    // next save (it's persisted in the project's provenance — see persistence.ts).
    useAppStore.getState().markChanged();
    // Be explicit that this only stages the workflow — it lands in the .slp when
    // the PROJECT is saved (⌘S). Otherwise "saved" reads as already-on-disk.
    const tail = "— save the project (⌘S) to store it in the .slp";
    if (result.ok) toast.success(`Workflow updated ${tail}`);
    else toast.warning(`Workflow updated with ${result.errors.length} issue(s) ${tail}`);
    onOpenChange(false);
  };

  const applyYaml = () => {
    try {
      const parsed = parseActiveLearningConfig(yamlText);
      setDraft(parsed);
      setYamlError(null);
      toast.success("Parsed YAML into the editor");
    } catch (e) {
      setYamlError(e instanceof Error ? e.message : String(e));
    }
  };

  // Write the workflow to a YAML file so it survives reloads — the AL store
  // isn't persisted, so the in-memory config is otherwise lost on reload/close.
  // Serializes the editor `draft` (the workflow itself), matching the footer's
  // "Save workflow"; the raw YAML textarea is just a view/escape-hatch. Native
  // save dialog on desktop; Blob download in the browser. Re-import the file
  // via the panel's "Import .yaml…".
  const saveToFile = async () => {
    const yaml = serializeActiveLearningConfig(draft);
    const defaultName = "active-learning.yaml";
    try {
      if (isTauri) {
        const platform = await getPlatform();
        const path = await platform.showSaveDialog({
          defaultName,
          filters: [{ name: "Workflow YAML", extensions: ["yaml", "yml"] }],
        });
        if (!path) return; // user cancelled
        await platform.writeFile(path, new TextEncoder().encode(yaml));
        toast.success(`Saved workflow to ${path.replace(/^.*[/\\]/, "")}`);
      } else {
        downloadFile(yaml, defaultName, "text/yaml");
        toast.success(`Saved ${defaultName}`);
      }
    } catch (err) {
      toast.error(
        `Could not save workflow: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const tr = draft.localize.training;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit workflow</DialogTitle>
          <DialogDescription>
            Configure the active-learning loop — passes, centroid, training, and mining.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="passes" className="w-full">
          <TabsList className="w-full">
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="localize">Localize</TabsTrigger>
            <TabsTrigger value="passes">Passes</TabsTrigger>
            <TabsTrigger value="mine">Mine</TabsTrigger>
            <TabsTrigger value="yaml">YAML</TabsTrigger>
          </TabsList>

          <div className="max-h-[52vh] overflow-y-auto pr-1">
            {/* ---- General ---- */}
            <TabsContent value="general" className="mt-2">
              <Field label="Max rounds">
                <NumberInput
                  value={draft.loop.maxRounds}
                  min={1}
                  onChange={(n) => edit((d) => (d.loop.maxRounds = n))}
                />
              </Field>
              <Check
                checked={draft.loop.stopWhen.metricPlateau}
                onChange={(b) => edit((d) => (d.loop.stopWhen.metricPlateau = b))}
                label="Hint to stop when the metric plateaus"
              />
              <div className="pt-3 text-xs font-medium text-muted-foreground">
                Consistency benchmark
              </div>
              <Check
                checked={draft.consistency.enabled}
                onChange={(b) => edit((d) => (d.consistency.enabled = b))}
                label="Re-show a fraction of crops to measure agreement"
              />
              <Field label="Fraction (0–1)">
                <NumberInput
                  value={draft.consistency.fraction}
                  step={0.05}
                  min={0}
                  onChange={(n) => edit((d) => (d.consistency.fraction = n))}
                />
              </Field>
              <Check
                checked={draft.consistency.blind}
                onChange={(b) => edit((d) => (d.consistency.blind = b))}
                label="Blind (shuffle so repeats aren't adjacent)"
              />
            </TabsContent>

            {/* ---- Localize ---- */}
            <TabsContent value="localize" className="mt-2">
              <Check
                checked={draft.localize.enabled}
                onChange={(b) => edit((d) => (d.localize.enabled = b))}
                label="Enable localization (Phase 1) — off starts the loop at keypoints"
              />
              <Field label="Centroid anchor">
                <Select
                  value={
                    draft.localize.separateCentroid
                      ? FREE_SEPARATE
                      : draft.localize.centroidNode === "centroid" ||
                          draft.localize.centroidNode === null
                        ? FREE_POSE
                        : draft.localize.centroidNode
                  }
                  onValueChange={(v) =>
                    edit((d) => {
                      if (v === FREE_SEPARATE) {
                        d.localize.centroidNode = "centroid";
                        d.localize.separateCentroid = true;
                      } else if (v === FREE_POSE) {
                        d.localize.centroidNode = "centroid";
                        d.localize.separateCentroid = false;
                      } else {
                        d.localize.centroidNode = v;
                        d.localize.separateCentroid = false;
                      }
                    })
                  }
                >
                  <SelectTrigger className="h-8">
                    <SelectValue placeholder="Select a node…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={FREE_SEPARATE}>Free anchor — separate annotation</SelectItem>
                    <SelectItem value={FREE_POSE}>Free anchor — pose skeleton</SelectItem>
                    {nodeNames.map((n) => (
                      <SelectItem key={n} value={n}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <p className="pl-40 text-[11px] leading-snug text-muted-foreground">
                {draft.localize.separateCentroid
                  ? "Separate: the centroid is a standalone annotation — never a pose keypoint."
                  : draft.localize.centroidNode === "centroid"
                    ? "Free anchor added to the pose skeleton (the pose model will emit it)."
                    : "A pose node doubles as the localization anchor."}
              </p>
              <Field label="Crop / zoom window (px)">
                <NumberInput
                  value={draft.localize.cropSize}
                  min={1}
                  onChange={(n) => edit((d) => (d.localize.cropSize = n))}
                />
              </Field>
              <Field label="Starter frames per batch (total, all videos)">
                <NumberInput
                  value={draft.localize.seedFrames}
                  min={1}
                  onChange={(n) => edit((d) => (d.localize.seedFrames = n))}
                />
              </Field>
              <Field label="Train after N seeds">
                <NumberInput
                  value={draft.localize.trainAfter}
                  min={1}
                  onChange={(n) => edit((d) => (d.localize.trainAfter = n))}
                />
              </Field>

              <div className="pt-3 text-xs font-medium text-muted-foreground">Locator training</div>
              <Field label="Backbone">
                <Select
                  value={tr.backbone}
                  onValueChange={(v) =>
                    edit((d) => (d.localize.training.backbone = v as typeof tr.backbone))
                  }
                >
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(["unet", "convnext", "swint"] as const).map((b) => (
                      <SelectItem key={b} value={b}>
                        {b}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Input scale (0–1)">
                <NumberInput
                  value={tr.inputScale}
                  step={0.1}
                  min={0}
                  onChange={(n) => edit((d) => (d.localize.training.inputScale = n))}
                />
              </Field>
              <Field label="Max epochs">
                <NumberInput
                  value={tr.maxEpochs}
                  min={1}
                  onChange={(n) => edit((d) => (d.localize.training.maxEpochs = n))}
                />
              </Field>
              <Field label="Batch size">
                <NumberInput
                  value={tr.batchSize}
                  min={1}
                  onChange={(n) => edit((d) => (d.localize.training.batchSize = n))}
                />
              </Field>
              <Field label="Augmentation">
                <Select
                  value={tr.augmentation}
                  onValueChange={(v) =>
                    edit((d) => (d.localize.training.augmentation = v as typeof tr.augmentation))
                  }
                >
                  <SelectTrigger className="h-8">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(["minimal", "rotation", "rotation-intensity"] as const).map((a) => (
                      <SelectItem key={a} value={a}>
                        {a}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Check
                checked={tr.earlyStop}
                onChange={(b) => edit((d) => (d.localize.training.earlyStop = b))}
                label="Early-stop on plateau"
              />
            </TabsContent>

            {/* ---- Passes ---- */}
            <TabsContent value="passes" className="mt-2 space-y-3">
              <p className="text-[11px] leading-snug text-muted-foreground">
                A <b>pass</b> is a group of keypoints labeled together, in click
                order — split the skeleton into as many passes as you like and
                reorder them. <b>Order</b> sets the sweep: <i>pass-major</i>{" "}
                labels one pass across every crop before the next pass
                (repetition → consistent placement); <i>crop-major</i> finishes
                all passes on one crop before moving on (each crop seen once).
                Mark one pass as the <b>Axis</b> to turn its first → last node
                into a reference line shown while labeling the other passes.
              </p>
              <div className="flex items-center justify-between">
                <Select
                  value={draft.labelKeypoints.order}
                  onValueChange={(v) =>
                    edit(
                      (d) =>
                        (d.labelKeypoints.order = v as ActiveLearningConfig["labelKeypoints"]["order"]),
                    )
                  }
                >
                  <SelectTrigger className="h-8 w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pass-major">Order: pass-major</SelectItem>
                    <SelectItem value="crop-major">Order: crop-major</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    edit((d) =>
                      d.labelKeypoints.passes.push({
                        name: `Pass ${d.labelKeypoints.passes.length + 1}`,
                        nodes: [],
                        axis: false,
                      }),
                    )
                  }
                >
                  <Plus className="h-3.5 w-3.5" /> Add pass
                </Button>
              </div>

              {draft.labelKeypoints.passes.map((pass, pi) => {
                const addable = nodeNames.filter((n) => !pass.nodes.includes(n));
                return (
                  <div key={pi} className="rounded border border-border p-2 space-y-2">
                    <div className="flex items-center gap-1.5">
                      <Input
                        className="h-8 flex-1"
                        value={pass.name}
                        onChange={(e) =>
                          edit((d) => (d.labelKeypoints.passes[pi].name = e.target.value))
                        }
                      />
                      <label
                        className="flex items-center gap-1.5 whitespace-nowrap px-1.5 text-xs text-muted-foreground"
                        title="Use this pass as the axis: its first and last nodes define a reference line drawn on the crop while labeling the other passes. Only one pass can be the axis."
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-primary"
                          checked={pass.axis}
                          onChange={(e) =>
                            edit((d) => {
                              // Single axis: this pass takes it (or clears it);
                              // all others are turned off.
                              const on = e.target.checked;
                              d.labelKeypoints.passes.forEach(
                                (p, j) => (p.axis = on && j === pi),
                              );
                            })
                          }
                        />
                        Axis
                      </label>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 w-8 p-0"
                        aria-label="Move pass up"
                        disabled={pi === 0}
                        onClick={() =>
                          edit((d) => (d.labelKeypoints.passes = moved(d.labelKeypoints.passes, pi, -1)))
                        }
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 w-8 p-0"
                        aria-label="Move pass down"
                        disabled={pi === draft.labelKeypoints.passes.length - 1}
                        onClick={() =>
                          edit((d) => (d.labelKeypoints.passes = moved(d.labelKeypoints.passes, pi, 1)))
                        }
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-8 w-8 p-0 text-destructive"
                        aria-label="Delete pass"
                        onClick={() => edit((d) => d.labelKeypoints.passes.splice(pi, 1))}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>

                    {pass.axis && (
                      <p className="text-[11px] leading-snug text-muted-foreground">
                        {pass.nodes.length >= 2
                          ? `Axis line: ${pass.nodes[0]} → ${pass.nodes[pass.nodes.length - 1]} — shown as a guide while labeling the other passes.`
                          : "Add at least 2 nodes so the axis has two endpoints."}
                      </p>
                    )}

                    {/* Ordered node rows (the click order = the labeling order). */}
                    <div className="space-y-1">
                      {pass.nodes.map((node, ni) => (
                        <div key={ni} className="flex items-center gap-1 text-sm">
                          <span className="w-5 text-right text-muted-foreground">{ni + 1}.</span>
                          <span className="flex-1">{node}</span>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 w-6 p-0"
                            aria-label="Move node up"
                            disabled={ni === 0}
                            onClick={() =>
                              edit((d) => (d.labelKeypoints.passes[pi].nodes = moved(pass.nodes, ni, -1)))
                            }
                          >
                            <ArrowUp className="h-3 w-3" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 w-6 p-0"
                            aria-label="Move node down"
                            disabled={ni === pass.nodes.length - 1}
                            onClick={() =>
                              edit((d) => (d.labelKeypoints.passes[pi].nodes = moved(pass.nodes, ni, 1)))
                            }
                          >
                            <ArrowDown className="h-3 w-3" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 w-6 p-0 text-destructive"
                            aria-label="Remove node"
                            onClick={() =>
                              edit((d) => d.labelKeypoints.passes[pi].nodes.splice(ni, 1))
                            }
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        </div>
                      ))}
                      {pass.nodes.length === 0 && (
                        <div className="text-[11px] text-muted-foreground">No nodes yet.</div>
                      )}
                    </div>

                    {addable.length > 0 && (
                      <Select
                        value=""
                        onValueChange={(n) => edit((d) => d.labelKeypoints.passes[pi].nodes.push(n))}
                      >
                        <SelectTrigger className="h-7 w-full text-xs">
                          <SelectValue placeholder="+ add node…" />
                        </SelectTrigger>
                        <SelectContent>
                          {addable.map((n) => (
                            <SelectItem key={n} value={n}>
                              {n}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                );
              })}

              {unassigned.length > 0 && (
                <div className="text-[11px] text-muted-foreground">
                  Not in any pass: {unassigned.join(", ")}
                </div>
              )}
            </TabsContent>

            {/* ---- Mine ---- */}
            <TabsContent value="mine" className="mt-2">
              <Check
                checked={draft.mine.enabled}
                onChange={(b) => edit((d) => (d.mine.enabled = b))}
                label="Mine hard examples after each round"
              />
              <div className="pt-2 text-xs font-medium text-muted-foreground">Strategies</div>
              {(["prediction_score", "velocity", "max_displacement"] as const).map((s) => (
                <Check
                  key={s}
                  checked={draft.mine.strategies.includes(s)}
                  onChange={(b) =>
                    edit((d) => {
                      const set = new Set<MineStrategy>(d.mine.strategies);
                      if (b) set.add(s);
                      else set.delete(s);
                      d.mine.strategies = [...set];
                    })
                  }
                  label={s}
                />
              ))}
              <Field label="Score threshold">
                <NumberInput
                  value={draft.mine.scoreThreshold}
                  step={0.05}
                  min={0}
                  onChange={(n) => edit((d) => (d.mine.scoreThreshold = n))}
                />
              </Field>
              <Check
                checked={draft.mine.keypointReview}
                onChange={(b) => edit((d) => (d.mine.keypointReview = b))}
                label="Build a per-keypoint review queue"
              />
            </TabsContent>

            {/* ---- YAML ---- */}
            <TabsContent value="yaml" className="mt-2 space-y-2">
              <p className="text-[11px] text-muted-foreground">
                Raw view of the current editor state. Edit and “Apply” to load it back, or use{" "}
                “Save to file” to write an <code>active-learning.yaml</code> you can re-import later
                (the workflow isn’t otherwise persisted across reloads).
              </p>
              <textarea
                className="h-64 w-full resize-none rounded border border-border bg-background p-2 font-mono text-xs"
                value={yamlText}
                spellCheck={false}
                onChange={(e) => setYamlText(e.target.value)}
              />
              {yamlError && <div className="text-xs text-destructive">{yamlError}</div>}
              <div className="flex gap-1.5">
                <Button size="sm" variant="outline" onClick={applyYaml}>
                  Apply YAML → editor
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setYamlText(serializeActiveLearningConfig(draft))}
                >
                  Refresh from editor
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void navigator.clipboard?.writeText(yamlText);
                    toast.success("Copied YAML");
                  }}
                >
                  Copy
                </Button>
                <Button size="sm" variant="outline" onClick={() => void saveToFile()}>
                  <Download className="h-3.5 w-3.5" /> Save to file…
                </Button>
              </div>
            </TabsContent>
          </div>
        </Tabs>

        {(validation.errors.length > 0 || validation.warnings.length > 0) && (
          <div className="max-h-24 overflow-y-auto rounded border border-border p-2 text-[11px]">
            {validation.errors.map((e, i) => (
              <div key={`e${i}`} className="text-destructive">
                • {e}
              </div>
            ))}
            {validation.warnings.map((w, i) => (
              <div key={`w${i}`} className="text-amber-600 dark:text-amber-500">
                • {w}
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save}>Save workflow</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
