/**
 * ConnectPanel tests:
 * - "Open Connect window" entry point (PR4b §4b.2).
 * - Quick-start `uvx` worker launch command with copy-to-clipboard feedback.
 * - Channel-aware link to the Remote Compute docs page via `openExternal`.
 */
import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from "../bun-test";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useConnectStore } from "@/stores/connectStore";
import { useAppStore } from "@/stores/appStore";
import { getDocsUrl } from "@/lib/docsUrl";

const openExternal = vi.fn(async () => {});

// ConnectPanel resolves this device's identity on mount and opens docs via openExternal.
vi.mock("@/lib/protocolV1/identity", () => ({
  getClientIdentity: async () => ({ nodeId: "self-node-id" }),
}));
vi.mock("@/lib/openExternal", () => ({ openExternal }));

let clipboardText: string | null = null;
const writeText = vi.fn(async (text: string) => {
  clipboardText = text;
});

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
});

beforeEach(() => {
  clipboardText = null;
  writeText.mockClear();
  openExternal.mockClear();
});

afterEach(() => {
  cleanup();
  useConnectStore.setState({ pairedWorkers: [], selectedWorkerId: null });
});

describe("ConnectPanel", () => {
  it("opens the Connect window via the app store flag", async () => {
    const { ConnectPanel } = await import("@/components/panels/ConnectPanel");
    render(<ConnectPanel />);
    // Let the device-identity effect settle before asserting, so React
    // doesn't warn about a later state update happening outside act().
    await waitFor(() => expect(screen.getByText(/This device:/)).toBeInTheDocument());

    expect(useAppStore.getState().connectWindowOpen).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Open Connect window/ }));
    expect(useAppStore.getState().connectWindowOpen).toBe(true);
    useAppStore.getState().setConnectWindowOpen(false);
  });

  it("shows a copyable uvx worker command and gives copied feedback", async () => {
    const { ConnectPanel } = await import("@/components/panels/ConnectPanel");
    const { WORKER_UVX_COMMAND } = await import("@/components/connect/PairWorkerForm");
    render(<ConnectPanel />);
    await waitFor(() => expect(screen.getByText(/This device:/)).toBeInTheDocument());

    const commandEl = screen.getByTestId("worker-uvx-command");
    expect(commandEl.textContent).toBe(WORKER_UVX_COMMAND);
    expect(WORKER_UVX_COMMAND).toContain("uvx");
    expect(WORKER_UVX_COMMAND).toContain("sleap-connect[nn]");
    expect(WORKER_UVX_COMMAND).toContain("sleap-connect serve");

    const copyBtn = screen.getByRole("button", { name: "Copy worker command" });
    fireEvent.click(copyBtn);

    await waitFor(() => expect(clipboardText).toBe(WORKER_UVX_COMMAND));
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("links to the channel-aware Remote Compute docs page via openExternal", async () => {
    const { ConnectPanel } = await import("@/components/panels/ConnectPanel");
    const { remoteComputeDocsUrl } = await import("@/components/connect/PairWorkerForm");
    render(<ConnectPanel />);
    await waitFor(() => expect(screen.getByText(/This device:/)).toBeInTheDocument());

    const expectedUrl = `${getDocsUrl()}guides/remote-compute/`;
    expect(remoteComputeDocsUrl("https://app.sleap.ai/docs/stable")).toBe(
      "https://app.sleap.ai/docs/stable/guides/remote-compute/",
    );

    const docsLink = screen.getByRole("link", { name: /Docs/i });
    expect(docsLink).toHaveAttribute("href", expectedUrl);

    fireEvent.click(docsLink);
    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith(expectedUrl);
  });

  it("keeps the quick-start uvx command and docs link accessible when workers are already paired", async () => {
    useConnectStore.setState({
      pairedWorkers: [
        {
          nodeId: "node-a",
          label: "Lab GPU",
          addrs: ["ws://10.0.0.1:9631"],
          pairedAt: "2026-10-01T00:00:00Z",
        },
      ],
    });
    const { ConnectPanel } = await import("@/components/panels/ConnectPanel");
    render(<ConnectPanel />);
    await waitFor(() => expect(screen.getByText(/This device:/)).toBeInTheDocument());

    expect(screen.getByTestId("worker-quick-start")).toBeInTheDocument();
    expect(screen.getByTestId("worker-uvx-command")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Docs/i })).toBeInTheDocument();
  });
});
