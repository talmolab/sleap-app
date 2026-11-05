/**
 * DEV-ONLY prototype gallery for the seekbar's frame numbers vs. markers
 * (opened with `?prototype=seekbar` in a dev build; see main.tsx). Draws the
 * header graph + main bar for each layout option, over synthetic projects
 * (sparse, dense, huge, short), so they can be compared side by side. Nothing
 * here touches the real Seekbar; delete once an option is picked and ported.
 */

import { useEffect, useRef, useState } from "react";
import { frameTickInterval, HEADER_FILL } from "@/lib/headerSeriesRender";

// --- synthetic projects ---------------------------------------------------------

interface Project {
  name: string;
  totalFrames: number;
  /** [frame, hasUser, isNegative] like the real seekbar's marks. */
  marks: [number, boolean, boolean][];
  suggestions: number[];
  /** Per-frame header values (e.g. instance score), sparse. */
  header: Map<number, number>;
}

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

function makeProject(
  name: string,
  totalFrames: number,
  nUser: number,
  nPredicted: number,
  nSuggestions: number,
  nNegative: number,
  seed: number,
): Project {
  const r = rng(seed);
  const pick = (n: number) => Array.from({ length: n }, () => Math.floor(r() * totalFrames));
  const marks: Project["marks"] = [];
  for (const f of pick(nPredicted)) marks.push([f, false, false]);
  for (const f of pick(nUser)) marks.push([f, true, false]);
  for (const f of pick(nNegative)) marks.push([f, false, true]);
  const header = new Map<number, number>();
  for (const [f] of marks) header.set(f, 0.3 + r() * 0.7);
  return { name, totalFrames, marks, suggestions: pick(nSuggestions), header };
}

const PROJECTS: Project[] = [
  makeProject("Sparse — 13k frames, 12 labeled, 20 suggestions", 13_500, 12, 0, 20, 1, 1),
  makeProject("Typical — 13k frames, 60 labeled + 300 predicted, 40 suggestions", 13_500, 60, 300, 40, 3, 2),
  makeProject("Dense — 13k frames, 400 labeled + 6000 predicted, 200 suggestions", 13_500, 400, 6000, 200, 10, 3),
  makeProject("Huge — 250k frames, 300 labeled + 40k predicted, 500 suggestions", 250_000, 300, 40_000, 500, 20, 4),
  makeProject("Short — 300 frames, 30 labeled, 25 suggestions", 300, 30, 60, 25, 2, 5),
];

// --- drawing helpers (same colours/sizes as the real seekbar) ----------------------

const BAR_H = 36;
const HEADER_H = 26;
const RULER_H = 13;
const BG = "#27272a";
const SUGGESTION = "#fde047";
const MARK_COLOR = (user: boolean, neg: boolean) => (neg ? "#ef4444" : user ? "#3b82f6" : "#67e8f9");

type Ctx = CanvasRenderingContext2D;

function gridlines(ctx: Ctx, p: Project, w: number, y0: number, h: number) {
  const step = frameTickInterval(p.totalFrames);
  ctx.strokeStyle = "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let f = step; f < p.totalFrames; f += step) {
    const x = Math.round((f / (p.totalFrames - 1)) * w) + 0.5;
    ctx.moveTo(x, y0);
    ctx.lineTo(x, y0 + h);
  }
  ctx.stroke();
}

function numbers(
  ctx: Ctx,
  p: Project,
  w: number,
  y: number,
  opts: { outline?: boolean; everyOther?: boolean; avoid?: number[] } = {},
) {
  const step = frameTickInterval(p.totalFrames);
  ctx.font = "11px system-ui, sans-serif";
  ctx.textBaseline = "top";
  let i = 0;
  for (let f = step; f < p.totalFrames; f += step, i++) {
    if (opts.everyOther && i % 2 === 1) continue;
    const x = (f / (p.totalFrames - 1)) * w + 3;
    const label = String(f);
    const tw = ctx.measureText(label).width;
    if (x + tw > w) continue;
    if (opts.avoid?.some((sx) => sx >= x - 1 && sx <= x + tw + 1)) continue;
    if (opts.outline) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = BG;
      ctx.strokeText(label, x, y);
    }
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.fillText(label, x, y);
  }
}

