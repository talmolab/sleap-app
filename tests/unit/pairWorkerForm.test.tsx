/**
 * PairWorkerForm in the browser (no iroh): the user only pastes a code; the
 * form works out how to connect (`planPairing`) and only asks for an
 * address when the code can't be used without one, saying why. The
 * desktop (iroh) cases are in pairWorkerFormIroh.test.tsx.
 */
import { describe, it, expect, afterEach, vi } from "../bun-test";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { useConnectStore, type ConnectOptions } from "@/stores/connectStore";
import { PairWorkerForm } from "@/components/connect/PairWorkerForm";
import { buildPairCode, fakeBytes } from "./buildPairCode";

afterEach(cleanup);

/**
 * `useConnectStore`'s own `vi.fn()` shim can't satisfy `pairWithTicket`'s
 * strictly-typed required `ticketJson: string` param — track calls by hand
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

const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

function paste(text: string) {
  fireEvent.change(screen.getByPlaceholderText("sleap1…"), { target: { value: text } });
}

describe("PairWorkerForm", () => {
  it("pairs a code with a network address without asking for anything", async () => {
    const { fn: pairWithTicket, calls } = trackedPairWithTicket();
    useConnectStore.setState({ pairWithTicket });
    const onPaired = vi.fn();
    const code = await buildPairCode({
      nodeId: fakeBytes(32),
      secret: fakeBytes(16, 101),
      expiresAt: inAnHour(),
      addrs: [{ ip: [192, 168, 1, 42], port: 9631 }],
    });
    render(<PairWorkerForm onPaired={onPaired} showCancel={false} />);

    paste(code);
    await waitFor(() =>
      expect(screen.getByText(/Connects over your network \(ws:\/\/192\.168\.1\.42:9631\)/)).toBeInTheDocument(),
    );
    expect(screen.queryByLabelText(/Worker address/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Pair$/ }));

    await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1));
    expect(calls).toEqual([[code, undefined, { transport: "ws" }]]);
  });

  it("opens the address box, saying why, for a code with no way in from the browser", async () => {
    const { fn: pairWithTicket, calls } = trackedPairWithTicket();
    useConnectStore.setState({ pairWithTicket });
    const code = await buildPairCode({
      nodeId: fakeBytes(32),
      secret: fakeBytes(16, 101),
      expiresAt: inAnHour(),
      relay: { index: 1 },
    });
    render(<PairWorkerForm showCancel={false} />);

    paste(code);
    await waitFor(() =>
      expect(screen.getByText(/The web version can only reach workers on your network/)).toBeInTheDocument(),
    );
    const pair = screen.getByRole("button", { name: /^Pair$/ });
    expect(pair).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Worker address/), {
      target: { value: "ws://10.0.0.1:9631" },
    });
    await waitFor(() => expect(pair).not.toBeDisabled());
    fireEvent.click(pair);

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual([code, "ws://10.0.0.1:9631", { transport: "ws" }]);
  });

  it("explains a code with no connection info at all (worker wasn't running)", async () => {
    const code = await buildPairCode({
      nodeId: fakeBytes(32),
      secret: fakeBytes(16, 101),
      expiresAt: inAnHour(),
    });
    render(<PairWorkerForm showCancel={false} />);

    paste(code);

    await waitFor(() =>
      expect(screen.getByText(/doesn't say how to reach the worker/)).toBeInTheDocument(),
    );
    expect(screen.getByLabelText(/Worker address/)).toBeInTheDocument();
  });

  it("rejects an expired code and text that isn't a code", async () => {
    const expired = await buildPairCode({
      nodeId: fakeBytes(32),
      secret: fakeBytes(16, 101),
      expiresAt: Math.floor(Date.now() / 1000) - 600,
      addrs: [{ ip: [192, 168, 1, 42], port: 9631 }],
    });
    render(<PairWorkerForm showCancel={false} />);

    paste(expired);
    await waitFor(() => expect(screen.getByText(/This code expired 10 min ago/)).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /^Pair$/ })).toBeDisabled();

    paste("hello");
    await waitFor(() =>
      expect(screen.getByText(/doesn't look like a pairing code/)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /^Pair$/ })).toBeDisabled();
  });

  it("still takes a legacy JSON ticket", async () => {
    const { fn: pairWithTicket, calls } = trackedPairWithTicket();
    useConnectStore.setState({ pairWithTicket });
    render(<PairWorkerForm showCancel={false} />);

    paste('{"node_id":"n1","secret":"s","addrs":["ws://10.0.0.1:9631"]}');
    await waitFor(() => expect(screen.getByRole("button", { name: /^Pair$/ })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: /^Pair$/ }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]![2]).toEqual({ transport: "ws" });
  });

  it("shows the pairing error instead of calling onPaired on failure", async () => {
    const { fn: pairWithTicket } = trackedPairWithTicket(new Error("bad ticket"));
    useConnectStore.setState({ pairWithTicket });
    const onPaired = vi.fn();
    render(<PairWorkerForm onPaired={onPaired} showCancel={false} />);

    paste('{"node_id":"n1","secret":"s","addrs":["ws://10.0.0.1:9631"]}');
    await waitFor(() => expect(screen.getByRole("button", { name: /^Pair$/ })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: /^Pair$/ }));

    await waitFor(() => expect(screen.getByText("bad ticket")).toBeInTheDocument());
    expect(onPaired).not.toHaveBeenCalled();
  });

  it("keeps the address box under Advanced until it's needed", async () => {
    render(<PairWorkerForm showCancel={false} />);
    expect(screen.queryByLabelText(/Worker address/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Advanced: connect by address/ }));
    expect(screen.getByLabelText(/Worker address/)).toBeInTheDocument();
  });

  it("disables Pair until a code is pasted", () => {
    render(<PairWorkerForm showCancel={false} />);
    expect(screen.getByRole("button", { name: /^Pair$/ })).toBeDisabled();
  });

  it("shows its one line of help, and never transport names", () => {
    render(<PairWorkerForm showCancel={false} />);
    expect(screen.getByText("sleap-connect pair")).toBeInTheDocument();
    expect(screen.getByText(/paste the code it prints/)).toBeInTheDocument();
    expect(screen.queryByText(/iroh|WebSocket/i)).not.toBeInTheDocument();
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
