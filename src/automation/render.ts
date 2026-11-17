/**
 * Off-screen picture of one flagged instance for Claude: the video frame
 * cropped around the instance, enlarged, with every pose drawn and node names
 * on. The flagged instance is drawn at full strength and the others dimmed.
 * The user's view doesn't move.
 *
 * Each render gets a `render_id` that remembers its transform, so a later
 * `propose_fix` can take positions in the picture's own pixels.
 */
import { useAppStore } from "@/stores/appStore";
import { buildExportRenderedInstances } from "@/lib/videoExport";
import { FOCUS_DIM_OPACITY, renderInstances } from "@/canvas/SkeletonRenderer";
import { frameToCanvas } from "@/lib/frameCanvas";
import { cropOrigin, toImageCoords } from "@/lib/cropTransform";
import { poseOf, type PoseSnapshot } from "@/stores/proposalStore";
import { AutomationError } from "./errors";
import { findQcFlag, flagTarget, requireLabels } from "./qcFlags";
import { frameToRender, instanceBBox, planCrop, type RenderTransform } from "./coords";

/** Long-edge budget: Claude's vision downsizes anything larger. */
export const DEFAULT_MAX_EDGE = 1092;
/** How many render transforms to remember (oldest dropped first). */
const MAX_RENDERS = 50;

export interface RenderRecord {
  renderId: string;
  /** The project it was rendered from; a render from another project is refused. */
  labels?: object | null;
  /** The flagged instance's pose when rendered (what Claude looked at). */
  pose?: PoseSnapshot;
  flagId: string;
  videoIdx: number;
  frameIdx: number;
  instIdx: number | null;
  transform: RenderTransform;
  width: number;
  height: number;
}

const renders = new Map<string, RenderRecord>();
let renderSeq = 0;

/** Remember a render's transform under a new id. */
export function rememberRender(r: Omit<RenderRecord, "renderId">): RenderRecord {
  const rec = { ...r, renderId: `r${++renderSeq}` };
  renders.set(rec.renderId, rec);
  while (renders.size > MAX_RENDERS) renders.delete(renders.keys().next().value!);
  return rec;
}

export function getRender(renderId: string): RenderRecord {
  const r = renders.get(renderId);
  if (!r || (r.labels && r.labels !== useAppStore.getState().labels)) {
    throw new AutomationError(
      "UNKNOWN_RENDER",
      `Unknown render_id "${renderId}" (only the last ${MAX_RENDERS} are kept). Call render_flag again.`,
    );
  }
  return r;
}

/** Forget every render (tests; project change). */
export function clearRenders(): void {
  renders.clear();
}

// A render's transform belongs to one project's video: forget them all when
// another project loads.
useAppStore.subscribe((s, prev) => {
  if (s.labels !== prev.labels) clearRenders();
});

export interface RenderedNodeInfo {
  name: string;
  /** Position in the picture's pixels; null when the node isn't placed. */
  x: number | null;
  y: number | null;
  visible: boolean;
}

export interface FlagRender extends RenderRecord {
  png: Uint8Array;
  /** The flagged instance's nodes, in render pixels. */
  nodes: RenderedNodeInfo[];
}

const round1 = (v: number) => Math.round(v * 10) / 10;

