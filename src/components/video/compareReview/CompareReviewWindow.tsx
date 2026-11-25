/**
 * Compare Model Predictions — Review disagreements (opened with "Review" in
 * the corner panel). Side by side: a large window shows
 * the current disagreement once per model — each pane has only that model's
 * pose on the frame (zoomed to the animal, or the whole frame), with the
 * models' average as white crosses and the disputed nodes ringed red — plus
 * an "all models" pane. Worst disagreements first. One decision per item:
 * "Use this one" under a model (its pose becomes a user instance, undoable),
 * "None are right" (go label it by hand in the main view), or "Skip" (either
 * is fine). ◀ ▶ or ← → step through; click the item number (or the frame)
 * in the header to jump. The window fills the screen like Label QC Review:
 * cards share the space, up to 4 per row (more wrap). Only disagreements above the window's own
 * threshold (default 25 px) are listed.
 *
 * Claude's corrections of predictions are reviewed here too (claudeEntries.ts):
 * a "Claude's suggestion" pane joins the item for that animal, and a
 * correction no models disagree on (or with no models loaded) is an item of
 * its own, next to the project's prediction.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, ChevronLeft, ChevronRight, PenLine, SkipForward, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { rgbToCSS } from "@/lib/colorPalettes";
import { useAppStore } from "@/stores/appStore";
import { isReviewed, useCompareReviewStore } from "@/stores/compareReviewStore";
import { cropAround, disputedNodeMarks, itemRings } from "@/lib/modelOverlay/review";
import { videoDims } from "@/lib/modelOverlay/core";
import { acceptForItem, keysBelongElsewhere, labelByHand, useReviewQueue } from "./useReviewQueue";
import { ModelCropCanvas, type CropPose } from "./ModelCropCanvas";
import {
  JumpNumber,
  nearestItemToFrame,
  ProjectInstancesKey,
  QueueStatus,
  ReviewSummary,
  ReviewThresholdInput,
  useProjectPoses,
} from "./reviewParts";
import { useModelOverlayStore } from "@/stores/modelOverlayStore";
import { useProposalStore } from "@/stores/proposalStore";
import { buildEntries, correctedPoseXy, proposalPoseXy, type ReviewEntry } from "./claudeEntries";
import { ClaudePane, entryDone, PredictionPane } from "./ClaudePanes";

/** Height under a card's picture for its name and buttons (Claude's text can make it taller; the area scrolls). */
export const CARD_FOOTER_PX = 76;

/**
 * Card sizes for `n` cards in a body of `width` × `height` CSS px: at most 4
 * per row (the rest wrap to another row), pictures as large as fit, never
 * wider than tall.
 */
export function cardLayout(n: number, width: number, height: number) {
  const W = width > 0 ? width : 1000;
  const H = height > 0 ? height : 600;
  const gap = 8;
  const cols = Math.max(1, Math.min(4, n));
  const rows = Math.max(1, Math.ceil(n / cols));
  // 10 = the card's padding and border.
  const cardWidth = Math.max(120, Math.floor((W - gap * (cols - 1)) / cols) - 10);
  const perRow = (H - gap * (rows - 1)) / rows - CARD_FOOTER_PX;
  const cardHeight = Math.max(120, Math.floor(Math.min(cardWidth, perRow)));
  return { cols, rows, cardWidth, cardHeight };
}

