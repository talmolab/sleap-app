import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { decodePairCode, isPairCode } from "@/lib/protocolV1/pairCode";
import { irohTransportAvailable, parseTicketIroh } from "@/lib/protocolV1/transport";
import { useConnectStore } from "@/stores/connectStore";

/**
 * Whether pasted ticket text (a one-line pairing code OR a legacy JSON
 * ticket) carries a relay a client can dial over iroh — `undefined`/absent
 * relay (a code with `iroh: undefined`, or a JSON ticket whose `iroh`
 * section omits `relay_url`) reads as "no". Never throws on partial/invalid
 * input (an in-progress paste, a mistyped code, non-JSON text); it's only
 * ever used to decide whether to show the "connect directly" checkbox, not
 * to validate the ticket (that's `pairWithTicket`'s job once Pair is
 * clicked).
 */
async function ticketOffersIroh(ticketText: string): Promise<boolean> {
  const trimmed = ticketText.trim();
  if (!trimmed) return false;
  if (isPairCode(trimmed)) {
    try {
      return !!(await decodePairCode(trimmed)).iroh;
    } catch {
      return false;
    }
  }
  try {
    const parsed = JSON.parse(trimmed) as { iroh?: unknown };
    return !!parseTicketIroh(parsed.iroh)?.relayUrl;
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
 * The "paste a pairing code" form — extracted from `ConnectPanel` (PR4b
 * §4b.1) so the Connect window's `WorkerList` (§4b.3) can reuse it both for
 * "+ Pair worker" and for re-pairing a worker whose identity changed,
 * without duplicating the ticket-parsing/iroh-checkbox logic. Accepts
 * `sleap-rtc pair`'s one-line pairing code (PR6a §a.1/a.2, the normal path
 * now) as a single-line paste, or a legacy multi-line JSON ticket (still
 * accepted — `pairWithTicket` tells the two apart itself).
 */
export function PairWorkerForm({ onPaired, onCancel, showCancel }: PairWorkerFormProps) {
  const pairWithTicket = useConnectStore((s) => s.pairWithTicket);

  const [ticketText, setTicketText] = useState("");
  const [addrText, setAddrText] = useState("");
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [pairViaIroh, setPairViaIroh] = useState(false);
  const [ticketHasIroh, setTicketHasIroh] = useState(false);

  const irohAvailable = irohTransportAvailable();

  // Async (a pairing code's checksum check needs Web Crypto) — recomputed
  // on every keystroke, so a stale in-flight check for a since-edited value
  // must never overwrite a newer one.
  useEffect(() => {
    if (!irohAvailable) {
      setTicketHasIroh(false);
      return;
    }
    let cancelled = false;
    void ticketOffersIroh(ticketText).then((offersIroh) => {
      if (!cancelled) setTicketHasIroh(offersIroh);
    });
    return () => {
      cancelled = true;
    };
  }, [ticketText, irohAvailable]);

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
        . Run{" "}
        <code className="bg-black/30 px-1 py-0.5 rounded text-[10px] font-mono">
          sleap-rtc pair
        </code>{" "}
        on the worker and paste the code below.
      </p>
      <Input
        value={ticketText}
        onChange={(e) => setTicketText(e.target.value)}
        placeholder="sleap1…"
        className="h-7 text-xs font-mono"
      />
      <div className="space-y-1">
        <label className="text-[10px] text-muted-foreground">
          Worker address (only needed if the code has none)
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
          <span>Connect directly (iroh) — this code includes a direct address</span>
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
