/**
 * PR4b §4b.2 — ConnectPanel's new "Open Connect window" entry point. The
 * panel's pairing/connect behavior is otherwise unchanged (and untested
 * here); see pairWorkerForm.test.tsx for the pairing form it delegates to.
 */
import { describe, it, expect, afterEach, beforeAll, vi } from "../bun-test";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useConnectStore } from "@/stores/connectStore";
import { useAppStore } from "@/stores/appStore";
import { ConnectPanel } from "@/components/panels/ConnectPanel";

// ConnectPanel resolves this device's identity on mount.
vi.mock("@/lib/protocolV1/identity", () => ({
  getClientIdentity: async () => ({ nodeId: "self-node-id" }),
}));

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(() => {
  cleanup();
  useConnectStore.setState({ pairedWorkers: [], selectedWorkerId: null });
});

describe("ConnectPanel — Open Connect window", () => {
  it("opens the Connect window via the app store flag", async () => {
    render(<ConnectPanel />);
    // Let the device-identity effect settle before asserting, so React
    // doesn't warn about a later state update happening outside act().
    await waitFor(() => expect(screen.getByText(/This device:/)).toBeInTheDocument());

    expect(useAppStore.getState().connectWindowOpen).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /Open Connect window/ }));
    expect(useAppStore.getState().connectWindowOpen).toBe(true);
    useAppStore.getState().setConnectWindowOpen(false);
  });
});
