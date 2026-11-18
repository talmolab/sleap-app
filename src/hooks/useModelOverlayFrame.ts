/**
 * The Compare Model Predictions layers for the frame on screen: each visible
 * model loaded for the current video, with its poses on this frame. Empty
 * when no model is loaded for this video, so the canvas skips the overlay.
 */
import { useMemo } from "react";
import { useAppStore } from "@/stores/appStore";
import { useModelOverlayStore, type OverlayModel } from "@/stores/modelOverlayStore";
import type { ModelOverlayLayer } from "@/canvas/modelOverlayRenderer";
import type { Video } from "@/types";

/** Pure: the layers for `video` at `frameIdx`. */
export function modelOverlayLayers(
  models: readonly OverlayModel[],
  video: Video | null,
  frameIdx: number
): ModelOverlayLayer[] {
  if (!video) return [];
  const out: ModelOverlayLayer[] = [];
  for (const m of models) {
    if (!m.visible || m.video !== video) continue;
    const poses = m.frames.get(frameIdx);
    if (poses && poses.length > 0) out.push({ modelId: m.id, color: m.color, poses });
  }
  return out;
}

export function useModelOverlayFrame(): ModelOverlayLayer[] {
  const models = useModelOverlayStore((s) => s.models);
  const video = useAppStore((s) => s.video);
  const frameIdx = useAppStore((s) => s.frameIdx);
  return useMemo(() => modelOverlayLayers(models, video, frameIdx), [models, video, frameIdx]);
}
