/**
 * Collect Diagnostics dialog.
 *
 * Explains what the diagnostics bundle contains, offers the opt-in to include
 * the tester's imageless labels, and saves the bundle to a file to send us.
 */

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { saveDiagnosticsBundle } from "@/lib/diagnostics";

interface DiagnosticsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DiagnosticsDialog({
  open,
  onOpenChange,
}: DiagnosticsDialogProps) {
  const [includeProject, setIncludeProject] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      const path = await saveDiagnosticsBundle({ includeProject });
      if (path) onOpenChange(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle>Collect Diagnostics</DialogTitle>
        </DialogHeader>

        <div className="space-y-3 py-2 text-sm">
          <p className="text-muted-foreground">
            Saves a single file with a trace of this session — recent actions,
            errors, training/inference output, and your environment — so the
            SLEAP team can reproduce a problem.{" "}
            <span className="font-medium text-foreground">
              No video frames are included.
            </span>
          </p>

          <label className="flex items-start gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={includeProject}
              onChange={(e) => setIncludeProject(e.target.checked)}
              className="accent-primary mt-0.5"
            />
            <span>
              <span className="font-medium">
                Include my labels for reproduction
              </span>
              <span className="block text-xs text-muted-foreground">
                Attaches your skeleton and point coordinates (imageless — no
                images). Leave off to share only logs, environment, and file
                paths.
              </span>
            </span>
          </label>

          <p className="text-xs text-muted-foreground pt-2 border-t border-border">
            After saving, send the file to the SLEAP team (Slack or email).
          </p>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save Diagnostics…"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
