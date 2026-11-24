/**
 * Environment panel section: "Allow Claude to control SLEAP" and, while on,
 * the command that connects Claude Code. Desktop only.
 */
import { useEffect, useState } from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ownsConnector, useClaudeConnectorStore } from "@/stores/claudeConnectorStore";
import { useProposalStore } from "@/stores/proposalStore";
import { useAppStore } from "@/stores/appStore";
import { openClaudeSuggestions, undecidedCount } from "@/lib/proposalReview";

/** How often the panel re-reads the endpoint's state while shown. */
const REFRESH_MS = 5000;

export function ClaudeConnectorSection() {
  const enabled = useClaudeConnectorStore((s) => s.enabled);
  const status = useClaudeConnectorStore((s) => s.status);
  const windowLabel = useClaudeConnectorStore((s) => s.windowLabel);
  const busy = useClaudeConnectorStore((s) => s.busy);
  const error = useClaudeConnectorStore((s) => s.error);
  const portInUse = useClaudeConnectorStore((s) => s.portInUse);
  const portChanged = useClaudeConnectorStore((s) => s.portChanged);
  const setEnabled = useClaudeConnectorStore((s) => s.setEnabled);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const refresh = () => void useClaudeConnectorStore.getState().refresh();
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const mine = ownsConnector({ status, windowLabel });
  const elsewhere = !!status?.running && !mine;
  const command = status?.running ? status.connect_command : null;

  return (
    <section data-testid="claude-connector">
      <div className="mb-1 flex items-center gap-2">
        <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Claude</h4>
        {busy && <Loader2 className="ml-auto h-3 w-3 animate-spin text-muted-foreground" />}
      </div>
      <label className="flex cursor-pointer items-start gap-2 text-xs">
        <Checkbox
          checked={!!status?.running || (enabled && busy)}
          disabled={busy}
          onCheckedChange={(v) => void setEnabled(v === true)}
          aria-label="Allow Claude to control SLEAP"
          className="mt-0.5"
        />
        <span>
          Allow Claude to control SLEAP
          <span className="block text-[10px] text-muted-foreground">
            Claude Code on this computer can review Label QC flags and predictions and propose fixes. Nothing
            changes until you accept a fix in the Review window. Claude can&apos;t save.
          </span>
        </span>
      </label>

      {error && (
        <p className="mt-1 text-[10px] text-red-400" data-testid="claude-connector-error">
          {error}
        </p>
      )}
      {portInUse && (
        <Button
          size="sm"
          variant="outline"
          className="mt-1 h-6 text-[11px]"
          disabled={busy}
          onClick={() => void setEnabled(true, { newPort: true })}
        >
          Use a new port
        </Button>
      )}
      {status?.error && <p className="mt-1 text-[10px] text-red-400">{status.error}</p>}

      {elsewhere && (
        <div className="mt-2 space-y-1 text-[10px] text-muted-foreground" data-testid="claude-connector-elsewhere">
          <p>
            {status!.owner_alive
              ? "Claude is connected through another SLEAP window."
              : "The SLEAP window Claude was connected through was closed."}
          </p>
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-[11px]"
            disabled={busy}
            onClick={() => void setEnabled(true)}
          >
            Connect Claude to this window
          </Button>
        </div>
      )}

      <ReviewSuggestionsButton />

      {mine && command && (
        <div className="mt-2 space-y-1">
          {portChanged && (
            <p className="text-[10px] text-amber-500">
              The port changed: run the command below again so Claude Code finds SLEAP.
            </p>
          )}
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
            Then ask Claude to &quot;review the Label QC flags in SLEAP&quot; or &quot;correct the
            low-confidence predictions in SLEAP&quot;. SLEAP makes a new access token each
            launch; Claude Code reads it from ~/.sleap-app/mcp-headers.json each time it connects, so the command is
            only needed once. Listening on {status!.info?.url}.
          </p>
        </div>
      )}
    </section>
  );
}

/** Opens the Review window on Claude's suggestions, while there are any. */
function ReviewSuggestionsButton() {
  const proposals = useProposalStore((s) => s.proposals);
  // An edit can make a suggestion outdated (no longer to decide).
  useAppStore((s) => s.editSeq);
  if (proposals.length === 0) return null;
  const n = undecidedCount(proposals);
  return (
    <Button
      size="sm"
      variant="outline"
      className="mt-2 h-6 text-[11px]"
      onClick={() => openClaudeSuggestions()}
      data-testid="claude-review-suggestions"
    >
      Review Claude&apos;s suggestions{n > 0 ? ` (${n} to decide)` : ""}
    </Button>
  );
}