const fx = (p: Project, f: number, w: number) => (f / (p.totalFrames - 1)) * w;

function suggestionTicks(ctx: Ctx, p: Project, w: number, y0: number, len: number) {
  ctx.fillStyle = SUGGESTION;
  for (const f of p.suggestions) ctx.fillRect(fx(p, f, w) - 0.5, y0, 1, len);
}

function suggestionFlags(ctx: Ctx, p: Project, w: number, y0: number) {
  ctx.fillStyle = SUGGESTION;
  for (const f of p.suggestions) {
    const x = fx(p, f, w);
    ctx.beginPath();
    ctx.moveTo(x - 3, y0);
    ctx.lineTo(x + 3, y0);
    ctx.lineTo(x, y0 + 4);
    ctx.closePath();
    ctx.fill();
  }
}

function labeledMarks(ctx: Ctx, p: Project, w: number, y0: number, len: number) {
  // Predicted first so user/negative marks draw over them (as in the real bar).
  const sorted = [...p.marks].sort((a, b) => Number(a[1] || a[2]) - Number(b[1] || b[2]));
  for (const [f, user, neg] of sorted) {
    ctx.fillStyle = MARK_COLOR(user, neg);
    ctx.fillRect(fx(p, f, w) - 1, y0, 2, len);
  }
}

function header(ctx: Ctx, p: Project, w: number, y0: number) {
  ctx.fillStyle = "#18181b";
  ctx.fillRect(0, y0, w, HEADER_H);
  ctx.fillStyle = HEADER_FILL;
  const bw = Math.max(1, w / p.totalFrames);
  for (const [f, v] of p.header) {
    const bh = v * (HEADER_H - 6);
    ctx.fillRect(fx(p, f, w), y0 + HEADER_H - bh, bw, bh);
  }
  gridlines(ctx, p, w, y0, HEADER_H);
}

function playhead(ctx: Ctx, p: Project, w: number, y0: number, h: number) {
  const x = fx(p, Math.floor(p.totalFrames * 0.37), w);
  ctx.fillStyle = "#fff";
  ctx.fillRect(x - 1, y0, 2, h);
}

// --- the options -----------------------------------------------------------------------

interface Option {
  id: string;
  name: string;
  note: string;
  /** Total drawing height below the header. */
  height: number;
  draw: (ctx: Ctx, p: Project, w: number, y0: number) => void;
}

