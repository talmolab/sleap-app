/**
 * The Environment panel's "Release notes" button for the INSTALLED build.
 *
 * Only stable and pre-release ("latest") builds are a published GitHub Release
 * with notes of their own, so only they get a live link; dev builds (one
 * rolling `dev` release) and local `tauri:dev` builds (whatever package.json
 * on main says) get the button greyed out, with the reason in its tooltip.
 *
 * `isLocalBuild` is truthy under `bun test` (see
 * environmentPanelLocalBuildUpdate.test.tsx), so the rendered panel can only
 * show the local-build branch; the stable / pre-release / dev branches are
 * covered through the pure `installedReleaseNotes` it renders from.
 */

import { describe, it, expect, vi, beforeEach } from "../bun-test";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import { releaseNotesUrlFor } from "@/lib/version";

const INSTALLED_VERSION = "0.1.2";
const openExternal = vi.fn(async () => {});

vi.mock("@/platform/index", () => ({ isTauri: true }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => INSTALLED_VERSION }));
vi.mock("@/lib/openExternal", () => ({ openExternal }));
vi.mock("@/lib/updateCheckCache", () => ({
  checkUpdateCached: async () => null,
}));

describe("releaseNotesUrlFor", () => {
  it("links a stable release to its own tag", () => {
    expect(releaseNotesUrlFor("0.1.2")).toBe(
      "https://github.com/talmolab/sleap-app/releases/tag/v0.1.2",
    );
  });

  it("links a pre-release to its own -N tag", () => {
    expect(releaseNotesUrlFor("0.1.2-2")).toBe(
      "https://github.com/talmolab/sleap-app/releases/tag/v0.1.2-2",
    );
  });

  it("has no page for a dev build", () => {
    expect(releaseNotesUrlFor("0.1.2+10.a703c1d")).toBeNull();
  });
});

describe("installedReleaseNotes", () => {
  it("is live for a packaged stable build", async () => {
    const { installedReleaseNotes } = await import(
      "@/components/panels/EnvironmentPanel"
    );
    const notes = installedReleaseNotes("0.1.2", false);
    expect(notes.url).toBe(releaseNotesUrlFor("0.1.2"));
    expect(notes.title).toContain("v0.1.2");
  });

  it("is live for a packaged pre-release build", async () => {
    const { installedReleaseNotes } = await import(
      "@/components/panels/EnvironmentPanel"
    );
    expect(installedReleaseNotes("0.1.2-2", false).url).toBe(
      releaseNotesUrlFor("0.1.2-2"),
    );
  });

  it("is greyed out for a dev build, saying why", async () => {
    const { installedReleaseNotes } = await import(
      "@/components/panels/EnvironmentPanel"
    );
    const notes = installedReleaseNotes("0.1.2+10.a703c1d", false);
    expect(notes.url).toBeNull();
    expect(notes.title).toContain("Dev builds");
  });

  it("is greyed out for a local build even when its version looks stable", async () => {
    const { installedReleaseNotes } = await import(
      "@/components/panels/EnvironmentPanel"
    );
    const notes = installedReleaseNotes("0.1.2", true);
    expect(notes.url).toBeNull();
    expect(notes.title).toContain("tauri:dev");
  });
});

describe("AppUpdateSection release-notes button (local build)", () => {
  beforeEach(async () => {
    openExternal.mockClear();
    const { useAppStore } = await import("@/stores/appStore");
    act(() => {
      useAppStore.setState((s) => {
        s.updateChannel = "stable";
        s.updateChannelExplicitlySet = true;
      });
    });
  });

  it("renders greyed out with the reason in its tooltip, and opens nothing", async () => {
    const { AppUpdateSection } = await import(
      "@/components/panels/EnvironmentPanel"
    );

    render(<AppUpdateSection />);
    const button = await waitFor(() =>
      screen.getByRole("button", { name: /release notes/i }),
    );

    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.className).toContain("opacity-50");
    expect(button.getAttribute("title")).toContain("tauri:dev");

    fireEvent.click(button);
    expect(openExternal).not.toHaveBeenCalled();
  });
});
