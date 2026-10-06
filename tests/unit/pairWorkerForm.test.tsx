/**
 * PR4b §4b.1 — PairWorkerForm, extracted from ConnectPanel's inline pairing
 * form. Covers the extraction's own contract (submits ticket/address, calls
 * onPaired/onCancel, Cancel only shown per `showCancel`) — ConnectPanel's
 * existing behavior around it is unchanged and isn't retested here.
 *
 * PR6a §a.2 widened the pasted "ticket" to also accept `sleap-rtc pair`'s
 * one-line pairing code (now the primary, single-line `Input`), while still
 * accepting the legacy JSON ticket — both paths are covered below, including
 * the iroh checkbox's visibility (`ticketHasIroh`, true only when a relay is
 * present either way).
 */
import { describe, it, expect, afterEach, vi } from "../bun-test";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useConnectStore, type ConnectOptions } from "@/stores/connectStore";
import { PairWorkerForm } from "@/components/connect/PairWorkerForm";
import { buildPairCode, fakeBytes } from "./buildPairCode";

afterEach(cleanup);

/**
 * `useConnectStore`'s own `vi.fn()` shim can't satisfy `pairWithTicket`'s
 * strictly-typed required `ticketJson: string` param (same limitation noted
 * in hiddenVideosDialog.test.tsx's `trackedTrain`) — track calls by hand
 * instead, with the exact store signature.
 */
function trackedPairWithTicket(shouldThrow?: Error) {
  const calls: Array<[string, string | undefined, ConnectOptions | undefined]> = [];
  const fn = async (ticketJson: string, addrOverride?: string, options?: ConnectOptions) => {
    calls.push([ticketJson, addrOverride, options]);
    if (shouldThrow) throw shouldThrow;
  };
  return { fn, calls };
}

describe("PairWorkerForm", () => {
  it("submits the pasted ticket and address, then calls onPaired", async () => {
    const { fn: pairWithTicket, calls } = trackedPairWithTicket();
    useConnectStore.setState({ pairWithTicket });
    const onPaired = vi.fn();
    render(<PairWorkerForm onPaired={onPaired} showCancel={false} />);

    fireEvent.change(screen.getByPlaceholderText("sleap1…"), {
      target: { value: '{"node_id":"n1","secret":"s"}' },
    });
    fireEvent.change(screen.getByPlaceholderText(/ws:\/\/192\.168\.1\.42:9631/), {
      target: { value: "ws://10.0.0.1:9631" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Pair$/ }));

    await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1));
    expect(calls).toEqual([['{"node_id":"n1","secret":"s"}', "ws://10.0.0.1:9631", undefined]]);
  });

  it("shows the pairing error instead of calling onPaired on failure", async () => {
    const { fn: pairWithTicket } = trackedPairWithTicket(new Error("bad ticket"));
    useConnectStore.setState({ pairWithTicket });
    const onPaired = vi.fn();
    render(<PairWorkerForm onPaired={onPaired} showCancel={false} />);

    fireEvent.change(screen.getByPlaceholderText("sleap1…"), {
      target: { value: '{"node_id":"n1","secret":"s"}' },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Pair$/ }));

    await waitFor(() => expect(screen.getByText("bad ticket")).toBeInTheDocument());
    expect(onPaired).not.toHaveBeenCalled();
  });

  it("disables Pair until a ticket is pasted", () => {
    render(<PairWorkerForm showCancel={false} />);
    expect(screen.getByRole("button", { name: /^Pair$/ })).toBeDisabled();
  });

  it("hides Cancel when showCancel is false", () => {
    render(<PairWorkerForm showCancel={false} />);
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
  });

  it("shows Cancel and calls onCancel when showCancel is true", () => {
    const onCancel = vi.fn();
    render(<PairWorkerForm showCancel onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("shows the single-line pairing-code input with its help text", () => {
    render(<PairWorkerForm showCancel={false} />);
    expect(screen.getByPlaceholderText("sleap1…").tagName).toBe("INPUT");
    // The help text's plain-text segments live in their own text nodes
    // around the inline `sleap-rtc pair` <code>, so they're asserted
    // separately rather than as one spanning string (RTL's getByText only
    // matches a node's own direct text-node children, not nested elements).
    expect(screen.getByText("sleap-rtc pair")).toBeInTheDocument();
    expect(screen.getByText(/paste the code below/)).toBeInTheDocument();
  });

  it("submits a pasted one-line pairing code as-is", async () => {
    const { fn: pairWithTicket, calls } = trackedPairWithTicket();
    useConnectStore.setState({ pairWithTicket });
    const code = await buildPairCode({
      nodeId: fakeBytes(32),
      secret: fakeBytes(16, 101),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    render(<PairWorkerForm showCancel={false} />);

    fireEvent.change(screen.getByPlaceholderText("sleap1…"), { target: { value: code } });
    fireEvent.click(screen.getByRole("button", { name: /^Pair$/ }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]![0]).toBe(code);
  });

  // The iroh checkbox only ever shows when `irohTransportAvailable()`
  // (desktop/Tauri) — see pairWorkerFormIroh.test.tsx for its ticketHasIroh
  // coverage (needs `@/platform/index` mocked to `isTauri: true`, which a
  // separate file is the established way to do alongside a ws-default file
  // that imports the component statically, per connectStoreIroh.test.ts).
  it("never shows the iroh checkbox outside Tauri, even for a code with a relay", async () => {
    const code = await buildPairCode({
      nodeId: fakeBytes(32),
      secret: fakeBytes(16, 101),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      relay: { index: 1 },
    });
    render(<PairWorkerForm showCancel={false} />);

    fireEvent.change(screen.getByPlaceholderText("sleap1…"), { target: { value: code } });

    await waitFor(() => expect(screen.getByPlaceholderText("sleap1…")).toHaveValue(code));
    expect(screen.queryByText(/Connect directly \(iroh\)/)).not.toBeInTheDocument();
  });
});
