/**
 * A strip above the frame viewer while the open project is View only (an SLP
 * format 3.0 file the user chose to open without editing). Editing is off and
 * nothing is written back; "Allow editing…" shows what saving in the 2.x
 * layout drops and, on yes, makes the project editable.
 */
import { Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/stores/appStore";
import { useSlpAccessNonce } from "@/stores/slpFormatStore";
import { allowEditing, displayFileName, formatLabel } from "@/lib/slpAccess";
import { sourceFormatOf } from "@/lib/slpFormatCompat";

export function ViewOnlyBanner() {
  const labels = useAppStore((s) => s.labels);
  const filename = useAppStore((s) => s.filename);
  // Re-read the access whenever it changes in place.
  useSlpAccessNonce((s) => s.nonce);
  const sf = sourceFormatOf(labels);
  if (!labels || sf?.access !== "view") return null;

  return (
    <div
      role="status"
      data-testid="view-only-banner"
      className="flex items-center gap-2 border-b border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs"
    >
      <Eye className="h-3.5 w-3.5 shrink-0 text-amber-500" />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">View only.</span>{" "}
        {displayFileName(filename ?? sf.labelsPath)} is in SLP format{" "}
        {formatLabel(sf.formatId)}: editing is off, and nothing is written back
        to the file.
      </span>
      <Button
        variant="outline"
        size="sm"
        className="h-6 px-2 text-xs"
        onClick={() => void allowEditing(labels)}
      >
        Allow editing…
      </Button>
    </div>
  );
}
