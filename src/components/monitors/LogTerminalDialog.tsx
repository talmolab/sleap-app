import { useState, useMemo, useRef, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Copy } from "lucide-react";
import { logLineClassName, isErrorLine } from "@/lib/processLog";

/**
 * Full-size "terminal" view of a training/inference subprocess log.
 *
 * The inline panel logs are small (max-h-48); this modal shows the whole
 * (bounded) log with scrollback so users can read errors. Toolbar: Copy, an
 * "Errors only" filter (traceback/exception/failed lines) to jump to failures,
 * a line-wrap toggle, and Follow (auto-scroll to the newest line while running).
 * Lines are colored the same as the inline log (best=green, error=red,
 * section=yellow) via {@link logLineClassName}.
 */
export function LogTerminalDialog({
  open,
  onOpenChange,
  log,
  title = "Log",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  log: string[];
  title?: string;
}) {
  const [errorsOnly, setErrorsOnly] = useState(false);
  const [wrap, setWrap] = useState(true);
  const [follow, setFollow] = useState(true);
  const preRef = useRef<HTMLPreElement>(null);

  const lines = useMemo(
    () => (errorsOnly ? log.filter(isErrorLine) : log),
    [log, errorsOnly],
  );

  // Auto-scroll to the newest line while following (and on open / filter change).
  useEffect(() => {
    if (follow && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [lines, follow, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[900px]">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center justify-between pr-6">
            <span>{title}</span>
            <span className="text-[10px] font-normal text-muted-foreground">
              {lines.length}
              {errorsOnly ? ` / ${log.length}` : ""} lines
            </span>
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <Button
            variant="outline"
            size="sm"
            className="h-7 text-xs"
            onClick={() => navigator.clipboard.writeText(lines.join("\n"))}
          >
            <Copy className="h-3.5 w-3.5 mr-1" /> Copy
          </Button>
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={errorsOnly}
              onChange={(e) => setErrorsOnly(e.target.checked)}
            />
            Errors only
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={wrap}
              onChange={(e) => setWrap(e.target.checked)}
            />
            Wrap
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="checkbox"
              checked={follow}
              onChange={(e) => setFollow(e.target.checked)}
            />
            Follow
          </label>
        </div>

        <pre
          ref={preRef}
          className={`h-[60vh] overflow-auto rounded border bg-muted p-2 text-[11px] font-mono ${
            wrap ? "whitespace-pre-wrap break-all" : "whitespace-pre"
          }`}
        >
          {lines.length === 0 ? (
            <span className="text-muted-foreground">
              {errorsOnly ? "No error lines." : "No log output."}
            </span>
          ) : (
            lines.map((line, i) => (
              <div key={i} className={logLineClassName(line)}>
                {line}
              </div>
            ))
          )}
        </pre>
      </DialogContent>
    </Dialog>
  );
}
