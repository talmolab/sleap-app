/**
 * Canvas actions for Compare Model Predictions: click a model's pose to pick
 * it (the Accept bar appears), double-click (or the bar's button) to accept
 * it into the project. Kept out of VideoPlayer so the canvas only routes
 * the clicks.
 */
import { commandContext } from "@/commands/CommandContext";
import { AcceptModelPose } from "@/commands/modelOverlayCommands";
import { useAppStore } from "@/stores/appStore";
import { useModelOverlayStore } from "@/stores/modelOverlayStore";
import type { ModelOverlayLayer } from "@/canvas/modelOverlayRenderer";

export function pickModelPose(layers: readonly ModelOverlayLayer[], layer: number, pose: number): void {
  const l = layers[layer];
  const { video, frameIdx } = useAppStore.getState();
  if (!l || !video) return;
  useModelOverlayStore.getState().setSelected({ modelId: l.modelId, video, frameIdx, poseIdx: pose });
}

export function acceptModelPose(modelId: string, poseIdx: number): void {
  const { models } = useModelOverlayStore.getState();
  const { video, frameIdx } = useAppStore.getState();
  const model = models.find((m) => m.id === modelId);
  if (!model || model.video !== video) return;
  const poses = model.frames.get(frameIdx);
  if (!poses?.[poseIdx]) return;
  commandContext.execute(AcceptModelPose, { poses, poseIdx, modelName: model.name });
  useModelOverlayStore.getState().setSelected(null);
  useAppStore.getState().bumpOverlayVersion();
}

/** Accept the picked pose (Accept bar). */
export function acceptSelectedModelPose(): void {
  const sel = useModelOverlayStore.getState().selected;
  if (sel) acceptModelPose(sel.modelId, sel.poseIdx);
}
