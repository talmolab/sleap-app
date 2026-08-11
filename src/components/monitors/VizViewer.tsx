import { useCallback, useEffect, useRef, useState } from "react";
import { getPlatform } from "@/platform";
import { Button } from "@/components/ui/button";
import { ZoomIn, ZoomOut, RotateCcw } from "lucide-react";

/** viz PNG path for a run: `<runDir>/viz/<kind>.<epoch:04d>.png` (epoch 0-based). */
export function vizPngPath(runDir: string, kind: "validation" | "train", epoch: number): string {
  return `${runDir}/viz/${kind}.${String(epoch).padStart(4, "0")}.png`;
}

/**
 * Probe the contiguous set of epochs (from `startEpoch`) whose viz PNG exists on
 * disk, stopping at the first gap. sleap-nn writes one PNG per epoch (when
 * `keep_viz` is on they persist), so the available epochs are `0..N`; early in
 * training only `0..current` exist yet. Returns the highest contiguous epoch
 * present, or `startEpoch - 1` if none.
 */
export async function probeMaxEpoch(
  runDir: string,
  kind: "validation" | "train",
  exists: (p: string) => Promise<boolean>,
  startEpoch: number,
  limit = 2000,
): Promise<number> {
  let e = startEpoch;
  while (e < startEpoch + limit) {
    if (!(await exists(vizPngPath(runDir, kind, e)))) break;
    e++;
  }
  return e - 1;
}

/**
 * Zoomable/pannable viewer for training visualization PNGs (validation/train
 * heatmaps), with an epoch scrubber. Reads PNG bytes via the platform FS wrapper
 * (desktop only) and renders a Blob URL. Self-contained — it only needs a
 * `runDir`, so it works both inside the Training Monitor and in a standalone viz
 * window (separate JS heap).
 *
 * - Zoom: wheel or the +/- buttons; pan: drag; Reset restores fit.
 * - Epoch scrubber + "Live" (follow the newest epoch while training).
 * - Polls the run's viz dir for new epochs while `live`.
 */
export function VizViewer({
  runDir,
  height = 360,
  fill = false,
}: {
  runDir: string | null;
  /** Fixed image-area height (px). Ignored when `fill` is set. */
  height?: number;
  /** Fill the parent's height (grow the image area) — for the standalone window. */
  fill?: boolean;
}) {
  const [kind, setKind] = useState<"validation" | "train">("validation");
  const [maxEpoch, setMaxEpoch] = useState(-1);
  const [epoch, setEpoch] = useState(0);
  const [live, setLive] = useState(true);
  const [url, setUrl] = useState<string | null>(null);

  const objUrlRef = useRef<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  // Discover available epochs (initial + poll while live). Extends from the
  // current max so a finished run isn't re-probed from 0 each tick.
  useEffect(() => {
    if (!runDir) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const scan = async () => {
      try {
        const { exists } = await getPlatform();
        const found = await probeMaxEpoch(runDir, kind, exists, Math.max(0, maxEpoch + 1));
        if (cancelled || found < 0) return;
        if (found !== maxEpoch) setMaxEpoch(found);
      } catch {
        /* desktop-only / not ready yet */
      }
    };
    void scan();
    if (live) timer = setInterval(scan, 2000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [runDir, kind, live, maxEpoch]);

  // Follow the newest epoch while live.
  useEffect(() => {
    if (live && maxEpoch >= 0) setEpoch(maxEpoch);
  }, [live, maxEpoch]);

  // Load the selected epoch's PNG as a Blob URL.
  useEffect(() => {
    if (!runDir || maxEpoch < 0) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    const revoke = () => {
      if (objUrlRef.current) {
        URL.revokeObjectURL(objUrlRef.current);
        objUrlRef.current = null;
      }
    };
    (async () => {
      try {
        const platform = await getPlatform();
        const bytes = await platform.readFile(vizPngPath(runDir, kind, epoch));
        if (cancelled) return;
        const blob = new Blob([bytes as BlobPart], { type: "image/png" });
        const u = URL.createObjectURL(blob);
        revoke();
        objUrlRef.current = u;
        setUrl(u);
      } catch {
        if (!cancelled) {
          revoke();
          setUrl(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [runDir, kind, epoch, maxEpoch]);

  useEffect(
    () => () => {
      if (objUrlRef.current) URL.revokeObjectURL(objUrlRef.current);
    },
    [],
  );

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => Math.min(8, Math.max(1, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15))));
  };
  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setPan({ x: d.px + (e.clientX - d.x), y: d.py + (e.clientY - d.y) });
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  if (!runDir) return null;

  return (
    <div className={fill ? "flex flex-col h-full gap-1 min-h-0" : "space-y-1"}>
      <div className="flex items-center gap-2 text-[11px] text-muted-foreground flex-wrap">
        <span>Visualization:</span>
        <select
          className="bg-transparent border border-muted-foreground/30 rounded px-1 py-0.5 text-[10px]"
          value={kind}
          onChange={(e) => setKind(e.target.value as "validation" | "train")}
        >
          <option value="validation">Validation</option>
          <option value="train">Training</option>
        </select>
        <span className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" title="Zoom out"
            onClick={() => setZoom((z) => Math.max(1, z / 1.3))}>
            <ZoomOut className="h-3.5 w-3.5" />
          </Button>
          <span className="tabular-nums w-9 text-center">{Math.round(zoom * 100)}%</span>
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" title="Zoom in"
            onClick={() => setZoom((z) => Math.min(8, z * 1.3))}>
            <ZoomIn className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[10px]" title="Reset view"
            onClick={resetView}>
            <RotateCcw className="h-3 w-3 mr-1" /> Reset
          </Button>
        </span>
      </div>

      <div
        className={`relative overflow-hidden rounded border border-muted-foreground/20 bg-black/30 touch-none select-none ${
          fill ? "flex-1 min-h-0" : ""
        }`}
        style={fill ? undefined : { height }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={resetView}
      >
        {url ? (
          <img
            src={url}
            alt={`${kind} visualization (epoch ${epoch})`}
            draggable={false}
            className="absolute left-1/2 top-1/2 max-h-full max-w-full object-contain"
            style={{
              transform: `translate(-50%,-50%) translate(${pan.x}px,${pan.y}px) scale(${zoom})`,
              cursor: zoom > 1 ? "grab" : "default",
            }}
          />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center text-[10px] text-muted-foreground">
            {maxEpoch < 0 ? "Waiting for first epoch…" : "No visualization available"}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
        <span className="tabular-nums whitespace-nowrap">
          Epoch {maxEpoch < 0 ? "—" : epoch}
          {maxEpoch >= 0 ? ` / ${maxEpoch}` : ""}
        </span>
        <input
          type="range"
          className="flex-1 accent-current"
          min={0}
          max={Math.max(0, maxEpoch)}
          value={Math.max(0, epoch)}
          disabled={maxEpoch < 0}
          onChange={(e) => {
            setLive(false);
            setEpoch(Number(e.target.value));
          }}
        />
        <label className="flex items-center gap-1 cursor-pointer whitespace-nowrap">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
          Live
        </label>
      </div>
    </div>
  );
}
