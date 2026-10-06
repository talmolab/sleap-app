/**
 * PR4b §4b.1 — PairWorkerForm, extracted from ConnectPanel's inline pairing
 * form. Covers the extraction's own contract (submits ticket/address, calls
 * onPaired/onCancel, Cancel only shown per `showCancel`) — ConnectPanel's
 * existing behavior around it is unchanged and isn't retested here.
 */
import { describe, it, expect, afterEach, vi } from "../bun-test";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useConnectStore, type ConnectOptions } from "@/stores/connectStore";
import { PairWorkerForm } from "@/components/connect/PairWorkerForm";

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

    fireEvent.change(screen.getByPlaceholderText(/node_id/), {
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

    fireEvent.change(screen.getByPlaceholderText(/node_id/), {
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
});
