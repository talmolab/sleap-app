/**
 * A local (`tauri:dev`, unpackaged) build must not present a failed update
 * check as a failure.
 *
 * Nothing the checker reports is actionable there -- there is no installer for
 * download_and_install() to swap, which is why the "→ vX" arrow is already
 * hidden and the Update button already disabled for local builds. The error row
 * was the one place that still shone amber "Check failed" with a Retry, right
 * next to the panel's own "local build" badge, so an unpackaged run looked
 * broken instead of looking unpackageable.
 *
 * This is easy to hit today rather than hypothetical: `updateChannel` defaults
 * to "stable", and on the stable channel the Rust resolver legitimately errors
 * with "no full release has a latest.json manifest yet" because only the
 * pre-releases carry that asset so far.
 *
 * `isLocalBuild` is `import.meta.env.DEV`, which `bun test` populates (with the
 * string "true"), so AppUpdateSection already renders in local-build mode here
 * -- the packaged-build branch cannot be exercised from a unit test because
 * that value is a module-level const substituted at build time.
 */

import { describe, it, expect, vi, beforeEach } from "../bun-test";
import { render, screen, waitFor, act } from "@testing-library/react";

const LOCAL_VERSION = "0.1.2-2";
const CHECK_ERROR =
  "no full release has a latest.json manifest yet (only pre-releases do)";

vi.mock("@/platform/index", () => ({ isTauri: true }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => LOCAL_VERSION }));
vi.mock("@/lib/updateCheckCache", () => ({
  checkUpdateCached: async () => {
    throw new Error(CHECK_ERROR);
  },
}));

describe("AppUpdateSection on a local build with a failing update check", () => {
  beforeEach(async () => {
    const { useAppStore } = await import("@/stores/appStore");
    act(() => {
      useAppStore.setState((s) => {
        // The default channel, and the one whose resolver errors today.
        s.updateChannel = "stable";
        s.updateChannelExplicitlySet = true;
      });
    });
  });

  it("reports the update row as not applicable, not as a failure", async () => {
    const { AppUpdateSection } = await import(
      "@/components/panels/EnvironmentPanel"
    );

    const { baseElement } = render(<AppUpdateSection />);
    await waitFor(() =>
      expect(baseElement.textContent).toContain("not applicable"),
    );

    expect(baseElement.textContent).not.toContain("Check failed");
    // Retrying cannot produce anything installable here, so it is not offered.
    expect(screen.queryByText("Retry")).not.toBeInTheDocument();
  });

  it("keeps the underlying reason available in the tooltip", async () => {
    const { AppUpdateSection } = await import(
      "@/components/panels/EnvironmentPanel"
    );

    render(<AppUpdateSection />);
    const row = await waitFor(() => screen.getByText("not applicable"));

    // Muted rather than amber: it is a statement about the shell, not an alert.
    expect(row.className).toContain("text-muted-foreground");
    expect(row.className).not.toContain("text-amber");
    // Still debuggable -- whoever is working on the checker needs the message.
    expect(row.getAttribute("title")).toContain(CHECK_ERROR);
    expect(row.getAttribute("title")).toContain("tauri:dev");
  });

  it("still shows the build it is running and the local-build badge", async () => {
    const { AppUpdateSection } = await import(
      "@/components/panels/EnvironmentPanel"
    );

    const { baseElement } = render(<AppUpdateSection />);
    await waitFor(() =>
      expect(baseElement.textContent).toContain(`v${LOCAL_VERSION}`),
    );
    // The failed check must not take the rest of the section down with it.
    expect(screen.getByText("local build")).toBeInTheDocument();
  });
});
