/**
 * Label QC Grid: every flagged instance as a thumbnail, to triage many flags
 * at once. Click to select (Shift+click for a range), then Mark OK or Delete
 * the selection; double-click a tile to look at it in Review. A progress
 * summary on top says how many flags are left, by issue type and by video,
 * and how this run compares with the last.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/stores/appStore";
import { buildQcQueue, openQcReviewAt, qcIsOk, useQcStore } from "@/stores/qcStore";
import { useQcView } from "@/hooks/useQcView";
import { commandContext, DeleteInstances } from "@/commands";
import { confirmDialog } from "@/stores/confirmStore";
import { videoBasename } from "@/lib/videoFilter";
import { formatShortcut } from "@/lib/formatShortcut";
import { qcFrameFlagCount, qcProgress, qcTileKey, qcTiles, type QcTile } from "@/lib/qcTriage";
import { drawQcThumb, qcThumbFrame } from "@/lib/qcThumbs";
import type { Instance, Labels } from "@/types";

const THUMB_PX = 132;

/** Every flagged instance (OK-marked ones included), in the review order. */
function useTiles() {
  const labels = useAppStore((s) => s.labels);
  const editSeq = useAppStore((s) => s.editSeq);
  const { findings, anomaly, threshold } = useQcView();
  const dismissed = useQcStore((s) => s.dismissed);
  const editedFrames = useQcStore((s) => s.editedFrames);
  return useMemo(() => {
    const queue = buildQcQueue(findings, anomaly, threshold, qcIsOk(labels, dismissed));
    return { tiles: qcTiles(queue, editedFrames), frameFlags: qcFrameFlagCount(queue, editedFrames) };
    // editSeq isn't read, but an edit can change an OK mark's fingerprint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findings, anomaly, threshold, labels, dismissed, editedFrames, editSeq]);
}

const instanceOf = (labels: Labels, t: QcTile): Instance | null => {
  const video = labels.videos[t.videoIdx];
  return (video && labels.find({ video, frameIdx: t.frameIdx })[0]?.userInstances[t.instIdx]) ?? null;
};

export function QcTriageDialog() {
  const open = useQcStore((s) => s.triageOpen);
  return (
    <Dialog open={open} onOpenChange={(o) => useQcStore.getState().setTriageOpen(o)}>
      <DialogContent className="flex h-[85vh] max-w-5xl flex-col gap-3 sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>Label QC Grid</DialogTitle>
          <DialogDescription>
            Every flagged instance at a glance. Click to select (Shift+click for a range), then Mark OK or Delete;
            double-click one to look at it in Review.
          </DialogDescription>
        </DialogHeader>
        {open && <TriageBody />}
      </DialogContent>
    </Dialog>
  );
}

function TriageBody() {
  const labels = useAppStore((s) => s.labels);
  const prevRunFlags = useQcStore((s) => s.prevRunFlags);
  const { tiles, frameFlags } = useTiles();
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const anchor = useRef<number | null>(null);

  const shown = useMemo(() => (showAll ? tiles : tiles.filter((t) => t.status === "open")), [tiles, showAll]);
  const shownKeys = useMemo(() => new Set(shown.map(qcTileKey)), [shown]);
  // Drop selections that left the view (marked OK, or hidden).
  const sel = useMemo(() => new Set([...selected].filter((k) => shownKeys.has(k))), [selected, shownKeys]);
  const progress = useMemo(
    () => qcProgress(tiles, (v) => (labels?.videos[v] ? videoBasename(labels.videos[v].filename) : `video ${v + 1}`)),
    [tiles, labels],
  );
  const thisRun = tiles.length + frameFlags;

  const click = (i: number, e: React.MouseEvent) => {
    const key = qcTileKey(shown[i]);
    const next = new Set(sel);
    if (e.shiftKey && anchor.current !== null) {
      const [a, b] = [Math.min(anchor.current, i), Math.max(anchor.current, i)];
      for (let j = a; j <= b; j++) next.add(qcTileKey(shown[j]));
    } else if (next.has(key)) next.delete(key);
    else next.add(key);
    anchor.current = i;
    setSelected(next);
  };

  const picked = shown.filter((t) => sel.has(qcTileKey(t)));
  const markOk = () => {
    useQcStore.getState().markOkMany(picked);
    setSelected(new Set());
  };
  const remove = async () => {
    if (!labels || picked.length === 0) return;
    const ok = await confirmDialog({
      title: "Delete instances",
      message: `Delete ${picked.length} instance${picked.length === 1 ? "" : "s"}? ${formatShortcut("$mod+KeyZ")} brings them back.\nLabel QC runs again afterwards, since the frames changed.`,
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const instances = picked.map((t) => instanceOf(labels, t)).filter((i): i is Instance => !!i);
    await commandContext.execute(DeleteInstances, { instances });
    setSelected(new Set());
    void useQcStore.getState().run(labels);
  };

  return (
    <>
      <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs" data-testid="qc-progress">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-semibold">
            {progress.left} of {progress.total} flagged instance{progress.total === 1 ? "" : "s"} left
          </span>
          <div className="h-1.5 w-40 overflow-hidden rounded bg-muted" aria-hidden>
            <div
              className="h-full bg-emerald-500"
              style={{ width: `${progress.total ? ((progress.total - progress.left) / progress.total) * 100 : 0}%` }}
            />
          </div>
          {progress.ignored > 0 && <span className="text-muted-foreground">{progress.ignored} ignored</span>}
          {progress.edited > 0 && (
            <span className="text-amber-600" title="Edited since the run: Rerun to see if they're fixed">
              {progress.edited} edited
            </span>
          )}
          {frameFlags > 0 && (
            <span className="text-muted-foreground" title="Incomplete or negative frames: no instance to show here; see the panel">
              + {frameFlags} frame flag{frameFlags === 1 ? "" : "s"}
            </span>
          )}
          {prevRunFlags !== null && (
            <span className="ml-auto text-muted-foreground" title="All flags, ignored ones included">
              last run {prevRunFlags} → this run {thisRun}
            </span>
          )}
        </div>
        {progress.byKind.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {progress.byKind.map((r) => (
              <span key={r.label} className="rounded border border-border px-1.5 py-px">
                {r.label} <span className="font-mono tabular-nums text-muted-foreground">{r.left}/{r.total}</span>
              </span>
            ))}
            {progress.byVideo.length > 1 &&
              progress.byVideo.map((r) => (
                <span key={r.videoIdx} className="rounded border border-dashed border-border px-1.5 py-px" title={r.label}>
                  {r.label} <span className="font-mono tabular-nums text-muted-foreground">{r.left}/{r.total}</span>
                </span>
              ))}
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 text-xs">
        <Button size="sm" variant="outline" className="h-7" onClick={() => setSelected(new Set(shown.map(qcTileKey)))} disabled={shown.length === 0}>
          Select all
        </Button>
        <Button size="sm" variant="ghost" className="h-7" onClick={() => setSelected(new Set())} disabled={sel.size === 0}>
          Clear
        </Button>
        <span className="text-muted-foreground">{sel.size} selected</span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-7 border-blue-500/50 text-blue-400 hover:bg-blue-500/10 hover:text-blue-400"
          disabled={picked.filter((t) => t.status !== "ignored").length === 0}
          onClick={markOk}
          title="These are fine: hide their flags (kept on this computer, like Ignore)"
        >
          Mark OK
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 border-red-500/50 text-red-400 hover:bg-red-500/10 hover:text-red-400"
          disabled={picked.length === 0}
          onClick={() => void remove()}
        >
          Delete
        </Button>
        <label className="flex items-center gap-1 text-muted-foreground">
          <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
          Show ignored and edited
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">
            {tiles.length === 0 ? "Nothing flagged." : "No flags left. Tick “Show ignored and edited” to see the rest."}
          </p>
        ) : (
          <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${THUMB_PX}px, 1fr))` }}>
            {shown.map((t, i) => (
              <Tile
                key={qcTileKey(t)}
                tile={t}
                selected={sel.has(qcTileKey(t))}
                onClick={(e) => click(i, e)}
                onOpen={() => openQcReviewAt(t.videoIdx, t.frameIdx, t.instIdx)}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function Tile({
  tile,
  selected,
  onClick,
  onOpen,
}: {
  tile: QcTile;
  selected: boolean;
  onClick: (e: React.MouseEvent) => void;
  onOpen: () => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
  const labels = useAppStore((s) => s.labels);
  const editSeq = useAppStore((s) => s.editSeq);

  useEffect(() => {
    if (visible || !ref.current) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setVisible(true);
        io.disconnect();
      }
    });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [visible]);

  useEffect(() => {
    const canvas = ref.current;
    if (!visible || !canvas || !labels) return;
    const video = labels.videos[tile.videoIdx] ?? null;
    const inst = instanceOf(labels, tile);
    if (!video || !inst) return;
    const pose = {
      points: inst.points.map((p) => (p.visible ? [p.xy[0], p.xy[1]] : [NaN, NaN])),
      edges: ((inst.skeleton as unknown as { edgeIndices?: number[][] }).edgeIndices ?? []) as [number, number][],
      flagged: tile.nodes,
    };
    drawQcThumb(canvas, null, video, pose);
    let live = true;
    void qcThumbFrame(video, tile.frameIdx).then((bmp) => {
      if (live && bmp) drawQcThumb(canvas, bmp, video, pose);
    });
    return () => {
      live = false;
    };
  }, [visible, labels, tile, editSeq]);

  const name = labels && labels.videos.length > 1 ? `${videoBasename(labels.videos[tile.videoIdx]?.filename ?? "")} · ` : "";
  return (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={onOpen}
      aria-pressed={selected}
      aria-label={`Frame ${tile.frameIdx}, instance ${tile.instIdx + 1}: ${tile.kinds.join(", ")}`}
      className={cn(
        "flex flex-col overflow-hidden rounded-md border text-left text-[11px] transition-colors",
        selected ? "border-sky-400 ring-2 ring-sky-400/60" : "border-border hover:border-muted-foreground",
        tile.status !== "open" && "opacity-50",
      )}
      data-testid="qc-tile"
    >
      <canvas ref={ref} width={THUMB_PX * 2} height={THUMB_PX * 2} className="aspect-square w-full bg-black" />
      <div className="flex flex-col gap-0.5 px-1.5 py-1">
        <span className="truncate font-mono tabular-nums text-muted-foreground">
          {name}frame {tile.frameIdx} · #{tile.instIdx + 1}
        </span>
        <span className={cn("truncate", tile.definite ? "text-red-400" : "text-amber-500")}>
          {tile.kinds.join(", ")}
          {tile.score !== null && <span className="ml-1 font-mono tabular-nums text-muted-foreground">{tile.score.toFixed(2)}</span>}
        </span>
        {tile.status !== "open" && <span className="text-muted-foreground">{tile.status}</span>}
      </div>
    </button>
  );
}
