/**
 * PairWorkerForm in the desktop app, where iroh is available
 * (`irohTransportAvailable()` is `isTauri`): a code with a relay pairs over
 * iroh with no choice to make. Split from pairWorkerForm.test.tsx because
 * the `@/platform/index` mock must be registered before `PairWorkerForm` is
 * imported, and bun's `mock.module` isn't hoisted — so the component is
 * imported dynamically, after the mock.
 */
import { describe, it, expect, afterEach, vi } from "../bun-test";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { buildPairCode, fakeBytes } from "./buildPairCode";
import type { ConnectOptions } from "@/stores/connectStore";

afterEach(cleanup);

vi.mock("@/platform/index", () => ({ isTauri: true }));

const calls: Array<[string, string | undefined, ConnectOptions | undefined]> = [];

async function renderForm() {
  const { useConnectStore } = await import("@/stores/connectStore");
  calls.length = 0;
  useConnectStore.setState({
    pairWithTicket: async (t: string, a?: string, o?: ConnectOptions) => {
      calls.push([t, a, o]);
    },
  });
  const { PairWorkerForm } = await import("@/components/connect/PairWorkerForm");
  render(<PairWorkerForm showCancel={false} />);
}

const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

describe("PairWorkerForm (desktop)", () => {
  it("pairs a code with a relay over iroh, with nothing to choose", async () => {
    const code = await buildPairCode({
      nodeId: fakeBytes(32),
      secret: fakeBytes(16, 101),
      expiresAt: inAnHour(),
      relay: { index: 1 },
    });
    await renderForm();

    fireEvent.change(screen.getByPlaceholderText("sleap1…"), { target: { value: code } });
    await waitFor(() =>
      expect(screen.getByText(/Connects directly when it can, through a relay when it can't/)).toBeInTheDocument(),
    );
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Worker address/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Pair$/ }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual([code, undefined, { transport: "iroh" }]);
  });

  it("uses a typed address over the relay when the user gives one", async () => {
    const code = await buildPairCode({
      nodeId: fakeBytes(32),
      secret: fakeBytes(16, 101),
      expiresAt: inAnHour(),
      relay: { index: 1 },
    });
    await renderForm();

    fireEvent.change(screen.getByPlaceholderText("sleap1…"), { target: { value: code } });
    fireEvent.click(screen.getByRole("button", { name: /Advanced: connect by address/ }));
    fireEvent.change(screen.getByLabelText(/Worker address/), {
      target: { value: "ws://100.88.12.7:9631" },
    });
    await waitFor(() => expect(screen.getByText(/Connects to ws:\/\/100\.88\.12\.7:9631/)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /^Pair$/ }));

    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toEqual([code, "ws://100.88.12.7:9631", { transport: "ws" }]);
  });

  it("explains a code with no relay or address (worker wasn't running)", async () => {
    const code = await buildPairCode({
      nodeId: fakeBytes(32),
      secret: fakeBytes(16, 101),
      expiresAt: inAnHour(),
    });
    await renderForm();

    fireEvent.change(screen.getByPlaceholderText("sleap1…"), { target: { value: code } });

    await waitFor(() =>
      expect(screen.getByText(/Make sure it's running \(sleap-connect serve\)/)).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /^Pair$/ })).toBeDisabled();
  });
});
