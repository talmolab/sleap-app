/**
 * ErrorOutput — a compact red box showing the forwarded stderr tail from a
 * failed sleap-nn run.
 *
 * Training and inference both keep the last stderr lines (`stderrTail`); when a
 * run errors we render them here so the tester sees the ACTUAL error output in
 * the training/inference window, not just a one-line summary — no need to open
 * the full log. A Copy button grabs the whole tail for pasting into a bug report
 * / diagnostics. Renders nothing when there are no lines.
 */
import { useState } from "react";
import { Copy, Check } from "lucide-react";

export function ErrorOutput({
  lines,
  title = "Error output",
  className = "",
}: {
  lines: string[];
  title?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  if (!lines || lines.length === 0) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable (e.g. insecure context) — ignore */
    }
  };

  return (
    <div
      className={`rounded-md border border-destructive/30 bg-destructive/10 overflow-hidden ${className}`}
    >
      <div className="flex items-center justify-between gap-2 px-2 py-1 border-b border-destructive/20">
        <span className="text-[10px] font-medium text-destructive/90">
          {title}
        </span>
        <button
          type="button"
          onClick={copy}
          title="Copy error output"
          aria-label="Copy error output"
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-destructive/90 hover:bg-destructive/15 transition-colors"
        >
          {copied ? (
            <Check className="h-3 w-3" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="max-h-48 overflow-auto p-2 text-[10px] font-mono leading-[15px] whitespace-pre-wrap break-all text-destructive/90">
        {lines.join("\n")}
      </pre>
    </div>
  );
}
