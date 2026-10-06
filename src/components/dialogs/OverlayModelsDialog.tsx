/**
 * "Set Overlay Models" dialog (#283) — pipeline-type-first model picker for the
 * model-output overlay, mirroring the desktop PyQt SLEAP "Run Inference" flow.
 *
 * The user picks a pipeline type (top-down / single-animal; bottom-up is shown
 * but disabled this round), then fills each typed slot from a dropdown of trained
 * models auto-scanned near the project (head-type pre-filtered) with a Browse…
 * escape hatch that rejects a wrong-type / untrained folder inline. "Visualize"
 * commits the ordered model paths and turns the overlay on; it stays disabled
 * until every required slot is filled. Desktop-only (the overlay needs sleap-nn).
 *
 * Pure logic lives in overlayModelSelectionCore.ts (slots/validation/messages)
 * and overlayModelScan.ts (disk discovery); this component is the thin wiring.
 */

import { useEffect, useState } from "react";
import { Loader2, Check, AlertCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppStore } from "@/stores/appStore";
import {
  PIPELINE_SLOTS,
  slotOptions,
  slotLabel,
  validateSelection,
  resolveModelPaths,
  rejectReason,
  type OverlayPipeline,
  type OverlaySelection,
  type ModelCatalogEntry,
} from "@/lib/models/overlayModelSelectionCore";
import {
  overlayScanRoots,
  scanModelCatalog,
  classifyModelDir,
} from "@/lib/models/overlayModelScan";

const BROWSE = "__browse__";

const PIPELINE_OPTIONS: { value: OverlayPipeline; label: string; disabled?: boolean }[] = [
  { value: "top-down", label: "Multi-animal top-down" },
  { value: "single-animal", label: "Single animal" },
  { value: "bottom-up", label: "Multi-animal bottom-up", disabled: true },
];

/** Best-effort pipeline guess from the heads of the currently-set model paths. */
function inferPipeline(heads: string[]): OverlayPipeline {
  return heads.includes("single_instance") ? "single-animal" : "top-down";
}

export interface OverlayModelsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function OverlayModelsDialog({ open, onOpenChange }: OverlayModelsDialogProps) {
  const projectPath = useAppStore((s) => s.projectPath);
  const overlayModelPaths = useAppStore((s) => s.overlayModelPaths);
  const setVal = useAppStore((s) => s.set);

  const [pipeline, setPipeline] = useState<OverlayPipeline>("top-down");
  const [selection, setSelection] = useState<OverlaySelection>({});
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [scanning, setScanning] = useState(false);
  const [rejects, setRejects] = useState<Record<string, string | null>>({});

