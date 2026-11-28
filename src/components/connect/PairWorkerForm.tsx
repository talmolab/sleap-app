import { useEffect, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronRight,
  Copy,
  ExternalLink,
  Loader2,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDocsUrl } from "@/lib/docsUrl";
import { openExternal } from "@/lib/openExternal";
import { cn } from "@/lib/utils";
import { decodePairCode, isPairCode } from "@/lib/protocolV1/pairCode";
import {
  NOT_A_CODE,
  planPairing,
  type PairingCodeInfo,
  type PairingPlan,
} from "@/lib/protocolV1/pairingPlan";
import { irohTransportAvailable, parseTicketIroh } from "@/lib/protocolV1/transport";
import { useConnectStore } from "@/stores/connectStore";

/** One-liner to start a sleap-connect worker via uvx on a GPU machine. */
export const WORKER_UVX_COMMAND =
  'uvx --python 3.11 --from "sleap-connect[nn]" --torch-backend auto sleap-connect serve';

/** Resolve the Remote Compute guide URL for the running app's docs channel. */
export function remoteComputeDocsUrl(docsBaseUrl: string): string {
  const base = docsBaseUrl.endsWith("/") ? docsBaseUrl : `${docsBaseUrl}/`;
  return `${base}guides/remote-compute/`;
}

/**
 * Compact helper showing a copyable `uvx` command to launch a worker on a
 * remote GPU machine plus a channel-aware link to the Remote Compute docs.
 * Shared by the Connect sidebar panel and the Connect window's empty state.
 */