/** The element's content size, kept up to date (0 × 0 until measured). */
function useElementSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      setSize((prev) => (Math.abs(prev.width - width) < 1 && Math.abs(prev.height - height) < 1 ? prev : { width, height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

/** The window, when open and models are loaded (mounted once, by VideoPlayer). */
export function CompareReviewWindow() {
  const open = useCompareReviewStore((s) => s.open);
  const setOpen = useCompareReviewStore((s) => s.setOpen);
  const hasModels = useModelOverlayStore((s) => s.models.length > 0);
  const video = useAppStore((s) => s.video);
  const hasClaude = useProposalStore((s) => s.proposals.some((p) => p.kind === "correct"));
  if (!open || !(hasModels || hasClaude) || !video) return null;
  return <ReviewWindow onClose={() => setOpen(false)} />;
}

export function ReviewWindow({ onClose }: { onClose: () => void }) {
  const { shown, progress, items: groups, truncated, totalFrames, threshold } = useReviewQueue();
  const video = useAppStore((s) => s.video);
  const labels = useAppStore((s) => s.labels);
  const skeleton = useAppStore((s) => s.skeleton);
  const decisions = useCompareReviewStore((s) => s.decisions);
  const skip = useCompareReviewStore((s) => s.skip);
  const proposals = useProposalStore((s) => s.proposals);
  // The item on view, by key: Claude's items are listed before the models' have been found, so a position would move.
  const [posKey, setPosKey] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(true);
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodySize = useElementSize(bodyRef);

  const edges = useMemo(() => skeleton?.edgeIndices ?? [], [skeleton]);
  const nodeNames = useMemo(() => skeleton?.nodes.map((n) => n.name) ?? [], [skeleton]);
  // The models' disagreements plus Claude's corrections on this video, worst first.
  const items = useMemo<ReviewEntry[]>(() => {
    const videoIdx = labels && video ? labels.videos.indexOf(video) : -1;
    const corrections = proposals.filter((p) => p.kind === "correct" && p.videoIdx === videoIdx);
    return buildEntries(groups, corrections, nodeNames);
  }, [groups, proposals, labels, video, nodeNames]);
  const done = (e: ReviewEntry) => entryDone(isReviewed(decisions[e.key]), e.claude);

  // Start at the worst item not decided yet, then stay put until the user moves
  // (a decision on this item must not make the view jump to another one).
  const firstOpen = Math.max(0, items.findIndex((e) => !done(e)));
  const keyed = posKey === null ? -1 : items.findIndex((e) => e.key === posKey);
  const at = keyed >= 0 ? keyed : firstOpen;
  const setPos = (i: number) => {
    const e = items[Math.max(0, Math.min(items.length - 1, i))];
    if (e) setPosKey(e.key);
  };
  useEffect(() => {
    if (posKey === null && items.length > 0) setPosKey(items[firstOpen].key);
  }, [posKey, items, firstOpen]);
  // Opened on one of Claude's suggestions (the toast, the Environment panel): show it.
  const focus = useCompareReviewStore((s) => s.focusProposal);
  useEffect(() => {
    if (!focus) return;
    const e = items.find((x) => x.claude?.id === focus);
    if (e) {
      setPosKey(e.key);
      useCompareReviewStore.getState().setFocusProposal(null);
    }
  }, [focus, items]);
  const entry = items[Math.min(at, items.length - 1)];
  const item = entry?.kind === "models" ? entry.group : undefined;
  useEffect(() => {
    if (!entry) return;
    const app = useAppStore.getState();
    if (app.frameIdx !== entry.frame) app.setFrameIdx(entry.frame);
  }, [entry]);
  const go = (d: number) => setPos(at + d);
  /** After a decision: the next item not decided yet (else just the next one). */
  const next = () => {
    for (let i = at + 1; i < items.length; i++) if (!done(items[i])) return setPos(i);
    go(1);
  };

  const dims = video ? videoDims(video) : null;
  const crop = useMemo(() => {
    if (!entry || !zoomed) return null;
    const poses = entry.kind === "models" ? entry.group.members.map((m) => m.xy) : [];
    if (entry.claude) poses.push(proposalPoseXy(entry.claude, nodeNames), correctedPoseXy(entry.claude, nodeNames));
    return cropAround(poses, dims?.width ?? null, dims?.height ?? null, 0.5);
  }, [entry, zoomed, dims?.width, dims?.height, nodeNames]);
  const rings = useMemo(() => (item ? itemRings(item) : []), [item]);
  // Name tags on the disputed nodes: at the average in "All models", at each model's own points in its pane.
  const averageMarks = useMemo(() => (item ? disputedNodeMarks(item, nodeNames) : []), [item, nodeNames]);
  const modelMarks = useMemo(
    () => new Map(item ? item.members.map((m) => [m.modelId, disputedNodeMarks(item, nodeNames, m.xy)]) : []),
    [item, nodeNames]
  );
  const framePoses = useProjectPoses(entry?.frame ?? null);
  // Drawn in the cards only when the window's own eye toggle is on (off on open; H is the canvas's).
  const showProject = useCompareReviewStore((s) => s.showProjectInstances);
  const projectPoses = showProject ? framePoses : undefined;
  const allPoses = useMemo<CropPose[]>(
    () =>
      item
        ? item.members.flatMap((m) => {
            const model = shown.find((x) => x.id === m.modelId);
            return model ? [{ modelId: m.modelId, color: model.color, xy: m.xy }] : [];
          })
        : [],
    [item, shown]
  );

  // Keyboard: ← → step, Esc closes (only while this window is open).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Leave keys to "Replace your instance?" and other dialogs / text fields.
      if (keysBelongElsewhere(e)) return;
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });

  const key = entry?.key ?? "";
  const d = decisions[key];
  const onlyClaude = shown.length < 2;

  // The cards for this item, in order. Each draws its picture at the size given.
  const cards: { id: string; render: (w: number, h: number) => ReactNode }[] = [];
  if (entry?.kind === "claude" && video) {
    cards.push({
      id: "prediction",
      render: (w, h) => (
        <PredictionPane
          proposal={entry.claude}
          entryKey={entry.key}
          video={video}
          frame={entry.frame}
          crop={crop}
          nodeNames={nodeNames}
          edges={edges}
          width={w}
          height={h}
          projectPoses={projectPoses}
          onDecided={next}
        />
      ),
    });
  }
  if (item && video) {
    cards.push({
      id: "all",
      render: (w, h) => (
        <div className="flex flex-col rounded border border-border p-1">
          <ModelCropCanvas
            video={video}
            frame={item.frame}
            crop={crop}
            poses={allPoses}
            consensus={null}
            rings={rings}
            marks={averageMarks}
            projectPoses={projectPoses}
            edges={edges}
            width={w}
            height={h}
          />
          <div className="whitespace-nowrap px-1 pt-1 font-medium">All models</div>
          <div className="flex items-center gap-1 px-1 pt-1">
            <Button
              size="sm"
              variant={d?.byHand ? "default" : "outline"}
              className="h-7 flex-1 whitespace-nowrap text-[11px]"
              onClick={() => labelByHand(item)}
              title="No model got it right: go to this frame in the main view (this window closes) to label it by hand"
              data-testid="review-none-right"
            >
              <PenLine className="mr-1 h-3 w-3" /> None are right
            </Button>
            <Button
              size="sm"
              variant={d?.skipped ? "default" : "outline"}
              className="h-7 flex-1 whitespace-nowrap text-[11px]"
              onClick={() => {
                skip(key);
                next();
              }}
              title="Either is acceptable: leave it as is and go to the next one"
              data-testid="review-skip"
            >
              <SkipForward className="mr-1 h-3 w-3" /> Skip
            </Button>
          </div>
        </div>
      ),
    });
    for (const m of item.members) {
      const model = shown.find((x) => x.id === m.modelId);
      if (!model) continue;
      const accepted = d?.accepted === m.modelId;
      cards.push({
        id: m.modelId,
        render: (w, h) => (
          <div
            className={`flex flex-col rounded border p-1 ${accepted ? "border-green-500 bg-green-500/10" : "border-border"}`}
            data-testid="review-pane"
          >
            <ModelCropCanvas
              video={video}
              frame={item.frame}
              crop={crop}
              poses={[{ modelId: m.modelId, color: model.color, xy: m.xy }]}
              consensus={item.consensus}
              rings={rings}
              marks={modelMarks.get(m.modelId)}
              projectPoses={projectPoses}
              edges={edges}
              width={w}
              height={h}
            />
            <div className="flex items-center gap-1 px-1 pt-1">
              <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: rgbToCSS(model.color) }} />
              <span className="min-w-0 flex-1 truncate whitespace-nowrap" title={model.source}>
                {model.name}
              </span>
              <span className="tabular-nums text-muted-foreground" title="Mean distance of its nodes from the models' average">
                {Number.isFinite(m.distance) ? `${m.distance.toFixed(1)} px` : "–"}
              </span>
            </div>
            <div className="px-1 pt-1">
              <Button
                size="sm"
                variant={accepted ? "default" : "outline"}
                className="h-7 w-full whitespace-nowrap text-[11px]"
                onClick={() => void acceptForItem(item, m.modelId).then((ok) => ok && next())}
                title="Make this model's pose a user instance (replaces the matching prediction; asks before replacing your own instance; ⌘Z undoes), then the next one"
                data-testid="review-use"
              >
                <Check className="mr-1 h-3 w-3" /> Use this one
              </Button>
            </div>
          </div>
        ),
      });
    }
  }
  if (entry?.claude && video) {
    const claude = entry.claude;
    cards.push({
      id: "claude",
      render: (w, h) => (
        <ClaudePane
          proposal={claude}
          video={video}
          frame={entry.frame}
          crop={crop}
          nodeNames={nodeNames}
          edges={edges}
          width={w}
          height={h}
          onDecided={next}
        />
      ),
    });
  }

  const layout = cardLayout(cards.length, bodySize.width, bodySize.height);

  return (
    <>
      {/* The scrim dims the rest of the app, as the Label QC Review window does. */}
      <div className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" data-testid="review-scrim" onMouseDown={(e) => e.stopPropagation()} />
      <div
        className="fixed inset-6 z-50 m-auto flex max-h-[920px] max-w-[1280px] flex-col overflow-hidden rounded-lg border border-border bg-background text-xs shadow-2xl"
        data-testid="review-window"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="whitespace-nowrap text-sm font-semibold">{onlyClaude ? "Review Claude's suggestions" : "Review disagreements"}</span>
          <ReviewThresholdInput />
          <span className="flex-1" />
          <label htmlFor="review-zoom" className="flex items-center gap-1.5 whitespace-nowrap">
            <Checkbox id="review-zoom" checked={zoomed} onCheckedChange={(v) => setZoomed(v === true)} />
            Zoom to the animal
          </label>
          <Button size="sm" variant="outline" className="h-7 w-7 p-0" onClick={() => go(-1)} disabled={!entry || at === 0} aria-label="Previous">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[9rem] whitespace-nowrap text-center tabular-nums" data-testid="review-position">
            {entry ? (
              <>
                <JumpNumber
                  value={at + 1}
                  min={1}
                  max={items.length}
                  onCommit={(n) => setPos(n - 1)}
                  label="Go to item number"
                  testId="review-jump-item"
                />{" "}
                / {items.length} · frame{" "}
                <JumpNumber
                  value={entry.frame}
                  min={0}
                  max={Number.MAX_SAFE_INTEGER}
                  onCommit={(f) => setPos(nearestItemToFrame(items, f))}
                  label="Go to the item nearest this frame"
                  testId="review-jump-frame"
                />
                {item?.trackName ? ` · ${item.trackName}` : ""}
                {entry.kind === "claude" ? " · Claude" : ""}
              </>
            ) : (
              "–"
            )}
          </span>
          <Button size="sm" variant="outline" className="h-7 w-7 p-0" onClick={() => go(1)} disabled={!entry || at >= items.length - 1} aria-label="Next">
            <ChevronRight className="h-4 w-4" />
          </Button>
          <button type="button" className="ml-2 rounded p-1 hover:bg-muted" onClick={onClose} aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        {onlyClaude && items.length > 0 ? (
          <div className="px-2 py-1 text-muted-foreground" data-testid="review-status">
            No models to compare are shown: listing Claude&apos;s suggestions, each next to the project&apos;s prediction.
          </div>
        ) : (
          <QueueStatus progress={progress} count={groups.length} truncated={truncated} totalFrames={totalFrames} threshold={threshold} shown={shown.length} />
        )}
        {entry?.kind === "claude" && video && (
          <div className="px-3 pb-1 text-muted-foreground" data-testid="review-claude-only">
            Claude&apos;s suggestion for a prediction no models disagree on{entry.sortPx > 0 ? ` · moves a node up to ${entry.sortPx.toFixed(0)} px` : ""} · changed nodes are named on the panes
          </div>
        )}
        {item && video && (
          <div className="px-3 pb-1 text-muted-foreground">
            {item.flagged.length > 1 ? `${item.flagged.length} nodes disagree on this animal: ` : "Disputed: "}
            <span data-testid="review-disputed">
              {item.flagged.map((k) => `${nodeNames[k] ?? k} (${item.spread[k].toFixed(0)} px)`).join(", ")}
            </span>{" "}
            · each is ringed and named on the panes · white crosses = the models' average
          </div>
        )}
        {cards.length > 0 && (
          <div className="flex items-center gap-2 px-3 pb-1">
            <ProjectInstancesKey count={framePoses ? framePoses.length : null} />

          </div>
        )}
        {/* The cards fill the rest of the window: up to 4 per row, the rest wrap. */}
        <div ref={bodyRef} className="min-h-0 flex-1 overflow-auto px-3 pb-2" data-testid="review-body">
          <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${layout.cols}, minmax(0, 1fr))` }}>
            {cards.map((c) => (
              <div key={c.id} className="min-w-0">
                {c.render(layout.cardWidth, layout.cardHeight)}
              </div>
            ))}
          </div>
        </div>
        <ReviewSummary items={groups} entries={items} />
      </div>
    </>
  );
}
