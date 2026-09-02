/**
 * A failed or in-flight update check must never masquerade as a healthy
 * one, and must never lock the Channel control.
 *
 * Regression guard for two defects that compounded into a silent dead UI:
 *
 *  1. The Channel dropdown was `disabled={checking || ...}`. A check that
 *     never settled -- a hung request, or a panic in the `check_update`
 *     command, which leaves the invoke promise permanently unresolved --
 *     greyed the dropdown out forever. Nothing rendered `checking`, so
 *     there was no spinner or error to explain it.
 *  2. A check that FAILED left pendingUpdate null, which the render path
 *     could not tell apart from "nothing newer" -- so the panel reported a
 *     green "up to date" on the strength of a check that had thrown.
 */

import { describe, it, expect, vi, beforeEach } from "../bun-test";
import { render, screen, waitFor, act } from "@testing-library/react";

// EnvironmentPanel's `isLocalBuild` is `import.meta.env.DEV`, read once at
// module init; bun maps that to process.env, and tests/bun-test.ts sets
// DEV=true to mirror vitest. Left alone, every control here would be
// disabled as an unpackaged `tauri:dev` run and the assertions below would
// pass vacuously. Clear it BEFORE the dynamic import of the panel so it
// behaves like the packaged app these bugs were reported against.
process.env.DEV = "";

const DEV_BUILD = "1.5.0+7.abc1234";

// A check we control: `settle` resolves/rejects it from inside the test, so
// the "never settles" state is reproducible rather than timing-dependent.
let settle: {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
} | null = null;

vi.mock("@/platform/index", () => ({ isTauri: true }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => DEV_BUILD }));
vi.mock("@/lib/updateCheckCache", () => ({
  checkUpdateCached: () =>
    new Promise((resolve, reject) => {
      settle = { resolve, reject };
    }),
}));

async function renderPanel() {
  const { AppUpdateSection } = await import(
    "@/components/panels/EnvironmentPanel"
  );
  const view = render(<AppUpdateSection />);
  await waitFor(() => expect(settle).not.toBeNull());
  return view;
}

function channelTrigger() {
  return screen.getByRole("combobox");
}

describe("EnvironmentPanel update-check failure states", () => {
  beforeEach(async () => {
    settle = null;
    const { useAppStore } = await import("@/stores/appStore");
    act(() => {
      useAppStore.setState((s) => {
        s.updateChannel = "dev";
        s.updateChannelExplicitlySet = true;
      });
    });
  });

  it("leaves the channel control usable while a check is still in flight", async () => {
    const { baseElement } = await renderPanel();

    // Still pending -- exactly the state that used to lock the control.
    expect(channelTrigger()).not.toBeDisabled();
    expect(baseElement.textContent).toContain("Checking...");
  });

  it("reports a failed check instead of claiming 'up to date'", async () => {
    const { baseElement } = await renderPanel();

    await act(async () => {
      settle!.reject(new Error("no full release has a latest.json manifest yet"));
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.getByText("Update check failed")).toBeInTheDocument(),
    );
    expect(baseElement.textContent).not.toContain("up to date");
    // The actionable detail is preserved for the user, in the tooltip.
    expect(screen.getByText("Update check failed")).toHaveAttribute(
      "title",
      "no full release has a latest.json manifest yet",
    );
    expect(screen.getByText("Retry")).toBeInTheDocument();
    expect(channelTrigger()).not.toBeDisabled();
  });

  it("still reports 'up to date' when a check genuinely succeeds", async () => {
    const { baseElement } = await renderPanel();

    await act(async () => {
      settle!.resolve(null); // no update on this channel
      await Promise.resolve();
    });

    await waitFor(() => expect(baseElement.textContent).toContain("up to date"));
    expect(screen.queryByText("Update check failed")).not.toBeInTheDocument();
    expect(baseElement.textContent).not.toContain("Checking...");
  });
});
