/**
 * The Compare Model Predictions overlay for the frame on screen: each visible
 * model loaded for the current video, with its poses on this frame, plus the
 * nodes where those models disagree (when the highlight is on) and the pose
 * picked for Accept. Empty when no model is loaded for this video, so the
 * canvas skips the overlay.
 */
import { useMemo } from "react";
import { useAppStore } from "@/stores/appStore";
import {
  useModelOverlayStore,
  type OverlayModel,
  type SelectedModelPose,
} from "@/stores/modelOverlayStore";
import type { ModelOverlayLayer } from "@/canvas/modelOverlayRenderer";
import {
  findDisagreements,
  groupAcrossModels,
  modelsShareTracks,
  type Disagreement,
} from "@/lib/modelOverlay/matching";
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

/** Whether matching across the models shown on `video` can go by track name. */
export function shownModelsShareTracks(models: readonly OverlayModel[], video: Video | null): boolean {
  const shown = models.filter((m) => m.visible && m.video === video);
  return modelsShareTracks(shown.map((m) => m.trackNames));
}

/** Pure: the nodes on this frame where the shown models disagree by more than `threshold` px. */
export function frameDisagreements(
  layers: readonly ModelOverlayLayer[],
  byTrack: boolean,
  threshold: number
): Disagreement[] {
  if (layers.length < 2) return [];
  return findDisagreements(layers, groupAcrossModels(layers, byTrack), threshold);
}

export interface ModelOverlayFrame {
  layers: ModelOverlayLayer[];
  disagreements: Disagreement[];
  /** The picked pose, when it's on this frame and its model is shown. */
  selected: { layer: number; pose: number } | null;
}

export function selectedOnFrame(
  layers: readonly ModelOverlayLayer[],
  sel: SelectedModelPose | null,
  video: Video | null,
  frameIdx: number
): { layer: number; pose: number } | null {
  if (!sel || sel.video !== video || sel.frameIdx !== frameIdx) return null;
  const layer = layers.findIndex((l) => l.modelId === sel.modelId);
  if (layer < 0 || sel.poseIdx >= layers[layer].poses.length) return null;
  return { layer, pose: sel.poseIdx };
}

export function useModelOverlayFrame(): ModelOverlayFrame {
  const models = useModelOverlayStore((s) => s.models);
  const highlight = useModelOverlayStore((s) => s.highlightDisagreement);
  const threshold = useModelOverlayStore((s) => s.threshold);
  const sel = useModelOverlayStore((s) => s.selected);
  const video = useAppStore((s) => s.video);
  const frameIdx = useAppStore((s) => s.frameIdx);
  const layers = useMemo(() => modelOverlayLayers(models, video, frameIdx), [models, video, frameIdx]);
  const byTrack = useMemo(() => shownModelsShareTracks(models, video), [models, video]);
  const disagreements = useMemo(
    () => (highlight ? frameDisagreements(layers, byTrack, threshold) : []),
    [layers, byTrack, threshold, highlight]
  );
  const selected = useMemo(() => selectedOnFrame(layers, sel, video, frameIdx), [layers, sel, video, frameIdx]);
  return useMemo(() => ({ layers, disagreements, selected }), [layers, disagreements, selected]);
}

/**
 * The next (dir 1) or previous (dir -1) frame after `from` where the shown
 * models disagree on any node, or null. Only frames where two or more models
 * have poses are checked.
 */
export function findDisagreementFrame(
  models: readonly OverlayModel[],
  video: Video | null,
  threshold: number,
  from: number,
  dir: 1 | -1
): number | null {
  const shown = models.filter((m) => m.visible && m.video === video);
  if (shown.length < 2) return null;
  const counts = new Map<number, number>();
  for (const m of shown) for (const f of m.frames.keys()) counts.set(f, (counts.get(f) ?? 0) + 1);
  const frames = [...counts.entries()]
    .filter(([f, n]) => n >= 2 && (dir === 1 ? f > from : f < from))
    .map(([f]) => f)
    .sort((a, b) => (dir === 1 ? a - b : b - a));
  const byTrack = shownModelsShareTracks(models, video);
  for (const f of frames) {
    if (frameDisagreements(modelOverlayLayers(shown, video, f), byTrack, threshold).length > 0) return f;
  }
  return null;
}
