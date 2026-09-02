/**
 * The sleap-app row's version label must describe the build that is actually
 * RUNNING, not the channel selected in the dropdown below it.
 *
 * Regression guard: the row used to render `v{version} · {channelShortLabel}`,
 * where channelShortLabel came straight from `updateChannel`. Picking
 * "Stable" while running a `dev` build therefore relabelled the running
 * version "Stable" the instant the dropdown changed -- before any update was
 * checked for, let alone downloaded and installed. Only the version-derived
 * badge (@/lib/version's classifyVersion) may name the build.
 */

import { describe, it, expect, vi, beforeEach } from "../bun-test";
import { render, screen, waitFor, act } from "@testing-library/react";

const DEV_BUILD = "1.5.0+42.abc1234";

vi.mock("@/platform/index", () => ({ isTauri: true }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => DEV_BUILD }));
// No newer build on any channel: keeps the row to version + badge, so the
// assertions below can't be satisfied by "→ vX" text instead.
vi.mock("@/lib/updateCheckCache", () => ({ checkUpdateCached: async () => null }));

describe("EnvironmentPanel sleap-app version label", () => {
  beforeEach(async () => {
    const { useAppStore } = await import("@/stores/appStore");
    act(() => {
      useAppStore.setState((s) => {
        s.updateChannel = "dev";
        s.updateChannelExplicitlySet = true;
      });
    });
  });

  it("keeps naming the running build when the channel dropdown changes", async () => {
    const { AppUpdateSection } = await import(
      "@/components/panels/EnvironmentPanel"
    );
    const { useAppStore } = await import("@/stores/appStore");

    const { baseElement } = render(<AppUpdateSection />);
    await waitFor(() =>
      expect(baseElement.textContent).toContain(`v${DEV_BUILD}`),
    );
    expect(screen.getByText("Dev build")).toBeInTheDocument();

    // Select "Stable" -- a preference only; nothing has been installed yet.
    act(() => {
      useAppStore.getState().setUpdateChannel("stable");
    });

    await waitFor(() =>
      expect(useAppStore.getState().updateChannel).toBe("stable"),
    );
    // Still the dev build that's running, still labelled as such.
    expect(baseElement.textContent).toContain(`v${DEV_BUILD}`);
    expect(screen.getByText("Dev build")).toBeInTheDocument();
    expect(baseElement.textContent).not.toContain("Stable release");
    // ...and the version is no longer followed by a bare channel echo.
    expect(baseElement.textContent).not.toContain(`v${DEV_BUILD} ·`);
  });
});
