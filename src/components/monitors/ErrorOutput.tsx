/**
 * ErrorOutput — a compact red box showing the forwarded stderr tail from a
 * failed sleap-nn run.
 *
 * Training and inference both keep the last stderr lines (`stderrTail`); when a
 * run errors we render them here so the tester sees the ACTUAL error output in
 * the training/inference window, not just a one-line summary — no need to open
 * the full log. Renders nothing when there are no lines.
 */
export function ErrorOutput({
  lines,
  title = "Error output",
  className = "",
}: {
  lines: string[];
  title?: string;
  className?: string;
}) {
  if (!lines || lines.length === 0) return null;
  return (
    <div
      className={`rounded-md border border-destructive/30 bg-destructive/10 overflow-hidden ${className}`}
    >
      <div className="px-2 py-1 text-[10px] font-medium text-destructive/90 border-b border-destructive/20">
        {title}
      </div>
      <pre className="max-h-48 overflow-auto p-2 text-[10px] font-mono leading-[15px] whitespace-pre-wrap break-all text-destructive/90">
        {lines.join("\n")}
      </pre>
    </div>
  );
}