  // On open: scan nearby models + classify any currently-set paths to pre-fill.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setScanning(true);
    setRejects({});
    (async () => {
      const scanned = await scanModelCatalog(overlayScanRoots(projectPath)).catch(() => []);
      const current = await Promise.all(
        overlayModelPaths.map((p) => classifyModelDir(p).catch(() => null)),
      );
      if (cancelled) return;

      const merged = [...scanned];
      const sel: OverlaySelection = {};
      const heads: string[] = [];
      for (const c of current) {
        if (!c || !c.head) continue;
        heads.push(c.head);
        sel[c.head] = c.path;
        if (!merged.some((e) => e.path === c.path)) {
          merged.push({ path: c.path, runName: c.runName, head: c.head });
        }
      }
      setCatalog(merged);
      setSelection(sel);
      setPipeline(inferPipeline(heads));
      setScanning(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, projectPath, overlayModelPaths]);

  const setReject = (slot: string, msg: string | null) =>
    setRejects((prev) => ({ ...prev, [slot]: msg }));

  const handleBrowse = async (slot: string) => {
    try {
      const { open: tauriOpen } = await import("@tauri-apps/plugin-dialog");
      const picked = await tauriOpen({
        directory: true,
        multiple: false,
        title: `Select a ${slotLabel(slot).toLowerCase()}`,
      });
      if (!picked || Array.isArray(picked)) return;
      const info = await classifyModelDir(picked);
      if (info.head === null) {
        setReject(slot, rejectReason(slot, null));
        return;
      }
      if (!info.trained) {
        setReject(slot, "No trained model (best.ckpt) in that folder.");
        return;
      }
      const mismatch = rejectReason(slot, info.head);
      if (mismatch) {
        setReject(slot, mismatch);
        return;
      }
      setCatalog((prev) =>
        prev.some((e) => e.path === info.path)
          ? prev
          : [...prev, { path: info.path, runName: info.runName, head: info.head as string }],
      );
      setSelection((prev) => ({ ...prev, [slot]: info.path }));
      setReject(slot, null);
    } catch {
      /* cancelled / not under Tauri */
    }
  };

  const handleSelect = (slot: string, value: string) => {
    if (value === BROWSE) {
      void handleBrowse(slot);
      return;
    }
    setSelection((prev) => ({ ...prev, [slot]: value }));
    setReject(slot, null);
  };

  const validation = validateSelection(pipeline, selection);

  const handleVisualize = () => {
    setVal("overlayModelPaths", resolveModelPaths(pipeline, selection));
    setVal("overlayModelOutputs", true);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Set Overlay Models</DialogTitle>
          <DialogDescription>
            Pick the pipeline you trained, then choose its model(s). The overlay draws the
            model's confidence map on the current frame.
          </DialogDescription>
        </DialogHeader>

        {/* Pipeline type */}
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">Pipeline type</Label>
          <RadioGroup
            value={pipeline}
            onValueChange={(v) => {
              setPipeline(v as OverlayPipeline);
              setRejects({});
            }}
            className="gap-1.5"
          >
            {PIPELINE_OPTIONS.map((opt) => (
              <div key={opt.value} className="flex items-center gap-2">
                <RadioGroupItem value={opt.value} id={`pipe-${opt.value}`} disabled={opt.disabled} />
                <Label
                  htmlFor={`pipe-${opt.value}`}
                  className={`text-xs font-normal ${opt.disabled ? "text-muted-foreground/60" : ""}`}
                >
                  {opt.label}
                  {opt.disabled && <span className="ml-1.5 italic opacity-70">— coming soon</span>}
                </Label>
              </div>
            ))}
          </RadioGroup>
        </div>

        {/* Model slots for the chosen pipeline */}
        <div className="space-y-3 border-t border-border/40 pt-3">
          {PIPELINE_SLOTS[pipeline].map((slot) => {
            const options = slotOptions(catalog, slot);
            const value = selection[slot];
            const reject = rejects[slot];
            return (
              <div key={slot} className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <Label className="text-xs">{slotLabel(slot)}</Label>
                  {value && <Check className="h-3 w-3 text-emerald-500" />}
                </div>
                <Select value={value ?? ""} onValueChange={(v) => handleSelect(slot, v)}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue
                      placeholder={
                        scanning
                          ? "Scanning…"
                          : options.length === 0
                            ? "No models found nearby — Browse…"
                            : "Select…"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {options.map((opt) => (
                      <SelectItem key={opt.path} value={opt.path} className="text-xs">
                        {opt.runName}
                      </SelectItem>
                    ))}
                    {options.length > 0 && <SelectSeparator />}
                    <SelectItem value={BROWSE} className="text-xs">
                      Browse…
                    </SelectItem>
                  </SelectContent>
                </Select>
                {reject && (
                  <p className="flex items-start gap-1 text-[11px] text-destructive">
                    <AlertCircle className="h-3 w-3 mt-0.5 shrink-0" />
                    {reject}
                  </p>
                )}
              </div>
            );
          })}
        </div>

        {!validation.complete && (
          <p className="text-[11px] text-muted-foreground">
            Add a {validation.missing.map((s) => slotLabel(s).toLowerCase()).join(" and ")} to
            visualize.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleVisualize} disabled={!validation.complete}>
            {scanning && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            Visualize
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
