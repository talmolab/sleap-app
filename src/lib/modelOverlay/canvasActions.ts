/**
 * Canvas actions for Compare Model Predictions. The project's own instances
 * keep every plain click: clicking, dragging, double-clicking (convert) and
 * Shift+double-click (convert, mark complete) a prediction work exactly as
 * without models shown. A model's pose takes a click only with **Alt**
 * (Option on macOS): Alt+click picks it (the Accept bar appears), Alt+double-
 * click accepts it straight away. Alt+click on one of your user instances
 * still goes to it (Alt+drag moves the whole instance). Kept out of
 * VideoPlayer so the canvas only routes the clicks.
 */
import { commandContext } from "@/commands/CommandContext";
import { AcceptModelPose, matchProjectInstance } from "@/commands/modelOverlayCommands";
import { useAppStore } from "@/stores/appStore";
import { useModelOverlayStore } from "@/stores/modelOverlayStore";
import { confirmDialog } from "@/stores/confirmStore";
import type { ModelOverlayLayer } from "@/canvas/modelOverlayRenderer";

export interface ClickMods {
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/**
 * Who gets a click: the model pose under the pointer, or the project as usual.
 * The model only with Alt alone, a model node under the pointer, and no user
 * instance node there (predictions don't count: Alt is the model gesture).
 */
export function modelClickRoute(
  mods: ClickMods,
  modelNodeHit: boolean,
  projectNodeHit: "user" | "predicted" | null
): "model" | "project" {
  const altOnly = mods.altKey && !mods.shiftKey && !mods.ctrlKey && !mods.metaKey;
  return altOnly && modelNodeHit && projectNodeHit !== "user" ? "model" : "project";
}

export function pickModelPose(layers: readonly ModelOverlayLayer[], layer: number, pose: number): void {
  const l = layers[layer];
  const { video, frameIdx } = useAppStore.getState();
  if (!l || !video) return;
  useModelOverlayStore.getState().setSelected({ modelId: l.modelId, video, frameIdx, poseIdx: pose });
}

/**
 * Accept a model's pose on the current frame. When no prediction matches it
 * but one of your user instances does, ask before replacing that instance
 * (never stack a second instance on a labeled animal); cancelling changes
 * nothing.
 */
export async function acceptModelPose(modelId: string, poseIdx: number): Promise<void> {
  const { models } = useModelOverlayStore.getState();
  const { video, frameIdx, labels, skeleton } = useAppStore.getState();
  const model = models.find((m) => m.id === modelId);
  if (!model || model.video !== video || !labels || !video || !skeleton) return;
  const poses = model.frames.get(frameIdx);
  if (!poses?.[poseIdx]) return;

  let replaceUser = false;
  const lf = labels.find({ video, frameIdx })[0];
  if (lf) {
    const names = skeleton.nodes.map((n) => n.name);
    const pred = matchProjectInstance(lf, poses, poseIdx, names, "predicted");
    const user = pred < 0 ? matchProjectInstance(lf, poses, poseIdx, names, "user") : -1;
    if (user >= 0) {
      const track = lf.instances[user].track?.name;
      replaceUser = await confirmDialog({
        title: "Replace your instance?",
        message: `This animal already has a user instance on this frame${track ? ` (${track})` : ""}.\nReplace it with ${model.name}'s pose? (Undo brings it back.)`,
        confirmLabel: "Replace",
        destructive: true,
      });
      if (!replaceUser) return;
      // The frame may have moved while the dialog was open.
      if (useAppStore.getState().frameIdx !== frameIdx || useAppStore.getState().video !== video) return;
    }
  }
  commandContext.execute(AcceptModelPose, { poses, poseIdx, modelName: model.name, replaceUser });
  useModelOverlayStore.getState().setSelected(null);
  useAppStore.getState().bumpOverlayVersion();
}

/** Accept the picked pose (Accept bar). */
export function acceptSelectedModelPose(): void {
  const sel = useModelOverlayStore.getState().selected;
  if (sel) void acceptModelPose(sel.modelId, sel.poseIdx);
}
