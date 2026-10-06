import { useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2, Plug, Trash2, Unplug, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { irohTransportAvailable, transportLabel, type TransportKind } from "@/lib/protocolV1/transport";
import { useConnectStore } from "@/stores/connectStore";
import { useAppStore } from "@/stores/appStore";
import { PairWorkerForm } from "@/components/connect/PairWorkerForm";

export function ConnectPanel() {
  const setConnectWindowOpen = useAppStore((s) => s.setConnectWindowOpen);
  const pairedWorkers = useConnectStore((s) => s.pairedWorkers);
  const selectedWorkerId = useConnectStore((s) => s.selectedWorkerId);
  const connectionStatus = useConnectStore((s) => s.connectionStatus);
  const connectionError = useConnectStore((s) => s.connectionError);
  const activeTransport = useConnectStore((s) => s.activeTransport);
  const connectToWorker = useConnectStore((s) => s.connectToWorker);
  const disconnect = useConnectStore((s) => s.disconnect);
  const forgetWorker = useConnectStore((s) => s.forgetWorker);

  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [showPairForm, setShowPairForm] = useState(pairedWorkers.length === 0);
  const [connectingId, setConnectingId] = useState<string | null>(null);

  const irohAvailable = irohTransportAvailable();

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
      <Button
        size="sm"
        variant="outline"
        className="w-full h-7 text-xs"
        onClick={() => setConnectWindowOpen(true)}
      >
        <ExternalLink className="h-3 w-3 mr-1.5" />
        Open Connect window
      </Button>

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
            const isReconnecting = isSelected && connectionStatus === "reconnecting";
            const isConnecting =
              connectingId === w.nodeId || (isSelected && connectionStatus === "connecting");
            const offersIroh = irohAvailable && w.iroh !== undefined;
            return (
              <div
                key={w.nodeId}
                className={`border rounded-md p-2 transition-colors ${
                  isConnected || isReconnecting
                    ? "bg-primary/10 border-primary"
                    : "bg-zinc-800/50 border-border"
                }`}
              >
                <div className="flex items-center gap-1.5 text-xs font-medium">
                  <span
                    className={`w-1.5 h-1.5 rounded-full ${
                      isConnected ? "bg-green-500" : isReconnecting ? "bg-amber-500" : "bg-zinc-500"
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
                {isReconnecting && (
                  <div className="text-[10px] text-amber-400 mt-0.5">
                    Reconnecting…{activeTransport ? ` via ${transportLabel(activeTransport)}` : ""}
                  </div>
                )}
                <div className="mt-1.5 space-y-1">
                  {isConnected || isReconnecting ? (
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
        <PairWorkerForm
          onPaired={() => setShowPairForm(false)}
          onCancel={() => setShowPairForm(false)}
          showCancel={pairedWorkers.length > 0}
        />
      )}

      {deviceId && (
        <p className="text-[9px] text-muted-foreground/70 font-mono truncate pt-1">
          This device: {deviceId.slice(0, 16)}…
        </p>
      )}
    </div>
  );
}
