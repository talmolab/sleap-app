/**
 * Conflict-review step for Merge into Project (A3).
 *
 * Left = a compact, sortable + filterable list of conflict clusters (Frame /
 * Track / Δpx + a Base|Donor|Both segmented control); right = the
 * {@link ConflictPreviewCanvas} for the selected row (base pose in its real
 * color vs donor pose in magenta). A "Global rule" radio seeds every row;
 * per-row controls override it. A stats line reports how much merges cleanly.
 * The parent owns the resolution state and turns it into `ResolvedConflict[]`.
 *
 * MVP: a multi-instance pile-up cluster is resolved at cluster granularity
 * (Base = keep all base, Donor = keep all donors, Both = keep everything).
 */

import { useEffect, useMemo, useState } from "react";
import type { Track } from "@/types";
import type {
  Conflict,
  ConflictChoice,
  MergeStats,
} from "@/lib/mergeConflicts";
import { ConflictPreviewCanvas } from "./ConflictPreviewCanvas";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

const CHOICES: { value: ConflictChoice; label: string; long: string }[] = [
  { value: "both", label: "Both", long: "Keep both" },
  { value: "base", label: "Base", long: "Base wins" },
  { value: "donor", label: "Donor", long: "Donor wins" },
];

type SortKey = "frame" | "track" | "distance";

function trackSummary(c: Conflict): string {
  const names = [...c.baseInstances, ...c.donorInstances]
    .map((i) => i.track?.name)
    .filter((n): n is string => !!n);
  return [...new Set(names)].join(", ") || "—";
}

function sortConflicts(list: Conflict[], key: SortKey, dir: 1 | -1): Conflict[] {
  return [...list].sort((a, b) => {
    let d = 0;
    if (key === "frame") d = a.frameIdx - b.frameIdx || a.distance - b.distance;
    else if (key === "distance") d = a.distance - b.distance;
    else d = trackSummary(a).localeCompare(trackSummary(b));
    return d * dir;
  });
}

