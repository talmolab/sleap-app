import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { irohTransportAvailable, parseTicketIroh } from "@/lib/protocolV1/transport";
import { useConnectStore } from "@/stores/connectStore";

/** Whether pasted ticket text has a usable `iroh` section. Never throws on partial/invalid JSON. */
function ticketOffersIroh(ticketText: string): boolean {
  try {
    return parseTicketIroh((JSON.parse(ticketText) as { iroh?: unknown }).iroh) !== undefined;
  } catch {
    return false;
  }
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
 * The "paste a pairing ticket" form — extracted from `ConnectPanel` (PR4b
 * §4b.1) so the Connect window's `WorkerList` (§4b.3) can reuse it both for
 * "+ Pair worker" and for re-pairing a worker whose identity changed,
 * without duplicating the ticket-parsing/iroh-checkbox logic.
 */
export function PairWorkerForm({ onPaired, onCancel, showCancel }: PairWorkerFormProps) {
  const pairWithTicket = useConnectStore((s) => s.pairWithTicket);

  const [ticketText, setTicketText] = useState("");
  const [addrText, setAddrText] = useState("");
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [pairViaIroh, setPairViaIroh] = useState(false);

  const irohAvailable = irohTransportAvailable();
  const ticketHasIroh = useMemo(() => irohAvailable && ticketOffersIroh(ticketText), [
    irohAvailable,
    ticketText,
  ]);

  const handlePair = async () => {
    setPairing(true);
    setPairError(null);
    try {
      await pairWithTicket(
        ticketText.trim(),
        addrText.trim() || undefined,
        ticketHasIroh && pairViaIroh ? { transport: "iroh" } : undefined,
      );
      setTicketText("");
      setAddrText("");
      setPairViaIroh(false);
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
        On the machine you want to train/infer on, run{" "}
        <code className="bg-black/30 px-1 py-0.5 rounded text-[10px] font-mono">
          sleap-rtc serve
        </code>
        , then in another terminal{" "}
        <code className="bg-black/30 px-1 py-0.5 rounded text-[10px] font-mono">
          sleap-rtc pair
        </code>
        . Paste the printed ticket JSON below.
      </p>
      <textarea
        value={ticketText}
        onChange={(e) => setTicketText(e.target.value)}
        placeholder='{"node_id": "...", "addrs": [...], "secret": "...", ...}'
        rows={5}
        className="w-full px-2 py-1.5 text-[11px] bg-zinc-900 border border-border rounded-md font-mono resize-none"
      />
      <div className="space-y-1">
        <label className="text-[10px] text-muted-foreground">
          Worker address (only needed if the ticket has none)
        </label>
        <input
          type="text"
          value={addrText}
          onChange={(e) => setAddrText(e.target.value)}
          placeholder="ws://192.168.1.42:9631"
          className="w-full h-7 px-2 text-xs bg-zinc-900 border border-border rounded-md font-mono"
        />
      </div>
      {ticketHasIroh && (
        <label className="flex items-start gap-1.5 text-[10px] text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={pairViaIroh}
            onChange={(e) => setPairViaIroh(e.target.checked)}
            className="mt-0.5"
          />
          <span>Connect directly (iroh) — this ticket includes a direct address</span>
        </label>
      )}
      {pairError && <p className="text-[10px] text-red-400">{pairError}</p>}
      <div className="flex gap-1.5">
        <Button
          size="sm"
          className="flex-1 h-7 text-xs"
          disabled={pairing || !ticketText.trim()}
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