/** Render a flag's instance (or, for a frame-level flag, the whole frame). */
export async function renderFlag(flagId: string, opts: { maxEdge?: number } = {}): Promise<FlagRender> {
  const labels = requireLabels();
  const flag = findQcFlag(flagId);
  const { lf, instance } = flagTarget(labels, flag);
  const video = lf.video;

  let frame: OffscreenCanvas | null = null;
  try {
    const raw = await (
      video as unknown as { getFrame: (i: number, o?: { prefetch?: boolean }) => Promise<unknown> }
    ).getFrame(flag.frameIdx, { prefetch: false });
    // frameToCanvas copies, so a backend that reuses its bitmap can't change it under us.
    frame = await frameToCanvas(raw, video.shape);
  } catch {
    frame = null;
  }
  if (!frame) {
    throw new AutomationError(
      "RENDER_FAILED",
      `Couldn't read frame ${flag.frameIdx} of video ${flag.videoIdx}. Is the video file available?`,
    );
  }

  const imagePts = (instance?.points ?? []).map((p) => {
    const [x, y] = toImageCoords(video, p.xy[0], p.xy[1]);
    return { xy: [x, y] as [number, number], visible: p.visible };
  });
  const crop = planCrop({
    bbox: instance ? instanceBBox(imagePts) : null,
    frameW: frame.width,
    frameH: frame.height,
    maxEdge: opts.maxEdge ?? DEFAULT_MAX_EDGE,
    pad: 0.5,
  });
  const offset = cropOrigin(video) ?? [0, 0];
  const transform: RenderTransform = {
    originX: crop.originX,
    originY: crop.originY,
    scale: crop.scale,
    offsetX: offset[0],
    offsetY: offset[1],
  };
  const width = Math.max(1, Math.round(crop.width * crop.scale));
  const height = Math.max(1, Math.round(crop.height * crop.scale));

  const out = new OffscreenCanvas(width, height);
  const ctx = out.getContext("2d");
  if (!ctx) throw new AutomationError("RENDER_FAILED", "Couldn't create a canvas to draw on.");
  ctx.imageSmoothingEnabled = crop.scale < 1;
  ctx.setTransform(crop.scale, 0, 0, crop.scale, -crop.originX * crop.scale, -crop.originY * crop.scale);
  ctx.drawImage(frame, 0, 0);

  const app = useAppStore.getState();
  // Color by node so each node is easy to tell apart, whatever the view uses.
  const rendered = buildExportRenderedInstances(lf.instances, {
    palette: app.palette,
    distinctlyColor: "node",
    colorPredicted: true,
    showNonVisibleNodes: true,
    tracks: labels.tracks ?? [],
    video,
  });
  const focusIdx = instance ? lf.instances.indexOf(instance) : -1;
  const draw = (list: typeof rendered, extra: { showLabels: boolean; poseOpacity: number }) =>
    renderInstances(ctx as unknown as CanvasRenderingContext2D, list, {
      markerSize: Math.max(app.markerSize, 4),
      nodeLabelSize: 13,
      edgeStyle: app.edgeStyle,
      showInstances: true,
      showEdges: true,
      showNonVisibleNodes: true,
      colorPredicted: true,
      zoom: crop.scale,
      ...extra,
    });
  if (focusIdx >= 0) {
    // Others dimmed and unlabeled, so every name in the picture is the flagged instance's.
    draw(rendered.filter((_, i) => i !== focusIdx), { showLabels: false, poseOpacity: FOCUS_DIM_OPACITY });
    draw([rendered[focusIdx]], { showLabels: true, poseOpacity: 1 });
  } else {
    draw(rendered, { showLabels: true, poseOpacity: 1 });
  }

  const blob = await out.convertToBlob({ type: "image/png" });
  const png = new Uint8Array(await blob.arrayBuffer());

  const rec = rememberRender({
    labels,
    pose: instance ? poseOf(instance) : undefined,
    flagId: flag.id,
    videoIdx: flag.videoIdx,
    frameIdx: flag.frameIdx,
    instIdx: flag.instIdx,
    transform,
    width,
    height,
  });
  const names = instance?.skeleton.nodeNames ?? [];
  const nodes: RenderedNodeInfo[] = (instance?.points ?? []).map((p, i) => {
    const placed = Number.isFinite(p.xy[0]) && Number.isFinite(p.xy[1]);
    const [rx, ry] = placed ? frameToRender(transform, p.xy[0], p.xy[1]) : [NaN, NaN];
    return {
      name: names[i] ?? `node ${i + 1}`,
      x: placed ? round1(rx) : null,
      y: placed ? round1(ry) : null,
      visible: p.visible && placed,
    };
  });
  return { ...rec, png, nodes };
}
