/**
 * Environment panel section: "Allow Claude to control SLEAP" and, while on,
 * the command that connects Claude Code. Desktop only.
 */
import { useEffect, useState } from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { claudeMcpAddCommand, useClaudeConnectorStore } from "@/stores/claudeConnectorStore";

export function ClaudeConnectorSection() {
  const enabled = useClaudeConnectorStore((s) => s.enabled);
  const info = useClaudeConnectorStore((s) => s.info);
  const busy = useClaudeConnectorStore((s) => s.busy);
  const error = useClaudeConnectorStore((s) => s.error);
  const setEnabled = useClaudeConnectorStore((s) => s.setEnabled);
  const [copied, setCopied] = useState(false);
  const command = info ? claudeMcpAddCommand(info) : null;

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <section data-testid="claude-connector">
      <div className="mb-1 flex items-center gap-2">
        <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Claude</h4>
        {busy && <Loader2 className="ml-auto h-3 w-3 animate-spin text-muted-foreground" />}
      </div>
      <label className="flex cursor-pointer items-start gap-2 text-xs">
        <Checkbox
          checked={enabled}
          disabled={busy}
          onCheckedChange={(v) => void setEnabled(v === true)}
          aria-label="Allow Claude to control SLEAP"
          className="mt-0.5"
        />
        <span>
          Allow Claude to control SLEAP
          <span className="block text-[10px] text-muted-foreground">
            Claude Code on this computer can review Label QC flags and propose fixes. Nothing changes until you
            accept a fix in the QC Review window. Claude can&apos;t save.
          </span>
        </span>
      </label>
      {error && <p className="mt-1 text-[10px] text-red-400">{error}</p>}
      {enabled && command && (
        <div className="mt-2 space-y-1">
          <p className="text-[10px] text-muted-foreground">Run this once in a terminal to connect Claude Code:</p>
          <div className="flex items-start gap-1">
            <code
              className="min-w-0 flex-1 select-all break-all rounded bg-muted px-1.5 py-1 font-mono text-[10px]"
              data-testid="claude-mcp-command"
            >
              {command}
            </code>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 shrink-0"
              title="Copy"
              aria-label="Copy the command"
              onClick={() => {
                void navigator.clipboard?.writeText(command);
                setCopied(true);
              }}
            >
              {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
            </Button>
          </div>
          <p className="text-[10px] text-muted-foreground">
            Then ask Claude to &quot;review the Label QC flags in SLEAP&quot;. The command contains a secret token: don&apos;t
            share it. Listening on {info!.url}.
          </p>
        </div>
      )}
    </section>
  );
}
