/**
 * Conflict-review step for Merge into Project (A3).
 *
 * Shown when the donor clashes with the project on one or more frames. Left = a
 * compact list of conflict clusters (Frame / Track / Δpx + a Base|Donor|Both
 * segmented control); right = the {@link ConflictPreviewCanvas} for the selected
 * row (base pose blue vs donor pose orange over the frame). A "Default for
 * conflicts" radio seeds every row; per-row controls override it. The parent
 * owns the resolution state and turns it into `ResolvedConflict[]` on merge.
 *
 * MVP: a multi-instance pile-up cluster is resolved at cluster granularity
 * (Base = keep all base, Donor = keep all donors, Both = keep everything). A
 * per-instance keep/drop expansion is a future refinement.
 */

import { useEffect, useState } from "react";
import type { Track } from "@/types";
import type { Conflict, ConflictChoice } from "@/lib/mergeConflicts";
import { ConflictPreviewCanvas } from "./ConflictPreviewCanvas";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

const CHOICES: { value: ConflictChoice; label: string }[] = [
  { value: "both", label: "Both" },
  { value: "base", label: "Base" },
  { value: "donor", label: "Donor" },
];

function trackSummary(c: Conflict): string {
  const names = [...c.baseInstances, ...c.donorInstances]
    .map((i) => i.track?.name)
    .filter((n): n is string => !!n);
  return [...new Set(names)].join(", ") || "—";
}

export function ConflictReview({
  conflicts,
  tracks,
  defaultChoice,
  onDefaultChange,
  choices,
  onChoiceChange,
  onReset,
}: {
  conflicts: Conflict[];
  tracks: Track[];
  defaultChoice: ConflictChoice;
  onDefaultChange: (c: ConflictChoice) => void;
  /** Per-conflict overrides; absent id → follows `defaultChoice`. */
  choices: Record<string, ConflictChoice>;
  onChoiceChange: (id: string, c: ConflictChoice) => void;
  onReset: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(
    conflicts[0]?.id ?? null
  );
  // Keep a valid selection when the conflict set changes (new donor).
  useEffect(() => {
    if (!conflicts.some((c) => c.id === selectedId)) {
      setSelectedId(conflicts[0]?.id ?? null);
    }
  }, [conflicts, selectedId]);

  const selected = conflicts.find((c) => c.id === selectedId) ?? null;
  const effective = (c: Conflict): ConflictChoice => choices[c.id] ?? defaultChoice;
  const hasOverrides = Object.keys(choices).length > 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-amber-600 dark:text-amber-400">
          ⚠ {conflicts.length} conflict{conflicts.length !== 1 ? "s" : ""}
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Default:</span>
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
                    {c.label}
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
          >
            Reset
          </Button>
        </div>
      </div>

      <div className="flex gap-3">
        {/* Conflict list */}
        <div className="w-1/2 max-h-60 overflow-y-auto rounded border border-border">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card text-muted-foreground">
              <tr>
                <th className="px-2 py-1 text-left font-medium">Frame</th>
                <th className="px-1 py-1 text-left font-medium">Track</th>
                <th className="px-1 py-1 text-right font-medium">Δpx</th>
                <th className="px-2 py-1 text-center font-medium">Keep</th>
              </tr>
            </thead>
            <tbody>
              {conflicts.map((c) => (
                <tr
                  key={c.id}
                  className={`cursor-pointer border-t border-border/50 ${
                    selectedId === c.id ? "bg-accent" : "hover:bg-accent/50"
                  }`}
                  onClick={() => setSelectedId(c.id)}
                >
                  <td className="px-2 py-1 tabular-nums">{c.frameIdx}</td>
                  <td className="px-1 py-1 truncate max-w-[80px]" title={trackSummary(c)}>
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
        </div>

        {/* Selected-row preview */}
        <div className="w-1/2">
          {selected && (
            <ConflictPreviewCanvas
              video={selected.video}
              frameIdx={selected.frameIdx}
              baseInstances={selected.baseInstances}
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
