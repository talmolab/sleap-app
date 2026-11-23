/**
 * The Compare Model Predictions overlay for the frame on screen: each visible
 * model loaded for the current video, with its poses on this frame, plus the
 * nodes where those models disagree (when the highlight is on) and the pose
 * picked for Accept. Empty when no model is loaded for this video, so the
 * canvas skips the overlay.
 */
import { useEffect, useMemo } from "react";
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
import { disagreementIndexFor, fillIndexAsync, nextDisagreement } from "@/lib/modelOverlay/disagreementIndex";

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
  useDisagreementWarmup(models, video);
  return useMemo(() => ({ layers, disagreements, selected }), [layers, disagreements, selected]);
}

/**
 * The next (dir 1) or previous (dir -1) frame after `from` where the shown
 * models disagree on any node, or null. Only frames where two or more models
 * have poses are checked. Goes through the cached per-frame spread index
 * (lib/modelOverlay/disagreementIndex.ts), so repeated presses and threshold
 * changes don't redo the matching.
 */
export function findDisagreementFrame(
  models: readonly OverlayModel[],
  video: Video | null,
  threshold: number,
  from: number,
  dir: 1 | -1
): number | null {
  return nextDisagreement(disagreementIndexFor(models, video), threshold, from, dir);
}

/**
 * While two or more models are shown, work out the disagreement index in the
 * background (small slices between frames), so ◀ ▶ on a long video is a
 * lookup by the time the user presses it.
 */
export function useDisagreementWarmup(models: readonly OverlayModel[], video: Video | null): void {
  useEffect(() => {
    const index = disagreementIndexFor(models, video);
    if (index.models.length < 2 || index.computed >= index.frames.length) return;
    const ctrl = new AbortController();
    // Start after the first paint of the new models.
    const t = setTimeout(() => void fillIndexAsync(index, { signal: ctrl.signal, sliceMs: 8 }), 300);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [models, video]);
}
