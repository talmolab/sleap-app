// Why: proves a real MCP client sees our tools and can call them, over the same transport the desktop bridge uses.
import { describe, it, expect, beforeEach } from "../../bun-test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { useQcStore } from "@/stores/qcStore";
import { useProposalStore } from "@/stores/proposalStore";
import { setQcReviewedBackend, memoryBackend } from "@/lib/qcReviewed";
import { createMcpServer, WebviewTransport, SERVER_INSTRUCTIONS, type WebviewBridge } from "@/automation/mcpServer";
import { TOOLS } from "@/automation/tools";
import { loadFixtureWithOneInstance, anomalyAt } from "../helpers/automationFixture";

async function seedQc() {
  const project = loadFixtureWithOneInstance();
  await Promise.resolve(); // loadDismissed
  useQcStore.setState({
    labels: project.labels,
    state: "done",
    findings: [],
    anomaly: { instances: [anomalyAt(20, 1, 0.9)], featureNames: [], gmmThreshold: 0.95 },
    threshold: 0.7,
    rescored: new Map(),
  });
}

const text = (r: unknown) => (r as { content: { type: string; text: string }[] }).content[0].text;

beforeEach(async () => {
  setQcReviewedBackend(memoryBackend());
  useQcStore.getState().reset();
  useProposalStore.getState().clear();
  await seedQc();
});

describe("MCP server", () => {
  // Why: this is what Claude Code does on connect: initialize, read instructions, list tools, call one.
  it("lists the tools and calls one through a real MCP client", async () => {
    const server = createMcpServer();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: "test", version: "0" });
    await client.connect(b);
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(tools.find((t) => t.name === "propose_fix")?.annotations?.readOnlyHint).toBe(false);
    const res = await client.callTool({ name: "list_qc_flags", arguments: {} });
    expect(JSON.parse(text(res)).flags[0].id).toBe("v0:f20:i1:anomaly");
    // Bad input comes back as a tool error Claude can read, not a protocol failure.
    const bad = await client.callTool({ name: "render_flag", arguments: {} });
    expect(bad.isError).toBe(true);
    expect(text(bad)).toContain("BAD_INPUT");
    await client.close();
  });

  // Why: the instructions must fit the 4,096-character limit some clients enforce.
  it("keeps the instructions short enough", () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(4096);
  });
});

/** A fake desktop bridge: deliver HTTP bodies, collect replies. */
function fakeBridge() {
  let handler: ((r: { id: number; body: string }) => void) | null = null;
  const replies = new Map<number, string>();
  const waiters = new Map<number, (body: string) => void>();
  const bridge: WebviewBridge = {
    listen: async (fn) => {
      handler = fn;
      return () => (handler = null);
    },
    respond: async (id, body) => {
      replies.set(id, body);
      waiters.get(id)?.(body);
    },
  };
  let bridgeId = 0;
  /** POST one JSON-RPC body; resolves with the reply body. */
  const post = (msg: unknown) =>
    new Promise<string>((resolve) => {
      const id = ++bridgeId;
      waiters.set(id, resolve);
      handler!({ id, body: typeof msg === "string" ? msg : JSON.stringify(msg) });
    });
  return { bridge, post, replies };
}

describe("WebviewTransport", () => {
  // Why: two Claude sessions can both send id 1; each must get its own answer back with its own id.
  it("answers each request on its own HTTP request, with the client's id", async () => {
    const fb = fakeBridge();
    await createMcpServer().connect(new WebviewTransport(fb.bridge));
    const init = (id: number) => ({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "c", version: "0" } },
    });
    const r1 = JSON.parse(await fb.post(init(1)));
    expect(r1.id).toBe(1);
    expect(r1.result.serverInfo.name).toBe("sleap");
    // A notification gets an empty reply (the bridge answers 202).
    expect(await fb.post({ jsonrpc: "2.0", method: "notifications/initialized" })).toBe("");
    const [a, b] = await Promise.all([
      fb.post({ jsonrpc: "2.0", id: 7, method: "tools/list" }),
      fb.post({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "get_session", arguments: {} } }),
    ]);
    expect(JSON.parse(a)).toMatchObject({ id: 7, result: { tools: expect.any(Array) } });
    expect(JSON.parse(b)).toMatchObject({ id: 7, result: { content: expect.any(Array) } });
  });

  // Why: garbage in must get a JSON-RPC error out, not a hung request.
  it("rejects bodies that aren't one JSON-RPC message", async () => {
    const fb = fakeBridge();
    await createMcpServer().connect(new WebviewTransport(fb.bridge));
    expect(JSON.parse(await fb.post("{not json")).error.code).toBe(-32700);
    expect(JSON.parse(await fb.post([{ jsonrpc: "2.0", id: 1, method: "tools/list" }])).error.code).toBe(-32600);
  });
});
