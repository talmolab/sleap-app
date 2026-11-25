import { useEffect, useMemo, useState } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "@/lib/notify";
import { useAppStore } from "@/stores/appStore";
import { getSlotLabel, useTrainingStore, type ConfigFile, type ModelType } from "@/stores/trainingStore";
import {
  baseName,
  dirOf,
  readModelFolder,
  reuseCandidatesForSlot,
  reuseModelProblem,
  scanReusableModels,
  type ReusedModel,
  type ScannedModel,
} from "@/lib/reuseTrainedModel";
import { parseTimestampFromRunName } from "@/lib/metrics/loadModelMetrics";

const BROWSE = "__browse__";

/** Model types whose two stages share one anchor part (see syncTopDownAnchor). */
const ANCHOR_PAIR_TYPES: ModelType[] = ["top_down", "top_down_id"];

/**
 * "Use a trained model (don't retrain)" for one head tab — PyQt SLEAP's
 * per-tab "Reuse model" option. Checked: this stage is skipped in training,
 * and the picked model (same head type, same skeleton) goes into
 * post-training inference with the newly trained ones.
 *
 * Desktop only: it lists the trained runs in the project's `models/` folder
 * and can browse to another run folder.
 */
export function ReuseTrainedModelSection({
  slot,
  modelType,
  configFile,
  skeletonNodes,
}: {
  slot: string;
  modelType: ModelType;
  configFile: ConfigFile;
  skeletonNodes: string[];
}) {
  const setConfigReuse = useTrainingStore((s) => s.setConfigReuse);
  const trainingLabelsPath = useTrainingStore((s) => s.config.trainingLabelsPath);
  const projectPath = useAppStore((s) => s.projectPath);
  const [scanned, setScanned] = useState<ScannedModel[] | null>(null);

  const reuse = configFile.reuse ?? null;
  const checked = !!reuse;
  const picked = reuse?.model ?? null;
  const stage = getSlotLabel(slot).replace(" Config", "");

  // Scan when the box is checked (and again if the project moves). The
  // folders are where local training writes: next to the training labels
  // file and next to the project.
  const dirs = useMemo(
    () => [dirOf(trainingLabelsPath), dirOf(projectPath)].filter(Boolean),
    [trainingLabelsPath, projectPath],
  );
  useEffect(() => {
    if (!checked) return;
    let live = true;
    scanReusableModels(dirs)
      .then((found) => { if (live) setScanned(found); })
      .catch(() => { if (live) setScanned([]); });
    return () => { live = false; };
  }, [checked, dirs]);

  const candidates = useMemo(
    () => reuseCandidatesForSlot(scanned ?? [], modelType, slot, skeletonNodes),
    [scanned, modelType, slot, skeletonNodes],
  );

  // The store pins the reused model's anchor part / box settings on the
  // stage that still trains (applyReusePins), here and again at Start.
  const pick = (model: ReusedModel) => setConfigReuse(slot, { model });

  const browse = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({ title: `Select a trained ${stage} model folder`, directory: true });
      if (!selected || typeof selected !== "string") return;
      const fsMod = await import("@tauri-apps/plugin-fs");
      const info = await readModelFolder(selected, {
        readTextFile: (p) => fsMod.readTextFile(p),
        readDir: async (p) => (await fsMod.readDir(p)).map((e) => ({ name: e.name, isDirectory: e.isDirectory })),
      });
      if (!info) {
        toast.error("Not a trained model folder", { description: "It has no training_config.yaml." });
        return;
      }
      if (!info.hasCheckpoint) {
        toast.error("No trained model in that folder", { description: "It has no .ckpt checkpoint file." });
        return;
      }
      const problem = reuseModelProblem(info, modelType, slot, skeletonNodes);
      if (problem) {
        toast.error("Can't use that model here", { description: problem });
        return;
      }
      pick({
        path: info.path,
        runName: info.runName,
        headKey: info.headKey,
        nodeNames: info.nodeNames,
        cropMode: info.cropMode ?? null,
        ...(info.anchorPart !== undefined ? { anchorPart: info.anchorPart } : {}),
        ...(info.bboxSource !== undefined ? { bboxSource: info.bboxSource } : {}),
        ...(info.bboxPadding !== undefined ? { bboxPadding: info.bboxPadding } : {}),
      });
    } catch {
      // Cancelled, or not in the desktop app.
    }
  };

  const labelFor = (m: ReusedModel) => {
    const name = m.runName || baseName(m.path);
    const when = parseTimestampFromRunName(m.runName);
    return when && !name.includes(when) ? `${name} (${when})` : name;
  };

  return (
    <div className="mb-5 pb-4 border-b space-y-2" data-testid={`reuse-model-${slot}`}>
      <label className="flex items-center gap-2 cursor-pointer w-fit">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => setConfigReuse(slot, e.target.checked ? { model: null } : null)}
          className="accent-primary"
          aria-label="Use a trained model"
        />
        <span className="text-sm font-medium">Use a trained model (don't retrain)</span>
      </label>
      {!checked && (
        <p className="text-xs text-muted-foreground">
          Skip training this stage and use a model you already trained instead. It runs in
          post-training inference together with the models trained now.
        </p>
      )}
      {checked && (
        <div className="space-y-1.5 pl-6">
          <Select
            value={picked?.path ?? ""}
            onValueChange={(v) => {
              if (v === BROWSE) {
                void browse();
                return;
              }
              const c = candidates.find((x) => x.model.path === v);
              if (c) pick(c.model);
            }}
          >
            <SelectTrigger className="h-9 text-sm font-mono bg-background" aria-label={`Trained ${stage} model`}>
              <SelectValue placeholder={scanned === null ? "Looking for trained models..." : `Select a trained ${stage} model...`} />
            </SelectTrigger>
            <SelectContent>
              {candidates.map((c) => (
                <SelectItem key={c.model.path} value={c.model.path} disabled={c.compat === "mismatch"}>
                  {labelFor(c.model)}
                  {c.compat === "mismatch" ? " — different skeleton" : c.compat === "unknown" ? " — skeleton not recorded" : ""}
                </SelectItem>
              ))}
              {picked && !candidates.some((c) => c.model.path === picked.path) && (
                <SelectItem value={picked.path}>{labelFor(picked)}</SelectItem>
              )}
              <SelectItem value={BROWSE} className="text-primary font-medium">
                Browse for a model folder...
              </SelectItem>
            </SelectContent>
          </Select>
          {scanned !== null && candidates.length === 0 && !picked && (
            <p className="text-xs text-muted-foreground">
              No trained {stage} models in this project's models folder. Browse to a run folder instead.
            </p>
          )}
          {picked ? (
            <p className="text-xs text-muted-foreground break-all">
              This stage won't be trained. Post-training inference uses{" "}
              <span className="font-mono">{picked.path}</span>
              {ANCHOR_PAIR_TYPES.includes(modelType) && picked.anchorPart !== undefined && (
                <> — the other stage trains with its anchor part ({picked.anchorPart ?? "bounding-box center"}).</>
              )}
            </p>
          ) : (
            <p className="text-xs text-destructive">Pick a trained model, or uncheck the box to train this stage.</p>
          )}
        </div>
      )}
    </div>
  );
}
