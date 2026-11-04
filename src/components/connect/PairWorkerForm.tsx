import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronRight, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { decodePairCode, isPairCode } from "@/lib/protocolV1/pairCode";
import {
  NOT_A_CODE,
  planPairing,
  type PairingCodeInfo,
  type PairingPlan,
} from "@/lib/protocolV1/pairingPlan";
import { irohTransportAvailable, parseTicketIroh } from "@/lib/protocolV1/transport";
import { useConnectStore } from "@/stores/connectStore";

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
 * identity changed). Takes `sleap-connect pair`'s one-line code (or a legacy
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
        On the worker, run{" "}
        <code className="bg-black/30 px-1 py-0.5 rounded text-[10px] font-mono">
          sleap-connect pair
        </code>{" "}
        and paste the code it prints.
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
