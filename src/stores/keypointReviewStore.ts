/**
 * Keypoint review mode (Labels ▸ Review One Node…, or a node's menu in the
 * Skeleton panel): go through the labels checking only one node, one
 * instance at a time.
 *
 * Each step selects the instance, zooms to a fixed crop centred on the node
 * (the canvas does that on `fitNonce`), and dims the other instances. Then:
 * a click on the image moves the node there, Enter / → keeps it, V marks it
 * not visible (each moves on), ← / Backspace goes back, Esc stops. Every
 * change is one SetNodes undo step.
 */
import { create } from "zustand";
import { useAppStore } from "@/stores/appStore";
import { qcView, useQcStore } from "@/stores/qcStore";
import { commandContext, SetNodes } from "@/commands";
import { anomalyVerdict } from "@/lib/analyze/qc/anomaly";
import {
  buildKeypointQueue,
  keypointItemKey,
  type KeypointReviewItem,
  type KeypointReviewSource,
} from "@/lib/keypointReview";
import { toSourceCoords } from "@/lib/cropTransform";
import { toast } from "@/lib/notify";
import type { Labels, Skeleton } from "@/types";

interface KeypointReviewState {
  active: boolean;
  node: number;
  source: KeypointReviewSource;
  skeleton: Skeleton | null;
  queue: KeypointReviewItem[];
  /** Position in `queue`. */
  pos: number;
  /** How many nodes were moved or hidden this session. */
  changed: number;
  /** Bumped on each step: the canvas zooms to the node. */
  fitNonce: number;
}

const initial: KeypointReviewState = {
  active: false,
  node: 0,
  source: "all",
  skeleton: null,
  queue: [],
  pos: 0,
  changed: 0,
  fitNonce: 0,
};

export const useKeypointReviewStore = create<KeypointReviewState>(() => initial);

/** The instances Label QC flagged with `node` behind the flag (its last run, current threshold). */
export function qcBlamedKeys(labels: Labels, node: number): Set<string> {
  const qc = useQcStore.getState();
  const out = new Set<string>();
  if (qc.state !== "done" || qc.labels !== labels) return out;
  const view = qcView(qc);
  const gmmThreshold = view.anomaly?.gmmThreshold ?? null;
  for (const a of view.anomaly?.instances ?? []) {
    if (!anomalyVerdict(a, view.threshold, gmmThreshold).flagged) continue;
    if (a.issueNodes.includes(node) || a.gmmNode === node) {
      out.add(keypointItemKey(a.videoIdx, a.frameIdx, a.instIdx));
    }
  }
  return out;
}

function rebuild(node: number, source: KeypointReviewSource): KeypointReviewItem[] {
  const { labels } = useAppStore.getState();
  const { skeleton } = useKeypointReviewStore.getState();
  if (!labels || !skeleton) return [];
  return buildKeypointQueue(labels, {
    skeleton,
    node,
    source,
    qcBlamed: source === "qc" ? qcBlamedKeys(labels, node) : undefined,
  });
}

/** The item on screen, if any. */
export function currentKeypointItem(): KeypointReviewItem | null {
  const s = useKeypointReviewStore.getState();
  return s.active ? (s.queue[s.pos] ?? null) : null;
}

/** Go to the item at `pos` (clamped): its frame, instance selected, zoomed to the node. */
function goTo(pos: number): void {
  const s = useKeypointReviewStore.getState();
  const item = s.queue[pos];
  const app = useAppStore.getState();
  if (!item || !app.labels) {
    useKeypointReviewStore.setState({ pos: 0 });
    app.setInstance(null);
    return;
  }
  const video = app.labels.videos[item.videoIdx];
  if (!video) return;
  if (app.video !== video) app.setVideo(video);
  app.setFrameIdx(item.frameIdx);
  const lf = app.labels.find({ video, frameIdx: item.frameIdx })[0];
  app.setInstance(lf?.userInstances[item.instIdx] ?? null);
  useKeypointReviewStore.setState({ pos, fitNonce: s.fitNonce + 1 });
}

/**
 * Start reviewing `node` of `skeleton` (defaults: the selected instance's
 * skeleton, else the active one; the last node reviewed on it, else its
 * first). Starts on the selected instance if it's in the list, else at the top.
 */