export function WorkerQuickStart({ className }: { className?: string }) {
  const docsUrl = useDocsUrl();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const docsHref = remoteComputeDocsUrl(docsUrl);

  const handleCopy = async () => {
    if (!navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(WORKER_UVX_COMMAND);
      setCopied(true);
    } catch {
      // Clipboard unavailable (e.g., restricted context) — select-all still lets the user copy manually.
    }
  };

  return (
    <div
      data-testid="worker-quick-start"
      className={cn(
        "bg-zinc-800/50 border border-border rounded-md p-2.5 space-y-2 text-left",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
          Run a worker
        </span>
        <a
          href={docsHref}
          target="_blank"
          rel="noopener noreferrer"
          title="Open Remote Compute documentation"
          onClick={(e) => {
            e.preventDefault();
            void openExternal(docsHref);
          }}
          className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline shrink-0"
        >
          <BookOpen className="h-3 w-3" />
          Docs
          <ExternalLink className="h-2.5 w-2.5" />
        </a>
      </div>
      <p className="text-[10px] text-muted-foreground leading-relaxed">
        On your GPU machine (with{" "}
        <code className="bg-black/30 px-1 py-0.5 rounded font-mono">uv</code>{" "}
        installed), run in your data folder:
      </p>
      <div className="flex items-start gap-1">
        <code
          data-testid="worker-uvx-command"
          className="min-w-0 flex-1 select-all break-words rounded bg-black/30 px-1.5 py-1 font-mono text-[10px] leading-snug text-foreground/90"
        >
          {WORKER_UVX_COMMAND}
        </code>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="h-6 w-6 shrink-0"
          title={copied ? "Copied" : "Copy command"}
          aria-label={copied ? "Copied" : "Copy worker command"}
          onClick={() => void handleCopy()}
        >
          {copied ? (
            <Check className="h-3 w-3 text-green-500" />
          ) : (
            <Copy className="h-3 w-3" />
          )}
        </Button>
      </div>
    </div>
  );
}

/**
 * What pasted text says about reaching the worker — a one-line pairing code
 * or a legacy JSON ticket — or null if it's neither. Never throws on partial
 * input (an in-progress paste, a mistyped code); validating the ticket for
 * real is `pairWithTicket`'s job once Pair is clicked.
 */
async function readCodeInfo(text: string): Promise<PairingCodeInfo | null> {
  const trimmed = text.trim();
  if (isPairCode(trimmed)) {
    try {
      const t = await decodePairCode(trimmed);
      return { expiresAt: t.expires_at, addrs: t.addrs, hasRelay: !!t.iroh };
    } catch {
      return null;
    }
  }
  try {
    const t = JSON.parse(trimmed) as { addrs?: string[]; expires_at?: number; iroh?: unknown };
    return {
      expiresAt: t.expires_at,
      addrs: t.addrs ?? [],
      hasRelay: !!parseTicketIroh(t.iroh)?.relayUrl,
    };
  } catch {
    return null;
  }
}

function PlanLine({ plan }: { plan: PairingPlan }) {
  const [Icon, color, text] =
    plan.kind === "ready"
      ? [CheckCircle2, "text-green-400", plan.detail]
      : plan.kind === "needs-address"
        ? [AlertTriangle, "text-amber-400", plan.reason]
        : [XCircle, "text-red-400", plan.message];
  return (
    <p className={`flex items-start gap-1.5 text-[10px] ${color}`}>
      <Icon className="mt-px h-3 w-3 shrink-0" />
      <span>{text}</span>
    </p>
  );
}

export interface PairWorkerFormProps {
  /** Called right after a successful pair (ticket + address cleared already). */
  onPaired?: () => void;
  /** Called when Cancel is clicked. */
  onCancel?: () => void;
  /** Whether to show the Cancel button — hidden when this is the only way forward (no workers paired yet). */
  showCancel: boolean;
}

/**
 * The "paste a pairing code" form, shared by the Connect panel and the
 * Connect window's worker list (pairing, and re-pairing a worker whose
 * identity changed). Takes the one-line code `sleap-connect serve`/`pair` print (or a legacy
 * JSON ticket) and works out how to connect by itself (`planPairing`): the
 * user only pastes. The address box stays under "Advanced" unless the code
 * can't be used without one, and then says why.
 */
export function PairWorkerForm({ onPaired, onCancel, showCancel }: PairWorkerFormProps) {
  const pairWithTicket = useConnectStore((s) => s.pairWithTicket);

  const [ticketText, setTicketText] = useState("");
  const [addrText, setAddrText] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  // undefined = nothing pasted yet; null = pasted text isn't a code.
  const [codeInfo, setCodeInfo] = useState<PairingCodeInfo | null | undefined>(undefined);

  const irohAvailable = irohTransportAvailable();

  // Async (a pairing code's checksum check needs Web Crypto) — recomputed
  // on every keystroke, so a stale in-flight check for a since-edited value
  // must never overwrite a newer one.
  useEffect(() => {
    if (!ticketText.trim()) {
      setCodeInfo(undefined);
      return;
    }
    let cancelled = false;
    void readCodeInfo(ticketText).then((info) => {
      if (!cancelled) setCodeInfo(info);
    });
    return () => {
      cancelled = true;
    };
  }, [ticketText]);

  const plan: PairingPlan | null =
    codeInfo === undefined
      ? null
      : codeInfo === null
        ? { kind: "error", message: NOT_A_CODE }
        : planPairing(codeInfo, { irohAvailable, addrOverride: addrText });
  const showAddress = advancedOpen || plan?.kind === "needs-address";

  const handlePair = async () => {
    if (plan?.kind !== "ready") return;
    setPairing(true);
    setPairError(null);
    try {
      await pairWithTicket(ticketText.trim(), addrText.trim() || undefined, {
        transport: plan.transport,
      });
      setTicketText("");
      setAddrText("");
      setAdvancedOpen(false);
      onPaired?.();
    } catch (err) {
      setPairError(err instanceof Error ? err.message : "Failed to pair with worker");
    } finally {
      setPairing(false);
    }
  };

  return (
    <div className="bg-zinc-800/50 border border-border rounded-md p-3 space-y-2">
      <h3 className="text-xs font-medium">Pair with a worker</h3>
      <p className="text-[10px] text-muted-foreground leading-relaxed">
        Paste the code{" "}
        <code className="bg-black/30 px-1 py-0.5 rounded text-[10px] font-mono">
          sleap-connect serve
        </code>{" "}
        printed on the worker, or get a new one there with{" "}
        <code className="bg-black/30 px-1 py-0.5 rounded text-[10px] font-mono">
          sleap-connect pair
        </code>
        .
      </p>
      <Input
        value={ticketText}
        onChange={(e) => setTicketText(e.target.value)}
        placeholder="sleap1…"
        aria-label="Pairing code"
        className="h-7 text-xs font-mono"
      />
      {plan && <PlanLine plan={plan} />}
      {plan?.kind !== "needs-address" && (
        <button
          type="button"
          className="flex items-center gap-0.5 text-[10px] text-muted-foreground hover:text-foreground"
          onClick={() => setAdvancedOpen((o) => !o)}
        >
          <ChevronRight
            className={`h-3 w-3 transition-transform ${showAddress ? "rotate-90" : ""}`}
          />
          Advanced: connect by address
        </button>
      )}
      {showAddress && (
        <div className="space-y-1">
          <label className="text-[10px] text-muted-foreground" htmlFor="pair-worker-address">
            Worker address (e.g. its Tailscale IP)
          </label>
          <input
            id="pair-worker-address"
            type="text"
            value={addrText}
            onChange={(e) => setAddrText(e.target.value)}
            placeholder="ws://192.168.1.42:9631"
            className="w-full h-7 px-2 text-xs bg-zinc-900 border border-border rounded-md font-mono"
          />
        </div>
      )}
      {pairError && <p className="text-[10px] text-red-400">{pairError}</p>}
      <div className="flex gap-1.5">
        <Button
          size="sm"
          className="flex-1 h-7 text-xs"
          disabled={pairing || plan?.kind !== "ready"}
          onClick={handlePair}
        >
          {pairing ? <Loader2 className="h-3 w-3 mr-1.5 animate-spin" /> : null}
          {pairing ? "Pairing…" : "Pair"}
        </Button>
        {showCancel && (
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
