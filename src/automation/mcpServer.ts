/**
 * The Claude connector's MCP server, running in the SLEAP window. The desktop
 * app's loopback endpoint (src-tauri/src/mcp_bridge.rs) receives Claude's
 * JSON-RPC over HTTP and hands each message to this window as an
 * `mcp:request` event; replies go back with the `mcp_response` command.
 * Tools come from the same registry as `window.sleap.automation`.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type JSONRPCMessage,
  type Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { registry as defaultRegistry } from "./tools";
import type { ToolRegistry } from "./registry";
import { APP_VERSION } from "@/lib/version";
import { sleapCmd } from "@/lib/sleapPlugin";

/** What Claude reads first: what SLEAP is and how the QC-review tools fit together. */
export const SERVER_INSTRUCTIONS = `SLEAP is a pose-tracking app: users label body parts ("nodes", joined by "edges" into a skeleton) on animals in video frames, train models, and check their labels. This server connects you to the SLEAP desktop window the user has open.

What you can do here: review Label QC flags. Label QC finds labeled poses that look wrong (a node on the wrong body part, swapped left/right, an implausible shape, duplicates). You look at each flagged pose and PROPOSE a fix or propose ignoring the flag. The user accepts or rejects each proposal in SLEAP's QC Review window. You never change labels yourself, and there is no save tool.

Workflow:
1. get_session: see what is open and whether Label QC has been run. If it hasn't, ask the user to run Analyze → Label Quality Check (or open the Label QC panel and run it), then continue.
2. list_qc_flags: the open flags, most severe first, with stable ids. Skip flags whose 'proposal' is already 'pending' or 'accepted'.
3. For each flag on an instance: render_flag(flag_id). Look at the picture carefully: node names are drawn next to each node of the flagged animal; other animals are dimmed. Decide whether a node is misplaced, whether a node that should be hidden (occluded, out of view) is placed, or whether the pose is actually fine.
4. propose_fix(flag_id, render_id, nodes, reason) with positions in the PICTURE'S PIXELS (origin top-left, x right, y down) as returned by render_flag — the app converts them; do no math. Only list nodes you want to change; null marks a node not visible. Or propose_ignore(flag_id, reason) if the pose is right.
5. Keep reasons to one short sentence the user can check at a glance ("head was on the left wing tip").

Rules:
- Only propose a change you can see is right in the picture. When unsure, say so in the reason or leave the flag for the user.
- Never tell the user a fix is applied, saved or done. Say it is proposed and waiting for them in the Review window. list_proposals shows what they accepted, rejected or undid, and which proposals are outdated because the pose changed.
- Frame-level flags (instance null) can't be fixed or ignored here; mention them to the user instead.
- Work through flags in batches (for example 10 at a time) and summarize what you proposed.`;

export function createMcpServer(registry: ToolRegistry = defaultRegistry): Server {
  const server = new Server(
    { name: "sleap", title: "SLEAP", version: APP_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: registry.list().map((t) => ({
      name: t.name,
      title: t.annotations.title,
      description: t.description,
      inputSchema: t.inputSchema as unknown as McpTool["inputSchema"],
      annotations: t.annotations,
    })),
  }));
  server.setRequestHandler(
    CallToolRequestSchema,
    async (req): Promise<CallToolResult> => ({ ...(await registry.callSafe(req.params.name, req.params.arguments ?? {})) }),
  );
  return server;
}

/** One request from the desktop bridge: its id, the HTTP body, and the client's session. */
export interface BridgeRequest {
  id: number;
  body: string;
  /** The client's `Mcp-Session-Id` header, if any. */
  session?: string | null;
}

/** How the transport talks to the desktop app (injected so tests can fake it). */
export interface WebviewBridge {
  /** Subscribe to `mcp:request` events; returns an unsubscribe. */
  listen(onRequest: (req: BridgeRequest) => void): Promise<() => void>;
  /**
   * Reply to request `id`; an empty body means "no response" (a
   * notification). `session` is a new session id to hand the client.
   */
  respond(id: number, body: string, session?: string): Promise<void>;
}

type WithId = { id?: string | number | null };
type Incoming = JSONRPCMessage & WithId & { method?: string; params?: Record<string, unknown> };