export function openKeypointReview(
  opts: { node?: number; source?: KeypointReviewSource; skeleton?: Skeleton | null } = {},
): void {
  const { node, source } = opts;
  const app = useAppStore.getState();
  const skeleton = opts.skeleton ?? app.instance?.skeleton ?? app.skeleton;
  if (!app.labels || !skeleton) return;
  if (skeleton.nodes.length === 0) {
    toast.info("Review One Node: the skeleton has no nodes.");
    return;
  }
  useQcStore.getState().setReviewOpen(false);
  if (app.labelingMode === "place") app.exitPlacementMode();
  const prev = useKeypointReviewStore.getState();
  const n = node ?? (prev.skeleton === skeleton ? prev.node : 0);
  const src = source ?? prev.source;
  useKeypointReviewStore.setState({ ...initial, active: true, skeleton, node: n, source: src, fitNonce: prev.fitNonce });
  const queue = rebuild(n, src);
  useKeypointReviewStore.setState({ queue });
  if (queue.length === 0) {
    toast.info("No labeled instances to review for this choice.");
  }
  const videoIdx = app.video ? app.labels.videos.indexOf(app.video) : -1;
  const lf = app.labeledFrame;
  const instIdx = app.instance && lf ? lf.userInstances.indexOf(app.instance) : -1;
  const here = queue.findIndex(
    (it) => it.videoIdx === videoIdx && it.frameIdx === app.frameIdx && it.instIdx === instIdx,
  );
  goTo(here >= 0 ? here : 0);
}

export function closeKeypointReview(): void {
  if (!useKeypointReviewStore.getState().active) return;
  useKeypointReviewStore.setState({ active: false, queue: [] });
  useAppStore.getState().bumpOverlayVersion();
}

/** Switch the node or the source: rebuild the list and start at its top. */
export function setKeypointReview(change: { node?: number; source?: KeypointReviewSource }): void {
  const s = useKeypointReviewStore.getState();
  if (!s.active) return;
  const node = change.node ?? s.node;
  const source = change.source ?? s.source;
  useKeypointReviewStore.setState({ node, source });
  const queue = rebuild(node, source);
  useKeypointReviewStore.setState({ queue });
  if (queue.length === 0) toast.info("No labeled instances to review for this choice.");
  goTo(0);
}

/** Next (1) or previous (-1) instance. At the end it stays and says so. */
export function stepKeypointReview(dir: 1 | -1): void {
  const s = useKeypointReviewStore.getState();
  if (!s.active || s.queue.length === 0) return;
  const next = s.pos + dir;
  if (next >= s.queue.length) {
    toast.info(`That's all ${s.queue.length} — press Esc to stop reviewing.`);
    return;
  }
  if (next < 0) return;
  goTo(next);
}

/** The instance on screen, if it's still the item's (an edit can't move it, but a delete can). */
function itemInstance() {
  const item = currentKeypointItem();
  const app = useAppStore.getState();
  const inst = app.instance;
  if (!item || !inst || !app.labeledFrame) return null;
  return app.labeledFrame.userInstances[item.instIdx] === inst ? inst : null;
}

/** Move the node to `(x, y)` (displayed image coords, as the canvas gives them) and go on. */
export function placeKeypointReviewNode(x: number, y: number): void {
  const s = useKeypointReviewStore.getState();
  const inst = itemInstance();
  if (!inst) return;
  const [sx, sy] = toSourceCoords(useAppStore.getState().video, x, y);
  void commandContext.execute(SetNodes, { nodes: { [s.node]: [sx, sy] } });
  useKeypointReviewStore.setState({ changed: s.changed + 1 });
  stepKeypointReview(1);
}

/** Mark the node not visible and go on. */
export function hideKeypointReviewNode(): void {
  const s = useKeypointReviewStore.getState();
  const inst = itemInstance();
  if (!inst) return;
  if (inst.points[s.node]?.visible !== false) {
    void commandContext.execute(SetNodes, { nodes: { [s.node]: null } });
    useKeypointReviewStore.setState({ changed: s.changed + 1 });
  }
  stepKeypointReview(1);
}

/**
 * Keys keypoint review takes over while it's on. Returns whether it took the
 * key (the caller then stops it reaching the app's other shortcuts).
 */
export function handleKeypointReviewKey(e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey">): boolean {
  if (!useKeypointReviewStore.getState().active) return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  switch (e.key) {
    case "Enter":
    case "ArrowRight":
      stepKeypointReview(1);
      return true;
    case "ArrowLeft":
    case "Backspace":
      stepKeypointReview(-1);
      return true;
    case "Escape":
      closeKeypointReview();
      return true;
  }
  if (e.code === "KeyV") {
    hideKeypointReviewNode();
    return true;
  }
  return false;
}

// A different project (or none) ends the review: its list points into the old one.
useAppStore.subscribe((s, prev) => {
  if (s.labels !== prev.labels) closeKeypointReview();
});
