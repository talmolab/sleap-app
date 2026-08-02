/**
 * Export Dialog.
 *
 * Provides export options: CSV analysis data, JSON project, labels package.
 */

import { useCallback, useState } from "react";
import { useAppStore } from "../../stores/appStore";
import { commandContext } from "../../commands/CommandContext";
import {
  ExportCSVCommand,
  ExportAnalysisH5Command,
  SaveAsJsonCommand,
  ExportPackageCommand,
} from "../../commands/fileCommands";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ExportDialog({ open, onOpenChange }: ExportDialogProps) {
  const labels = useAppStore((s) => s.labels);
  const [includeEmpty, setIncludeEmpty] = useState(true);

  const handleExportCSV = useCallback(async () => {
    await commandContext.execute(ExportCSVCommand, { includeEmpty });
    onOpenChange(false);
  }, [onOpenChange, includeEmpty]);

  const handleExportAnalysisH5 = useCallback(async () => {
    await commandContext.execute(ExportAnalysisH5Command);
    onOpenChange(false);
  }, [onOpenChange]);

  const handleSaveAsJSON = useCallback(async () => {
    await commandContext.execute(SaveAsJsonCommand);
    onOpenChange(false);
  }, [onOpenChange]);

  const handleExportPackage = useCallback(async () => {
    await commandContext.execute(ExportPackageCommand);
    onOpenChange(false);
  }, [onOpenChange]);

  if (!labels) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[380px]">
        <DialogHeader>
          <DialogTitle>Export</DialogTitle>
        </DialogHeader>

        <div className="space-y-2 py-2">
          <Button
            variant="outline"
            className="w-full justify-start"
            onClick={handleExportCSV}
          >
            <div className="text-left">
              <div className="font-medium">Analysis CSV</div>
              <div className="text-xs text-muted-foreground">
                Export labels as a CSV spreadsheet for analysis.
              </div>
            </div>
          </Button>
          <label className="flex items-center gap-2 px-1 cursor-pointer">
            <input
              type="checkbox"
              checked={includeEmpty}
              onChange={(e) => setIncludeEmpty(e.target.checked)}
              className="accent-primary"
            />
            <span className="text-xs text-muted-foreground">
              Include rows for every video frame (recommended for downstream analysis)
            </span>
          </label>

          <Button
            variant="outline"
            className="w-full justify-start"
            onClick={handleExportAnalysisH5}
          >
            <div className="text-left">
              <div className="font-medium">Analysis HDF5</div>
              <div className="text-xs text-muted-foreground">
                Export the current video's tracks as a dense .h5 for
                Python/MATLAB analysis.
              </div>
            </div>
          </Button>

          <Button
            variant="outline"
            className="w-full justify-start"
            onClick={handleSaveAsJSON}
          >
            <div className="text-left">
              <div className="font-medium">Save As JSON</div>
              <div className="text-xs text-muted-foreground">
                Save the project as a JSON file with version numbering.
              </div>
            </div>
          </Button>

          <Button
            variant="outline"
            className="w-full justify-start"
            onClick={handleExportPackage}
          >
            <div className="text-left">
              <div className="font-medium">JSON Package</div>
              <div className="text-xs text-muted-foreground">
                Export a self-contained JSON package with video manifest.
              </div>
            </div>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
