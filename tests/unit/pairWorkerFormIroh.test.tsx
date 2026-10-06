/**
 * PairWorkerForm's iroh checkbox (desktop-only — `irohTransportAvailable()`
 * is `isTauri`), split from pairWorkerForm.test.tsx the same way
 * connectStoreIroh.test.ts is split from connectStore.test.ts: the
 * `@/platform/index` mock must be registered before `PairWorkerForm` (which
 * imports it transitively) is ever imported, and bun's `mock.module` isn't
 * hoisted the way vitest's `vi.mock` is — so the component has to be
 * imported dynamically, AFTER the mock, inside each test/`beforeEach`,
 * rather than once at the top of the file alongside the ws-default tests.
 */
import { describe, it, expect, afterEach, vi } from "../bun-test";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { buildPairCode, fakeBytes, mistypeCode } from "./buildPairCode";

afterEach(cleanup);

vi.mock("@/platform/index", () => ({ isTauri: true }));

async function renderForm() {
  const { PairWorkerForm } = await import("@/components/connect/PairWorkerForm");
  render(<PairWorkerForm showCancel={false} />);
}

describe("PairWorkerForm iroh checkbox (desktop)", () => {
  it("shows the iroh checkbox for a pairing code carrying a relay", async () => {
    const code = await buildPairCode({
      nodeId: fakeBytes(32),
      secret: fakeBytes(16, 101),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      relay: { index: 1 },
    });
    await renderForm();

    fireEvent.change(screen.getByPlaceholderText("sleap1…"), { target: { value: code } });

    await waitFor(() => expect(screen.getByText(/Connect directly \(iroh\)/)).toBeInTheDocument());
  });

  it("does not show the iroh checkbox for a pairing code with no relay", async () => {
    const code = await buildPairCode({
      nodeId: fakeBytes(32),
      secret: fakeBytes(16, 101),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    await renderForm();

    fireEvent.change(screen.getByPlaceholderText("sleap1…"), { target: { value: code } });

    // Give the async check (decodePairCode awaits a checksum digest) a
    // chance to run, then confirm it stayed hidden.
    await waitFor(() => expect(screen.getByPlaceholderText("sleap1…")).toHaveValue(code));
    expect(screen.queryByText(/Connect directly \(iroh\)/)).not.toBeInTheDocument();
  });

  it("does not show the iroh checkbox for a mistyped (checksum-invalid) code", async () => {
    const code = await buildPairCode({
      nodeId: fakeBytes(32),
      secret: fakeBytes(16, 101),
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      relay: { index: 1 },
    });
    const mistyped = mistypeCode(code);
    await renderForm();

    fireEvent.change(screen.getByPlaceholderText("sleap1…"), { target: { value: mistyped } });

    await waitFor(() => expect(screen.getByPlaceholderText("sleap1…")).toHaveValue(mistyped));
    expect(screen.queryByText(/Connect directly \(iroh\)/)).not.toBeInTheDocument();
  });

  it("shows the iroh checkbox for a pasted JSON ticket with a relay_url, not for one without", async () => {
    await renderForm();
    const input = screen.getByPlaceholderText("sleap1…");

    fireEvent.change(input, {
      target: {
        value: JSON.stringify({
          node_id: "n1",
          secret: "s",
          iroh: { relay_url: "https://relay.example", direct_addrs: [] },
        }),
      },
    });
    await waitFor(() => expect(screen.getByText(/Connect directly \(iroh\)/)).toBeInTheDocument());

    fireEvent.change(input, {
      target: { value: JSON.stringify({ node_id: "n1", secret: "s" }) },
    });
    await waitFor(() =>
      expect(screen.queryByText(/Connect directly \(iroh\)/)).not.toBeInTheDocument(),
    );
  });
});
