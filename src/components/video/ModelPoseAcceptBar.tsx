/**
 * Bar at the top of the canvas after clicking a model's pose (Compare Model
 * Predictions): names the model and offers Accept, which makes the pose a
 * user instance replacing the matching prediction (see AcceptModelPose).
 * Opened by Alt+click on a model's pose; Alt+double-click accepts without the bar.
 */
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/stores/appStore";
import { useModelOverlayStore } from "@/stores/modelOverlayStore";
import { rgbToCSS } from "@/lib/colorPalettes";
import { acceptSelectedModelPose } from "@/lib/modelOverlay/canvasActions";

export function ModelPoseAcceptBar() {
  const sel = useModelOverlayStore((s) => s.selected);
  const models = useModelOverlayStore((s) => s.models);
  const setSelected = useModelOverlayStore((s) => s.setSelected);
  const video = useAppStore((s) => s.video);
  const frameIdx = useAppStore((s) => s.frameIdx);
  if (!sel || sel.video !== video || sel.frameIdx !== frameIdx) return null;
  const model = models.find((m) => m.id === sel.modelId);
  const pose = model?.frames.get(frameIdx)?.[sel.poseIdx];
  if (!model || !pose) return null;

  return (
    <div
      className="absolute top-2 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 rounded-md bg-black/75 px-2 py-1.5 text-xs text-white shadow-lg backdrop-blur-sm pointer-events-auto"
      data-testid="model-pose-accept-bar"
      onMouseDown={(e) => e.stopPropagation()}
    >
      <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: rgbToCSS(model.color) }} />
      <span className="max-w-[16rem] truncate">
        {model.name}
        {pose.trackName ? ` · ${pose.trackName}` : ""}
        {pose.score !== null ? ` · score ${pose.score.toFixed(2)}` : ""}
      </span>
      <Button
        size="sm"
        className="h-6 px-2 text-xs"
        onClick={acceptSelectedModelPose}
        title="Make this pose a user instance, replacing the matching prediction on this frame (undoable). Alt+double-click a model's pose does the same."
      >
        <Check className="mr-1 h-3 w-3" /> Accept
      </Button>
      <button
        type="button"
        className="rounded p-0.5 text-white/60 hover:bg-white/10 hover:text-white"
        onClick={() => setSelected(null)}
        aria-label="Cancel"
        title="Cancel"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
