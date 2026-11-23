/**
 * Label QC "Detector Settings": turn each check on or off and set its
 * thresholds, with a short help for each (PyQt's collapsible group of the same
 * name, which starts collapsed). Saved per project on this computer.
 *
 * Toggles and the anomaly threshold change the current results right away;
 * the other thresholds change what a run finds, so they apply on the next
 * Run (the section says so when they differ from the last run's).
 */
import { useState } from "react";
import { ChevronDown, ChevronRight, CircleHelp } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { NumberInput } from "@/components/NumberInput";
import { cn } from "@/lib/utils";
import { useQcStore } from "@/stores/qcStore";
import { makeQCConfig } from "@/lib/analyze/qc/config";
import {
  QC_RUN_SETTINGS,
  QC_SETTING_RANGES,
  runSettingsDiffer,
  type QcDetectorId,
  type QcNumericSetting,
} from "@/lib/analyze/qc/settings";

interface DetectorRow {
  id: QcDetectorId;
  name: string;
  help: string;
  thresholds?: { key: QcNumericSetting; label: string; suffix?: string }[];
}

/**
 * Every detector, in PyQt's wording where PyQt has the same detector
 * (L/R flip, Duplicate / split, Wrong chain order).
 */
export const QC_DETECTOR_ROWS: DetectorRow[] = [
  {
    id: "anomaly",
    name: "Anomaly score",
    help:
      "Scores how unusual each instance's pose is next to your other labels: an odd joint " +
      "angle, an edge too long or too short, an unusual set of visible nodes. Flags the ones " +
      "scoring at or above the threshold (the same as the threshold slider).",
    thresholds: [{ key: "anomalyThreshold", label: "score ≥" }],
  },
  {
    id: "gmm",
    name: "Improbable pose (GMM)",
    help:
      "Catches poses whose measurements each look normal but whose combination is rare, such " +
      "as one leg tucked in while the others are spread. Always flags about this share of " +
      `your labels, the least typical ones. Needs at least ${makeQCConfig().gmmMinSamples} ` +
      "labeled instances.",
    thresholds: [{ key: "gmmPercent", label: "least typical", suffix: "%" }],
  },
  {
    id: "chirality",
    name: "Whole-instance L/R flip",
    help:
      "Flags an animal whose left and right body parts look swapped, for example the left " +
      "and right ears traced on the wrong sides, so the whole pose is mirror-flipped. Needs " +
      "left/right symmetries in the skeleton (or L/R node names). Listed as Chirality (L/R).",
    thresholds: [{ key: "chiralityThreshold", label: "flip frac ≥" }],
  },
  {
    id: "duplicate",
    name: "Duplicate / split",
    help:
      "Flags two labels that sit almost on top of each other: usually the same animal traced " +
      "twice, or one animal split into two instances. The threshold is how much their boxes " +
      "must overlap (IoU); nodes sitting on top of each other are caught either way.",
    thresholds: [{ key: "duplicateIou", label: "IoU ≥" }],
  },
  {
    id: "chain_order",
    name: "Wrong chain order",
    help:
      "Flags body parts traced out of order along a chain such as a tail: the chain doubles " +
      "back on itself instead of running smoothly from base to tip. Runs on the skeleton's " +
      "chains of 4 or more nodes without side branches.",
    thresholds: [
      { key: "chainTurnDeg", label: "turn ≥", suffix: "°" },
      { key: "chainInversion", label: "inv frac ≥" },
    ],
  },
  {
    id: "out_of_range",
    name: "Out of range",
    help: "Flags an instance with a point outside the image.",
  },
  {
    id: "empty_instance",
    name: "Empty instance",
    help: "Flags an instance with no visible nodes.",
  },
  {
    id: "sparse_instance",
    name: "Sparse instance",
    help:
      "Flags an instance with fewer visible nodes than this. Nodes that were never " +
      "labeled count neither way.",
    thresholds: [{ key: "minVisibleNodes", label: "nodes <" }],
  },
  {
    id: "incomplete_frame",
    name: "Incomplete frame",
    help:
      "Flags a frame with fewer instances than the video's usual (median) count: an animal " +
      "was probably missed.",
  },
  {
    id: "negative_frame",
    name: "Negative frame",
    help: "Flags a frame marked as having no animals that still has instances on it.",
  },
];

