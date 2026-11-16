// Why: Claude may only reach SLEAP while the user has the setting on, and turning it off must stop the endpoint.
import { describe, it, expect, beforeEach, afterEach, vi } from "../../bun-test";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import {
  useClaudeConnectorStore,
  setConnectorBackend,
  claudeMcpAddCommand,
  type McpInfo,
} from "@/stores/claudeConnectorStore";
import { ClaudeConnectorSection } from "@/components/panels/ClaudeConnectorSection";

const INFO: McpInfo = { port: 50123, token: "abc123", url: "http://127.0.0.1:50123/mcp" };
const start = vi.fn(async () => INFO);
const stop = vi.fn(async () => {});

beforeEach(() => {
  start.mockClear();
  stop.mockClear();
  setConnectorBackend({ start, stop });
  useClaudeConnectorStore.setState({ enabled: false, info: null, busy: false, error: null });
});
afterEach(cleanup);

describe("Claude connector setting", () => {
  // Why: it must be off until the user turns it on.
  it("is off by default", () => {
    expect(useClaudeConnectorStore.getInitialState().enabled).toBe(false);
  });

  // Why: on starts the endpoint and shows the connect command; off stops it.
  it("starts and stops the endpoint", async () => {
    await useClaudeConnectorStore.getState().setEnabled(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(useClaudeConnectorStore.getState()).toMatchObject({ enabled: true, info: INFO });
    await useClaudeConnectorStore.getState().setEnabled(false);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(useClaudeConnectorStore.getState()).toMatchObject({ enabled: false, info: null });
  });

  // Why: if the endpoint can't start, the setting must not claim it's on.
  it("stays off and shows the error when starting fails", async () => {
    start.mockImplementationOnce(async () => {
      throw new Error("port busy");
    });
    await useClaudeConnectorStore.getState().setEnabled(true);
    expect(useClaudeConnectorStore.getState()).toMatchObject({ enabled: false, error: "port busy" });
  });

  // Why: a user who left it on gets it back at the next launch, without clicking again.
  it("resumes at startup only when left on", async () => {
    await useClaudeConnectorStore.getState().resume();
    expect(start).not.toHaveBeenCalled();
    useClaudeConnectorStore.setState({ enabled: true, info: null });
    await useClaudeConnectorStore.getState().resume();
    expect(start).toHaveBeenCalledTimes(1);
    expect(useClaudeConnectorStore.getState().info).toEqual(INFO);
  });

  // Why: the command is what the user pastes into a terminal; it must carry the URL and token.
  it("builds the claude mcp add command", () => {
    expect(claudeMcpAddCommand(INFO)).toBe(
      'claude mcp add --scope user --transport http sleap http://127.0.0.1:50123/mcp --header "Authorization: Bearer abc123"',
    );
  });

  // Why: the panel shows the command only while the connector is on.
  it("the panel toggles and shows the command", async () => {
    render(<ClaudeConnectorSection />);
    expect(screen.queryByTestId("claude-mcp-command")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: "Allow Claude to control SLEAP" }));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(screen.getByTestId("claude-mcp-command").textContent).toContain("Bearer abc123");
  });
});
