// Why: Claude may only reach SLEAP while the user has the setting on, through one window, on the port Claude Code knows.
import { describe, it, expect, beforeEach, afterEach } from "../../bun-test";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import {
  useClaudeConnectorStore,
  setConnectorBackend,
  ownsConnector,
  type McpStatus,
} from "@/stores/claudeConnectorStore";
import { ClaudeConnectorSection } from "@/components/panels/ClaudeConnectorSection";

const running = (owner: string, port = 50123, alive = true): McpStatus => ({
  running: true,
  info: { port, url: `http://127.0.0.1:${port}/mcp` },
  owner,
  owner_alive: alive,
  error: null,
  connect_command: `claude mcp add-json --scope user sleap '{"type":"http","url":"http://127.0.0.1:${port}/mcp","headersHelper":"cat '/h/.sleap-app/mcp-headers.json'"}'`,
});
const OFF: McpStatus = { running: false, info: null, owner: null, owner_alive: false, error: null, connect_command: null };

/** A fake desktop endpoint for one window. */
function fakeBackend(label: string, opts: { portTaken?: boolean } = {}) {
  const calls: string[] = [];
  let status: McpStatus = OFF;
  setConnectorBackend({
    start: async ({ newPort }) => {
      calls.push(newPort ? "start:new" : "start");
      if (opts.portTaken && !newPort) throw new Error("PORT_IN_USE: Port 50123 is in use by another program.");
      status = running(label, newPort ? 50999 : 50123);
      return status;
    },
    stop: async () => {
      calls.push("stop");
      status = OFF;
    },
    status: async () => status,
    windowLabel: async () => label,
  });
  return { calls, setStatus: (s: McpStatus) => (status = s) };
}

beforeEach(() => {
  useClaudeConnectorStore.setState({
    enabled: false,
    status: null,
    windowLabel: null,
    busy: false,
    error: null,
    portInUse: false,
    portChanged: false,
  });
});
afterEach(cleanup);

describe("Claude connector setting", () => {
  // Why: it must be off until the user turns it on.
  it("is off by default", () => {
    expect(useClaudeConnectorStore.getInitialState().enabled).toBe(false);
  });

  // Why: on starts the endpoint owned by this window; off stops it.
  it("starts and stops the endpoint", async () => {
    const b = fakeBackend("main");
    await useClaudeConnectorStore.getState().setEnabled(true);
    expect(b.calls).toEqual(["start"]);
    expect(ownsConnector(useClaudeConnectorStore.getState())).toBe(true);
    await useClaudeConnectorStore.getState().setEnabled(false);
    expect(b.calls).toEqual(["start", "stop"]);
    expect(useClaudeConnectorStore.getState()).toMatchObject({ enabled: false, status: null });
  });

  // Why: a taken port must fail visibly; moving silently would break the command Claude Code saved.
  it("shows a taken port and only moves when the user asks", async () => {
    const b = fakeBackend("main", { portTaken: true });
    await useClaudeConnectorStore.getState().setEnabled(true);
    expect(useClaudeConnectorStore.getState()).toMatchObject({ portInUse: true, status: null });
    expect(useClaudeConnectorStore.getState().error).toContain("Port 50123 is in use");
    await useClaudeConnectorStore.getState().setEnabled(true, { newPort: true });
    expect(b.calls).toEqual(["start", "start:new"]);
    expect(useClaudeConnectorStore.getState()).toMatchObject({ portInUse: false, portChanged: true });
    expect(useClaudeConnectorStore.getState().status?.info?.port).toBe(50999);
  });

  // Why: at launch only the first window turns it back on; later windows must not take Claude over.
  it("resumes only in the launch window", async () => {
    let b = fakeBackend("main-1700000000");
    useClaudeConnectorStore.setState({ enabled: true });
    await useClaudeConnectorStore.getState().resume();
    expect(b.calls).toEqual([]);
    useClaudeConnectorStore.setState({ windowLabel: null });
    b = fakeBackend("main");
    await useClaudeConnectorStore.getState().resume();
    expect(b.calls).toEqual(["start"]);
  });

  // Why: a second window shows that Claude is connected elsewhere, and only takes over when the user asks.
  it("a second window shows the owner and takes over on request", async () => {
    const b = fakeBackend("main-2");
    b.setStatus(running("main", 50123, false));
    useClaudeConnectorStore.setState({ enabled: true });
    render(<ClaudeConnectorSection />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByTestId("claude-connector-elsewhere").textContent).toContain("was closed");
    expect(screen.queryByTestId("claude-mcp-command")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Connect Claude to this window" }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(b.calls).toEqual(["start"]);
    expect(screen.getByTestId("claude-mcp-command").textContent).toContain("headersHelper");
  });

  // Why: the panel shows the connect command (with the headersHelper, no token) only while this window owns it.
  it("the panel toggles and shows the command", async () => {
    fakeBackend("main");
    render(<ClaudeConnectorSection />);
    expect(screen.queryByTestId("claude-mcp-command")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Allow Claude to control SLEAP" }));
      await new Promise((r) => setTimeout(r, 0));
    });
    const cmd = screen.getByTestId("claude-mcp-command").textContent!;
    expect(cmd).toContain("claude mcp add-json --scope user sleap");
    expect(cmd).not.toContain("Bearer");
  });
});
