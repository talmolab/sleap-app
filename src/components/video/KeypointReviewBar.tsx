/**
 * On-canvas bar for keypoint review (see keypointReviewStore): which node,
 * which instances, where you are, and the keys. Self-guards to the mode, like
 * AnchorPickBar: always rendered, shows nothing outside it.
 *
 * It owns the mode's keys while it's on (a capture listener, so Enter, ← / →,
 * V, Backspace and Esc don't also reach the app's own shortcuts); ⌘Z and the
 * other modifier shortcuts pass through.
 */
import { useEffect } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/stores/appStore";
import {
  closeKeypointReview,
  handleKeypointReviewKey,
  setKeypointReview,
  stepKeypointReview,
  useKeypointReviewStore,
} from "@/stores/keypointReviewStore";
import { KEYPOINT_REVIEW_SOURCES, type KeypointReviewSource } from "@/lib/keypointReview";
import { videoBasename } from "@/lib/videoFilter";
import { formatShortcut } from "@/lib/formatShortcut";

const isTextTarget = (t: EventTarget | null) => {
  const el = t as HTMLElement | null;
  const tag = el?.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el?.isContentEditable === true;
};

const selectClass =
  "h-6 rounded border border-white/15 bg-black/40 px-1 text-xs text-white/90 focus:outline-none focus:ring-1 focus:ring-white/40";

export function KeypointReviewBar() {
  const active = useKeypointReviewStore((s) => s.active);
  const node = useKeypointReviewStore((s) => s.node);
  const source = useKeypointReviewStore((s) => s.source);
  const skeleton = useKeypointReviewStore((s) => s.skeleton);
  const queue = useKeypointReviewStore((s) => s.queue);
  const pos = useKeypointReviewStore((s) => s.pos);
  const changed = useKeypointReviewStore((s) => s.changed);
  const multiVideo = useAppStore((s) => (s.labels?.videos.length ?? 0) > 1);
  const video = useAppStore((s) => s.video);
  const frameIdx = useAppStore((s) => s.frameIdx);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTextTarget(e.target)) return;
      if (!handleKeypointReviewKey(e)) return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [active]);

  if (!active || !skeleton) return null;
  const item = queue[pos];
  const offBy = item?.offBy;

  return (
    <div
      className="pointer-events-auto absolute left-1/2 top-2 z-30 flex max-w-[calc(100%-1rem)] -translate-x-1/2 flex-col items-center gap-1 rounded-md bg-black/75 px-2.5 py-1.5 text-xs text-white/90 shadow-lg backdrop-blur-sm"
      role="toolbar"
      aria-label="Keypoint review"
    >
      <div className="flex items-center gap-2">
        <span className="font-semibold">Review node</span>
        <select
          className={selectClass}
          value={node}
          aria-label="Node to review"
          onChange={(e) => setKeypointReview({ node: Number(e.target.value) })}
        >
          {skeleton.nodeNames.map((name, i) => (
            <option key={i} value={i}>
              {name}
            </option>
          ))}
        </select>
        <select
          className={selectClass}
          value={source}
          aria-label="Instances to review"
          title={KEYPOINT_REVIEW_SOURCES.find((s) => s.source === source)?.title}
          onChange={(e) => setKeypointReview({ source: e.target.value as KeypointReviewSource })}
        >
          {KEYPOINT_REVIEW_SOURCES.map((s) => (
            <option key={s.source} value={s.source} title={s.title}>
              {s.label}
            </option>
          ))}
        </select>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 text-white/80 hover:bg-white/15 hover:text-white"
          onClick={closeKeypointReview}
          aria-label="Stop reviewing"
          title="Stop (Esc)"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 text-white/80 hover:bg-white/15 hover:text-white"
          onClick={() => stepKeypointReview(-1)}
          disabled={pos === 0}
          aria-label="Previous instance"
          title="Previous (← or Backspace)"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <span className="font-mono tabular-nums" aria-label="Position">
          {queue.length === 0 ? "0 / 0" : `${pos + 1} / ${queue.length}`}
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="h-6 w-6 text-white/80 hover:bg-white/15 hover:text-white"
          onClick={() => stepKeypointReview(1)}
          disabled={pos >= queue.length - 1}
          aria-label="Next instance"
          title="Next, keeping the node as it is (Enter or →)"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
        <span className="font-mono tabular-nums text-white/60">
          {multiVideo && video && `${videoBasename(video.filename)} · `}frame {frameIdx}
        </span>
        {source === "worst" && offBy != null && (
          <span
            className="rounded bg-amber-400/15 px-1 text-[11px] text-amber-300"
            title="How far the node is from where it usually sits, relative to the size of the body"
          >
            {offBy === Infinity ? "not placed" : `off by ${offBy.toFixed(2)}`}
          </span>
        )}
        {changed > 0 && <span className="text-white/60">{changed} changed</span>}
      </div>
      <span className="text-[10px] text-white/55">
        click: move it here · Enter / →: keep · V: not visible · ←: back · {formatShortcut("$mod+KeyZ")}: undo · Esc: stop
      </span>
    </div>
  );
}