const newSessionId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/**
 * An MCP transport over the desktop bridge. Each HTTP POST carries one
 * JSON-RPC message; its reply goes back on the same request.
 *
 * Several Claude sessions can be connected at once and reuse the same
 * JSON-RPC ids, so each `initialize` gets an `Mcp-Session-Id`, ids are
 * rewritten to unique ones going in and restored going out, and a
 * `notifications/cancelled` only reaches a request from the same session.
 */
export class WebviewTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private unlisten: (() => void) | null = null;
  private seq = 0;
  /** Our id → the bridge request it came in on, the client's id, its session. */
  private inflight = new Map<number, { bridgeId: number; clientId: string | number; session: string; newSession?: string }>();
  /** `${session}\u0000${clientId}` → our id, for cancellations. */
  private byClient = new Map<string, number>();

  constructor(private bridge: WebviewBridge) {}

  async start(): Promise<void> {
    this.unlisten = await this.bridge.listen((req) => this.receive(req));
  }

  private receive({ id: bridgeId, body, session: sent }: BridgeRequest) {
    let msg: Incoming;
    try {
      msg = JSON.parse(body);
    } catch {
      void this.bridge.respond(
        bridgeId,
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }),
      );
      return;
    }
    if (Array.isArray(msg)) {
      void this.bridge.respond(
        bridgeId,
        JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batches aren't supported" } }),
      );
      return;
    }
    let session = sent ?? "";
    if (msg.method !== undefined && msg.id !== undefined && msg.id !== null) {
      // A request: give it our own id, answer on this bridge request.
      let newSession: string | undefined;
      if (msg.method === "initialize" && !sent) session = newSession = newSessionId();
      const ours = ++this.seq;
      this.inflight.set(ours, { bridgeId, clientId: msg.id, session, newSession });
      this.byClient.set(`${session}\u0000${msg.id}`, ours);
      this.onmessage?.({ ...msg, id: ours } as JSONRPCMessage);
      return;
    }
    // A notification (or a stray response): nothing to answer.
    void this.bridge.respond(bridgeId, "");
    if (msg.method === "notifications/cancelled") {
      // Only this session's own request, under our id; otherwise drop it.
      const ours = this.byClient.get(`${session}\u0000${String(msg.params?.requestId)}`);
      if (ours === undefined) return;
      this.onmessage?.({ ...msg, params: { ...msg.params, requestId: ours } } as JSONRPCMessage);
      return;
    }
    if (msg.id !== undefined) return; // a response from the client: we never asked anything
    this.onmessage?.(msg);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const id = (message as WithId).id;
    const pending = typeof id === "number" ? this.inflight.get(id) : undefined;
    if (!pending) return; // server-initiated messages have no HTTP request to ride on
    this.inflight.delete(id as number);
    this.byClient.delete(`${pending.session}\u0000${pending.clientId}`);
    await this.bridge.respond(
      pending.bridgeId,
      JSON.stringify({ ...message, id: pending.clientId }),
      pending.newSession,
    );
  }

  async close(): Promise<void> {
    this.unlisten?.();
    this.unlisten = null;
    this.inflight.clear();
    this.byClient.clear();
    this.onclose?.();
  }
}

/** The real bridge: Tauri events in, the sleap plugin's `mcp_response` out. */
export async function tauriBridge(): Promise<WebviewBridge> {
  const [{ getCurrentWebviewWindow }, { invoke }] = await Promise.all([
    import("@tauri-apps/api/webviewWindow"),
    import("@tauri-apps/api/core"),
  ]);
  return {
    // This window's events only: the endpoint sends each request to one window.
    listen: (onRequest) =>
      getCurrentWebviewWindow().listen<BridgeRequest>("mcp:request", (e) => onRequest(e.payload)),
    respond: (id, body, session) => invoke(sleapCmd("mcp_response"), { id, body, session: session ?? null }),
  };
}

let running: { server: Server; transport: WebviewTransport } | null = null;

/** Start answering MCP requests in this window (idempotent). */
export async function startMcpInWindow(): Promise<void> {
  if (running) return;
  const transport = new WebviewTransport(await tauriBridge());
  const server = createMcpServer();
  await server.connect(transport);
  running = { server, transport };
}

export async function stopMcpInWindow(): Promise<void> {
  const r = running;
  running = null;
  await r?.server.close();
}
