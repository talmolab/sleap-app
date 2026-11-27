/**
 * Save SLP Copy dialog (`File ▸ Export ▸ SLP Copy…`, StatusBar format popover,
 * and the 2.x -> 3.0 upgrade confirmation dialog's "Save 2.x Copy" action).
 *
 * Exports a standalone `.slp` copy in an explicit SLP format (`auto`, `v3`,
 * or `v2` with `unlabeledAs: "absent" | "error"`) without altering the open
 * project's file path, dirty state, or remembered format layout.
 */
import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "@/stores/appStore";
import { useSlpFormatStore } from "@/stores/slpFormatStore";
import { saveSlpCopy } from "@/lib/saveProject";
import {
  deriveSlpCopyFilename,
  inspectProjectFormat,
} from "@/lib/slpFormatStatus";
import { toastExported } from "@/lib/exportToast";
import { isTauri } from "@/platform/index";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  DEFAULT_SLP_FORMAT_CHOICE,
  SlpFormatFields,
  type SlpFormatExportChoice,
} from "./SlpFormatFields";

export function SaveSlpCopyDialog() {
  const open = useSlpFormatStore((s) => s.saveSlpCopyDialogOpen);
  const initialVersion = useSlpFormatStore((s) => s.saveSlpCopyInitialVersion);
  const setOpen = useSlpFormatStore((s) => s.setSaveSlpCopyDialogOpen);

  const labels = useAppStore((s) => s.labels);
  const filename = useAppStore((s) => s.filename);
  const editSeq = useAppStore((s) => s.editSeq);

  const [choice, setChoice] = useState<SlpFormatExportChoice>(
    DEFAULT_SLP_FORMAT_CHOICE,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setChoice({
        slpVersion: initialVersion,
        unlabeledAs: "absent",
      });
      setError(null);
      setBusy(false);
    }
  }, [open, initialVersion]);

  const formatStatus = useMemo(
    () => (open ? inspectProjectFormat(labels) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, labels, editSeq],
  );

  if (!labels) return null;

  const currentlyFormat3 = formatStatus?.willWriteFormat3 ?? false;
  const suggestedName = deriveSlpCopyFilename(
    filename,
    choice.slpVersion,
    currentlyFormat3,
  );

  const handleExport = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await saveSlpCopy(labels, filename, {
        slpVersion: choice.slpVersion,
        unlabeledAs:
          choice.slpVersion === "v2" ? choice.unlabeledAs : undefined,
      });
      if (saved) {
        setOpen(false);
        toastExported("SLP copy exported", saved, isTauri);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) setOpen(next);
      }}
    >
      <DialogContent
        className="sm:max-w-[460px]"
        data-testid="save-slp-copy-dialog"
      >
        <DialogHeader>
          <DialogTitle>Export SLP Copy</DialogTitle>
          <DialogDescription>
            Save a standalone <code>.slp</code> copy in the chosen format
            without changing your open project file.
          </DialogDescription>
        </DialogHeader>

        <SlpFormatFields
          value={choice}
          onChange={(next) => {
            setChoice(next);
            setError(null);
          }}
          summary={formatStatus?.summary ?? null}
          effectiveAutoVersion={currentlyFormat3 ? "v3" : "v2"}
          idPrefix="slp-copy"
        />

        <p className="text-xs text-muted-foreground">
          Suggested filename:{" "}
          <code className="text-foreground" data-testid="save-slp-copy-suggested">
            {suggestedName}
          </code>
        </p>

        {error && (
          <p
            className="text-xs text-destructive"
            data-testid="save-slp-copy-error"
          >
            {error}
          </p>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={busy}
            data-testid="save-slp-copy-submit"
            onClick={handleExport}
          >
            {busy ? "Exporting…" : "Export Copy…"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
