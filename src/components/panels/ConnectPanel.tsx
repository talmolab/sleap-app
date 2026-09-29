import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plug, Trash2, Unplug, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  irohTransportAvailable,
  parseTicketIroh,
  transportLabel,
  type TransportKind,
} from "@/lib/protocolV1/transport";
import { useConnectStore } from "@/stores/connectStore";

/** Whether pasted ticket text has a usable `iroh` section. Never throws on partial/invalid JSON. */
function ticketOffersIroh(ticketText: string): boolean {
  try {
    return parseTicketIroh((JSON.parse(ticketText) as { iroh?: unknown }).iroh) !== undefined;
  } catch {
    return false;
  }
}

export function ConnectPanel() {
  const pairedWorkers = useConnectStore((s) => s.pairedWorkers);
  const selectedWorkerId = useConnectStore((s) => s.selectedWorkerId);
  const connectionStatus = useConnectStore((s) => s.connectionStatus);
  const connectionError = useConnectStore((s) => s.connectionError);
  const activeTransport = useConnectStore((s) => s.activeTransport);
  const pairWithTicket = useConnectStore((s) => s.pairWithTicket);
  const connectToWorker = useConnectStore((s) => s.connectToWorker);
  const disconnect = useConnectStore((s) => s.disconnect);
  const forgetWorker = useConnectStore((s) => s.forgetWorker);

  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [showPairForm, setShowPairForm] = useState(pairedWorkers.length === 0);
  const [ticketText, setTicketText] = useState("");
  const [addrText, setAddrText] = useState("");
  const [pairing, setPairing] = useState(false);
  const [pairError, setPairError] = useState<string | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [pairViaIroh, setPairViaIroh] = useState(false);

  const irohAvailable = irohTransportAvailable();
  const ticketHasIroh = useMemo(() => irohAvailable && ticketOffersIroh(ticketText), [
    irohAvailable,
    ticketText,
  ]);

  // zustand's persist middleware hydrates asynchronously (a microtask) even
  // with synchronous localStorage — this component's very first render can
  // still see `pairedWorkers: []` before that resolves. Correct the initial
  // guess exactly once so a genuinely non-empty persisted list doesn't get
  // stuck showing the pair form; a `false` ref guards against re-closing a
  // form the user re-opened later via the "Add" button.
  const autoClosedPairFormRef = useRef(false);
  useEffect(() => {
    if (!autoClosedPairFormRef.current && pairedWorkers.length > 0) {
      autoClosedPairFormRef.current = true;
      setShowPairForm(false);
    }
  }, [pairedWorkers.length]);

  // This device's own identity — shown for transparency/debugging, never
  // needs to be typed in manually (pairClaim sends it automatically).
  useEffect(() => {
    import("@/lib/protocolV1/identity").then(({ getClientIdentity }) =>
      getClientIdentity().then((identity) => setDeviceId(identity.nodeId)),
    );
  }, []);

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
      setShowPairForm(false);
    } catch (err) {
      setPairError(err instanceof Error ? err.message : "Failed to pair with worker");
    } finally {
      setPairing(false);
    }
  };

  const handleConnect = async (nodeId: string, transport?: TransportKind) => {
    setConnectingId(nodeId);
    try {
      await connectToWorker(nodeId, transport ? { transport } : undefined);
    } catch {
      // connectionError already reflects the failure
    } finally {
      setConnectingId(null);
    }
  };

  return (
    <div className="p-2 space-y-3">
      {connectionStatus === "error" && connectionError && (
        <div className="bg-red-500/8 border border-red-500/20 rounded-md p-2 text-[11px] text-red-400">
          {connectionError}
        </div>
      )}

      {pairedWorkers.length > 0 && (
        <div className="space-y-1.5">
          <label className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
            Paired workers ({pairedWorkers.length})
          </label>
          {pairedWorkers.map((w) => {
            const isSelected = selectedWorkerId === w.nodeId;
            const isConnected = isSelected && connectionStatus === "connected";
            const isConnecting =
              connectingId === w.nodeId || (isSelected && connectionStatus === "connecting");
            const offersIroh = irohAvailable && w.iroh !== undefined;
            return (
              <div
                key={w.nodeId}
                className={`border rounded-md p-2 transition-colors ${
                  isConnected ? "bg-primary/10 border-primary" : "bg-zinc-800/50 border-border"
                }`}
              >
                <div className="flex items-center gap-1.5 text-xs font-medium">
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      isConnected ? "bg-green-500" : "bg-zinc-500"
                    }`}
                  />
                  <span className="truncate">{w.label}</span>
                  <Button
                    variant="ghost"
                    size="xs"
                    className="ml-auto h-5 w-5 p-0 text-muted-foreground hover:text-red-400"
                    title="Forget this worker"
                    onClick={() => forgetWorker(w.nodeId)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
                <div className="text-[10px] text-muted-foreground font-mono mt-0.5 truncate">
                  {w.nodeId.slice(0, 16)}… · {w.addrs[0] ?? "no known address"}
                </div>
                {isConnected && activeTransport && (
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    Connected via {transportLabel(activeTransport)}
                  </div>
                )}
                <div className="mt-1.5 space-y-1">
                  {isConnected ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full h-7 text-xs"
                      onClick={disconnect}
                    >
                      <Unplug className="h-3 w-3 mr-1.5" />
                      Disconnect
                    </Button>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        className="w-full h-7 text-xs"
                        disabled={isConnecting || !w.addrs[0]}
                        onClick={() => handleConnect(w.nodeId, offersIroh ? "ws" : undefined)}
                      >
                        {isConnecting ? (
                          <Loader2 className="h-3 w-3 mr-1.5 animate-spin" />
                        ) : (
                          <Plug className="h-3 w-3 mr-1.5" />
                        )}
                        {isConnecting ? "Connecting…" : offersIroh ? "Connect (WebSocket)" : "Connect"}
                      </Button>
                      {offersIroh && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="w-full h-7 text-xs"
                          disabled={isConnecting}
                          onClick={() => handleConnect(w.nodeId, "iroh")}
                        >
                          <Zap className="h-3 w-3 mr-1.5" />
                          Connect directly (iroh)
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="h-px bg-border" />

      {!showPairForm ? (
        <Button
          size="sm"
          variant="outline"
          className="w-full h-7 text-xs"
          onClick={() => setShowPairForm(true)}
        >
          Pair a new worker
        </Button>
      ) : (
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
            {pairedWorkers.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                onClick={() => {
                  setShowPairForm(false);
                  setPairError(null);
                }}
              >
                Cancel
              </Button>
            )}
          </div>
        </div>
      )}

      {deviceId && (
        <p className="text-[9px] text-muted-foreground/70 font-mono truncate pt-1">
          This device: {deviceId.slice(0, 16)}…
        </p>
      )}
    </div>
  );
}
