/**
 * Which transport a `WorkerClient` connection runs over (stage 2.6):
 * the plain WebSocket dial (`ws://host:port`, works in browser + desktop) or
 * a direct iroh QUIC connection (desktop only, via `tauriIrohSocket.ts`).
 *
 * The choice is always explicit — there's no automatic failover between the
 * two (that's stage 2.7). A worker only offers iroh if its pairing ticket
 * carried an `iroh` section (stage 2.1); tickets without one behave exactly
 * as before.
 */
import { isTauri } from "@/platform/index";
import type { IrohDialTarget } from "./tauriIrohSocket";

export type TransportKind = "ws" | "iroh";

/** The optional `iroh` section of a pairing ticket / paired worker. */
export interface IrohEndpointInfo {
  /** The worker's iroh endpoint id; falls back to the protocol node_id when absent. */
  nodeId?: string;
  relayUrl?: string;
  directAddrs?: string[];
}

/**
 * Tolerantly reads a ticket's `iroh` section (snake_case wire keys). Returns
 * `undefined` for anything that isn't a usable object, so a malformed
 * section never breaks pairing over WebSocket.
 */
export function parseTicketIroh(raw: unknown): IrohEndpointInfo | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);
  const directAddrs = Array.isArray(r.direct_addrs)
    ? r.direct_addrs.filter((a): a is string => typeof a === "string" && a.length > 0)
    : undefined;
  return {
    nodeId: str(r.node_id),
    relayUrl: str(r.relay_url),
    directAddrs: directAddrs && directAddrs.length > 0 ? directAddrs : undefined,
  };
}

/** Whether direct iroh connections can be dialed from this runtime. */
export function irohTransportAvailable(): boolean {
  return isTauri;
}

export function transportLabel(kind: TransportKind): string {
  return kind === "iroh" ? "iroh (direct)" : "WebSocket";
}

export function toIrohDialTarget(info: IrohEndpointInfo, fallbackNodeId: string): IrohDialTarget {
  return {
    nodeId: info.nodeId ?? fallbackNodeId,
    relayUrl: info.relayUrl,
    directAddrs: info.directAddrs,
  };
}