const RUN_KEYS = new Set<QcNumericSetting>(QC_RUN_SETTINGS);

export function QcDetectorSettings({
  className,
  defaultOpen = false,
}: {
  className?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const settings = useQcStore((s) => s.settings);
  const runSettings = useQcStore((s) => s.runSettings);
  const state = useQcStore((s) => s.state);
  const setSettings = useQcStore((s) => s.setSettings);
  const resetSettings = useQcStore((s) => s.resetSettings);
  const off = Object.values(settings.enabled).filter((on) => !on).length;
  const stale = state === "done" && runSettings !== null && runSettingsDiffer(settings, runSettings);

  return (
    <div className={cn("rounded-md border border-border/60", className)}>
      <button
        className="flex w-full items-center gap-1 px-2 py-1 text-left text-[11px] font-medium"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Detector Settings
        {off > 0 && (
          <span className="font-normal text-muted-foreground">· {off} off</span>
        )}
        {stale && <span className="font-normal text-amber-600">· Rerun to apply</span>}
      </button>
      {open && (
        <div className="flex flex-col gap-1.5 border-t border-border/60 px-2 py-1.5">
          <TooltipProvider delayDuration={150}>
            {QC_DETECTOR_ROWS.map((row) => {
              const on = settings.enabled[row.id];
              return (
                <div key={row.id} className="flex flex-col gap-0.5">
                  <div className="flex items-center gap-1.5 text-[11px]">
                    <Checkbox
                      id={`qc-det-${row.id}`}
                      checked={on}
                      onCheckedChange={(v) => setSettings({ enabled: { [row.id]: v === true } })}
                      className="size-3.5"
                    />
                    <label htmlFor={`qc-det-${row.id}`} className={cn(!on && "text-muted-foreground")}>
                      {row.name}
                    </label>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button aria-label={`What does '${row.name}' catch?`}>
                          <CircleHelp className="h-3 w-3 text-muted-foreground" />
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="left" className="max-w-64 text-[11px]">
                        {row.help}
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  {row.thresholds && (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-5">
                      {row.thresholds.map((t) => {
                        const r = QC_SETTING_RANGES[t.key];
                        const changed =
                          stale && RUN_KEYS.has(t.key) && runSettings![t.key] !== settings[t.key];
                        return (
                          <label
                            key={t.key}
                            className="flex items-center gap-1 text-[10px] text-muted-foreground"
                          >
                            {t.label}
                            <NumberInput
                              value={settings[t.key]}
                              min={r.min}
                              max={r.max}
                              step={r.step}
                              integer={Number.isInteger(r.step)}
                              disabled={!on}
                              onCommit={(v) => setSettings({ [t.key]: v })}
                              className={cn(
                                "h-5 w-14 px-1 text-[10px]",
                                changed && "border-amber-500/70",
                              )}
                              aria-label={`${row.name} ${t.label}`}
                            />
                            {t.suffix}
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </TooltipProvider>
          <p className="text-[10px] text-muted-foreground">
            Checkboxes and the anomaly score apply right away. Other thresholds apply on the next
            Run{stale ? ":" : "."}{" "}
            {stale && <span className="text-amber-600">Rerun to apply the changed ones.</span>}
          </p>
          <p className="text-[10px] text-muted-foreground">
            Saved for this project on this computer.
          </p>
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="ghost"
              className="h-5 px-1.5 text-[10px]"
              onClick={resetSettings}
              title="Put every detector setting back to its default"
            >
              Restore defaults
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