export function ConflictReview({
  conflicts,
  stats,
  tracks,
  defaultChoice,
  onDefaultChange,
  choices,
  onChoiceChange,
  onReset,
}: {
  conflicts: Conflict[];
  stats: MergeStats;
  tracks: Track[];
  defaultChoice: ConflictChoice;
  onDefaultChange: (c: ConflictChoice) => void;
  /** Per-conflict overrides; absent id → follows `defaultChoice`. */
  choices: Record<string, ConflictChoice>;
  onChoiceChange: (id: string, c: ConflictChoice) => void;
  onReset: () => void;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("frame");
  const [sortDir, setSortDir] = useState<1 | -1>(1);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(
    conflicts[0]?.id ?? null
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? conflicts.filter(
          (c) =>
            String(c.frameIdx).includes(q) ||
            trackSummary(c).toLowerCase().includes(q)
        )
      : conflicts;
    return sortConflicts(filtered, sortKey, sortDir);
  }, [conflicts, query, sortKey, sortDir]);

  // Keep the selection valid (and visible) as filter/sort/donor change.
  useEffect(() => {
    if (!visible.some((c) => c.id === selectedId)) {
      setSelectedId(visible[0]?.id ?? null);
    }
  }, [visible, selectedId]);

  const selected = conflicts.find((c) => c.id === selectedId) ?? null;
  const effective = (c: Conflict): ConflictChoice => choices[c.id] ?? defaultChoice;
  const hasOverrides = Object.keys(choices).length > 0;

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setSortDir((d) => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(1);
    }
  };
  const caret = (key: SortKey) =>
    key === sortKey ? (sortDir === 1 ? " ▲" : " ▼") : "";

  return (
    <div className="space-y-2">
      {/* Header: stats + global rule + reset */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-amber-600 dark:text-amber-400">
            ⚠ {stats.conflicts} conflict{stats.conflicts !== 1 ? "s" : ""} ·{" "}
            {stats.conflictFrames} frame{stats.conflictFrames !== 1 ? "s" : ""}
          </div>
          <div className="text-xs text-muted-foreground">
            {stats.cleanInstances} of {stats.donorInstances} incoming instances
            merge cleanly · {stats.donorFrames} incoming frame
            {stats.donorFrames !== 1 ? "s" : ""}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Global rule:</span>
            <RadioGroup
              value={defaultChoice}
              onValueChange={(v) => onDefaultChange(v as ConflictChoice)}
              className="flex gap-2"
            >
              {CHOICES.map((c) => (
                <div key={c.value} className="flex items-center gap-1">
                  <RadioGroupItem
                    value={c.value}
                    id={`conflict-default-${c.value}`}
                  />
                  <Label
                    htmlFor={`conflict-default-${c.value}`}
                    className="font-normal"
                  >
                    {c.long}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={onReset}
            disabled={!hasOverrides}
            title="Clear per-row overrides and follow the global rule"
          >
            Reset choices
          </Button>
        </div>
      </div>

      <div className="flex gap-3">
        {/* Left: filter + conflict list */}
        <div className="w-1/2 space-y-1">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by frame or track…"
            className="w-full rounded border border-border bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
          <div className="max-h-56 overflow-y-auto rounded border border-border">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-card text-muted-foreground">
                <tr>
                  {(
                    [
                      ["frame", "Frame", "text-left"],
                      ["track", "Track", "text-left"],
                      ["distance", "Δpx", "text-right"],
                    ] as [SortKey, string, string][]
                  ).map(([key, label, align]) => (
                    <th key={key} className={`px-1 py-1 font-medium ${align}`}>
                      <button
                        type="button"
                        onClick={() => toggleSort(key)}
                        className="hover:text-foreground"
                      >
                        {label}
                        {caret(key)}
                      </button>
                    </th>
                  ))}
                  <th className="px-2 py-1 text-center font-medium">Keep</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((c) => (
                  <tr
                    key={c.id}
                    className={`cursor-pointer border-t border-border/50 ${
                      selectedId === c.id ? "bg-accent" : "hover:bg-accent/50"
                    }`}
                    onClick={() => setSelectedId(c.id)}
                  >
                    <td className="px-1 py-1 tabular-nums">{c.frameIdx}</td>
                    <td
                      className="px-1 py-1 truncate max-w-[70px]"
                      title={trackSummary(c)}
                    >
                      {trackSummary(c)}
                    </td>
                    <td className="px-1 py-1 text-right tabular-nums">
                      {c.distance.toFixed(1)}
                    </td>
                    <td className="px-2 py-1 text-center">
                      <Segmented
                        value={effective(c)}
                        onChange={(v) => onChoiceChange(c.id, v)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visible.length === 0 && (
              <div className="px-2 py-2 text-xs text-muted-foreground">
                No conflicts match “{query}”.
              </div>
            )}
          </div>
        </div>

        {/* Right: selected-row preview */}
        <div className="w-1/2">
          {selected && (
            <ConflictPreviewCanvas
              video={selected.video}
              frameIdx={selected.frameIdx}
              baseInstances={selected.baseInstances}
              baseColorIndices={selected.baseColorIndices}
              donorInstances={selected.donorInstances}
              tracks={tracks}
              width={300}
              height={220}
              className="w-full rounded border border-border bg-black"
            />
          )}
          <div className="mt-1 flex gap-3 text-xs text-muted-foreground">
            <span>base = existing colors</span>
            <span className="flex items-center gap-1">
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: "rgb(236,72,153)" }}
              />
              donor (incoming)
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Segmented({
  value,
  onChange,
}: {
  value: ConflictChoice;
  onChange: (v: ConflictChoice) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded border border-border">
      {CHOICES.map((c) => (
        <button
          key={c.value}
          type="button"
          aria-pressed={value === c.value}
          className={`px-1.5 py-0.5 text-[11px] ${
            value === c.value
              ? "bg-primary text-primary-foreground"
              : "hover:bg-accent"
          }`}
          onClick={(e) => {
            e.stopPropagation();
            onChange(c.value);
          }}
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}
