/**
 * Export Labels Package dialog.
 *
 * PyQt parity: choose one of three "levels" and export a self-contained
 * embedded-image `.pkg.slp` (see exportPackageCommands.ts for the io mapping and
 * the continuous-video embedding gap). Each option previews a LIVE frame count
 * from the current project. The frame images are stored as PNG (the default)
 * or JPEG at a chosen quality (`PackageImageFormatFields`); the dialog opens
 * on the user's last choice.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../stores/appStore";
import { commandContext } from "../../commands/CommandContext";
import {
  ExportUserLabelsPackageCommand,
  ExportTrainingPackageCommand,
  ExportFullPackageCommand,
  frameCountForLevel,
  type ExportPackageLevel,
} from "../../commands/exportPackageCommands";
import type { Command } from "../../commands/types";
import { inspectProjectFormat } from "@/lib/slpFormatStatus";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { PackageImageFormatFields, usePackageImageChoice } from "./PackageImageFormatFields";
import {
  DEFAULT_SLP_FORMAT_CHOICE,
  SlpFormatFields,
  type SlpFormatExportChoice,
} from "./SlpFormatFields";

interface ExportPackageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const COMMAND_BY_LEVEL: Record<ExportPackageLevel, Command> = {
  user: ExportUserLabelsPackageCommand,
  training: ExportTrainingPackageCommand,
  full: ExportFullPackageCommand,
};

const OPTIONS: {
  level: ExportPackageLevel;
  title: string;
  desc: string;
  recommended?: boolean;
}[] = [
  {
    level: "user",
    title: "User labeled frames",
    desc: "Only frames you labeled by hand (Level 1).",
  },
  {
    level: "training",
    title: "User labeled + suggested frames",
    desc: "Your labeled frames plus suggested frames (Level 2).",
    recommended: true,
  },
  {
    level: "full",
    title: "Labeled + predicted + suggested frames",
    desc: "Every labeled frame, including predictions, plus suggested frames (Level 3).",
  },
];

export function ExportPackageDialog({
  open,
  onOpenChange,
}: ExportPackageDialogProps) {
  const labels = useAppStore((s) => s.labels);
  const editSeq = useAppStore((s) => s.editSeq);
  const [level, setLevel] = useState<ExportPackageLevel>("training");
  const image = usePackageImageChoice(open);
  const { choice, valid, remember } = image;
  const [slpFormat, setSlpFormat] = useState<SlpFormatExportChoice>(
    DEFAULT_SLP_FORMAT_CHOICE,
  );

  useEffect(() => {
    if (open) setSlpFormat(DEFAULT_SLP_FORMAT_CHOICE);
  }, [open]);

  const formatStatus = useMemo(
    () => (open ? inspectProjectFormat(labels) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, labels, editSeq],
  );

  const handleExport = useCallback(async () => {
    if (!valid) return;
    remember();
    // Close first, as PyQt does: the export's progress overlay (with Cancel)
    // sits below dialogs, so an open dialog would hide it for the whole export.
    onOpenChange(false);
    const params: Record<string, unknown> = { image: choice };
    if (slpFormat.slpVersion !== "auto") {
      params.slpVersion = slpFormat.slpVersion;
      if (slpFormat.slpVersion === "v2") {
        params.unlabeledAs = slpFormat.unlabeledAs;
      }
    }
    await commandContext.execute(COMMAND_BY_LEVEL[level], params);
  }, [level, choice, valid, remember, slpFormat, onOpenChange]);

  if (!labels) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px]">
        <DialogHeader>
          <DialogTitle>Export Labels Package</DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">
          Save a self-contained <code>.pkg.slp</code> with the selected frames'
          images embedded, so the project is portable without the source videos.
        </p>

        <RadioGroup
          value={level}
          onValueChange={(v) => setLevel(v as ExportPackageLevel)}
          className="py-2"
        >
          {OPTIONS.map((opt) => {
            const count = frameCountForLevel(labels, opt.level);
            return (
              <label
                key={opt.level}
                htmlFor={`pkg-level-${opt.level}`}
                className="flex items-start gap-3 rounded-md border border-border p-3 cursor-pointer hover:bg-accent/50"
              >
                <RadioGroupItem
                  value={opt.level}
                  id={`pkg-level-${opt.level}`}
                  className="mt-0.5"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {opt.title}
                    {opt.recommended && (
                      <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                        Recommended
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground">{opt.desc}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {count} frame{count === 1 ? "" : "s"}
                  </div>
                </div>
              </label>
            );
          })}
        </RadioGroup>

        <PackageImageFormatFields
          value={choice}
          onChange={image.setChoice}
          idPrefix="pkg"
        />

        <SlpFormatFields
          value={slpFormat}
          onChange={setSlpFormat}
          summary={formatStatus?.summary ?? null}
          effectiveAutoVersion={formatStatus?.willWriteFormat3 ? "v3" : "v2"}
          idPrefix="pkg-slp"
          collapsible
        />

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleExport} disabled={!valid}>
            Export
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