const OPTIONS: Option[] = [
  {
    id: "current",
    name: "Now — numbers in the middle",
    note: "What this branch does: ticks on top, numbers centred, labeled marks at the bottom.",
    height: BAR_H,
    draw: (ctx, p, w, y0) => {
      ctx.fillStyle = BG;
      ctx.fillRect(0, y0, w, BAR_H);
      gridlines(ctx, p, w, y0, BAR_H);
      numbers(ctx, p, w, y0 + 10);
      suggestionTicks(ctx, p, w, y0, 9);
      labeledMarks(ctx, p, w, y0 + BAR_H - 14, 10);
      playhead(ctx, p, w, y0, BAR_H);
    },
  },
  {
    id: "ruler",
    name: "1 · Ruler strip above the bar",
    note: "Numbers on their own 13px strip; the bar is markers only. +13px tall.",
    height: RULER_H + BAR_H,
    draw: (ctx, p, w, y0) => {
      ctx.fillStyle = "#1f1f23";
      ctx.fillRect(0, y0, w, RULER_H);
      gridlines(ctx, p, w, y0, RULER_H);
      numbers(ctx, p, w, y0 + 1);
      const by = y0 + RULER_H;
      ctx.fillStyle = BG;
      ctx.fillRect(0, by, w, BAR_H);
      gridlines(ctx, p, w, by, BAR_H);
      suggestionTicks(ctx, p, w, by, 9);
      labeledMarks(ctx, p, w, by + BAR_H - 14, 10);
      playhead(ctx, p, w, by, BAR_H);
    },
  },
  {
    id: "flags",
    name: "2 · Small flags on the top edge",
    note: "Suggestions become 4px triangles on the edge; numbers just below them.",
    height: BAR_H,
    draw: (ctx, p, w, y0) => {
      ctx.fillStyle = BG;
      ctx.fillRect(0, y0, w, BAR_H);
      gridlines(ctx, p, w, y0, BAR_H);
      numbers(ctx, p, w, y0 + 6);
      suggestionFlags(ctx, p, w, y0);
      labeledMarks(ctx, p, w, y0 + BAR_H - 14, 10);
      playhead(ctx, p, w, y0, BAR_H);
    },
  },
  {
    id: "bottom",
    name: "3 · Suggestions in the bottom lane",
    note: "Numbers back on top; suggestions as short yellow ticks under the labeled marks.",
    height: BAR_H,
    draw: (ctx, p, w, y0) => {
      ctx.fillStyle = BG;
      ctx.fillRect(0, y0, w, BAR_H);
      gridlines(ctx, p, w, y0, BAR_H);
      numbers(ctx, p, w, y0 + 3);
      labeledMarks(ctx, p, w, y0 + BAR_H - 17, 10);
      suggestionTicks(ctx, p, w, y0 + BAR_H - 5, 4);
      playhead(ctx, p, w, y0, BAR_H);
    },
  },
  {
    id: "outline",
    name: "4 · Numbers on top, with a dark outline",
    note: "Smallest change: ticks stay, numbers get a halo so ticks behind them don't hurt.",
    height: BAR_H,
    draw: (ctx, p, w, y0) => {
      ctx.fillStyle = BG;
      ctx.fillRect(0, y0, w, BAR_H);
      gridlines(ctx, p, w, y0, BAR_H);
      suggestionTicks(ctx, p, w, y0, 9);
      numbers(ctx, p, w, y0 + 3, { outline: true });
      labeledMarks(ctx, p, w, y0 + BAR_H - 14, 10);
      playhead(ctx, p, w, y0, BAR_H);
    },
  },
  {
    id: "fewer",
    name: "5 · Fewer numbers (skip ones a tick would hit)",
    note: "Numbers on top; a number is left out where a suggestion tick would cross it.",
    height: BAR_H,
    draw: (ctx, p, w, y0) => {
      ctx.fillStyle = BG;
      ctx.fillRect(0, y0, w, BAR_H);
      gridlines(ctx, p, w, y0, BAR_H);
      suggestionTicks(ctx, p, w, y0, 9);
      numbers(ctx, p, w, y0 + 3, { avoid: p.suggestions.map((f) => fx(p, f, w)) });
      labeledMarks(ctx, p, w, y0 + BAR_H - 14, 10);
      playhead(ctx, p, w, y0, BAR_H);
    },
  },
];

// --- gallery ---------------------------------------------------------------------------

function Strip({ option, project, width }: { option: Option; project: Project; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const h = HEADER_H + option.height;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    header(ctx, project, width, 0);
    option.draw(ctx, project, width, HEADER_H);
  }, [option, project, width, h]);
  return <canvas ref={ref} style={{ width, height: h }} className="block rounded-sm" />;
}

export function SeekbarPrototypes() {
  const [width, setWidth] = useState(1100);
  return (
    <div className="dark min-h-screen overflow-auto bg-background p-6 text-foreground">
      <div className="mb-4 flex items-center gap-4">
        <h1 className="text-sm font-semibold">Seekbar prototypes</h1>
        <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
          Width
          <input
            type="range"
            min={500}
            max={1600}
            value={width}
            onChange={(e) => setWidth(Number(e.target.value))}
          />
          {width}px
        </label>
        <span className="text-[11px] text-muted-foreground">
          Each strip: header graph (no numbers) on top, then the option. Yellow = suggestions,
          blue = user-labeled, light blue = predicted, red = negative, white = playhead.
        </span>
      </div>
      <div className="space-y-8">
        {OPTIONS.map((option) => (
          <section key={option.id} className="space-y-2">
            <div>
              <h2 className="text-xs font-semibold">{option.name}</h2>
              <p className="text-[11px] text-muted-foreground">{option.note}</p>
            </div>
            {PROJECTS.map((project) => (
              <div key={project.name} className="space-y-0.5">
                <div className="text-[10px] text-muted-foreground">{project.name}</div>
                <Strip option={option} project={project} width={width} />
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
