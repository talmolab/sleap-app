/**
 * Which docs URL a DESKTOP build resolves to (@/lib/docsUrl).
 *
 * There is no channel path to read in the Tauri webview, so the docs version
 * comes from the update channel the app is on -- whatever the Environment panel
 * shows, Help agrees with. See docsUrlWeb.test.ts for the web half and the note
 * there on why the two are separate files.
 *
 * `bun test` sets import.meta.env.DEV to the STRING "true" (Vite uses a real
 * boolean), which resolveDocsVersion compares strictly -- that is what stops
 * the dev-mode short circuit from swallowing these cases.
 */

import { describe, it, expect, vi, beforeEach } from "../bun-test";

vi.mock("@/lib/platform", () => ({
  isTauri: true,
  isMac: false,
  modKey: "Ctrl",
  altKey: "Alt",
}));

describe("getDocsUrl on the desktop (follows the update channel)", () => {
  beforeEach(async () => {
    const { useAppStore } = await import("@/stores/appStore");
    useAppStore.setState((s) => {
      s.updateChannel = "stable";
      s.updateChannelExplicitlySet = false;
    });
  });

  it("follows a channel the user picked in the Environment panel", async () => {
    const { useAppStore } = await import("@/stores/appStore");
    const { getDocsUrl } = await import("@/lib/docsUrl");

    useAppStore.setState((s) => {
      s.updateChannel = "dev";
      s.updateChannelExplicitlySet = true;
    });
    // The reported bug: on the dev channel this used to open /docs/latest/,
    // because the link was derived from the version string instead.
    expect(getDocsUrl()).toBe("https://app.sleap.ai/docs/dev/");
  });

  it("switches with the channel mid-session, with no reload", async () => {
    const { useAppStore } = await import("@/stores/appStore");
    const { getDocsUrl } = await import("@/lib/docsUrl");

    for (const [channel, expected] of [
      ["stable", "https://app.sleap.ai/docs/stable/"],
      ["latest", "https://app.sleap.ai/docs/latest/"],
      ["dev", "https://app.sleap.ai/docs/dev/"],
    ] as const) {
      useAppStore.setState((s) => {
        s.updateChannel = channel;
        s.updateChannelExplicitlySet = true;
      });
      // Read at call time -- which is why the menu items call getDocsUrl()
      // inside their handler rather than capturing a module-level constant.
      expect(getDocsUrl()).toBe(expected);
    }
  });

  it("ignores the store's 'stable' default before the user has chosen", async () => {
    const { APP_VERSION, channelForVersion } = await import("@/lib/version");
    const { getDocsUrl } = await import("@/lib/docsUrl");

    // updateChannel is hardcoded "stable" on a fresh profile and only corrected
    // once the Environment panel mounts, so an untouched dropdown must not be
    // taken at face value -- the running build's own channel wins instead.
    expect(getDocsUrl()).toBe(
      `https://app.sleap.ai/docs/${channelForVersion(APP_VERSION)}/`,
    );
  });
});
