/**
 * About dialog version display -- desktop (Tauri) mode.
 *
 * Same @/lib/version source as the web build: build.yml patches package.json
 * from the release tag before Vite runs, so the desktop bundle's
 * __APP_VERSION__ matches the installer's own version. See
 * aboutDialogVersion.test.tsx for the web-mode assertions.
 */

import { describe, it, expect, vi } from "../bun-test";
import { render, screen } from "@testing-library/react";
import { APP_VERSION } from "@/lib/version";

vi.mock("@/lib/platform", () => ({
  isTauri: true,
  isMac: false,
  modKey: "Ctrl",
  altKey: "Alt",
}));

describe("HelpDialog version (desktop / Tauri)", () => {
  it("identifies itself as the desktop build", async () => {
    const { HelpDialog } = await import("@/components/dialogs/HelpDialog");
    render(<HelpDialog open onOpenChange={() => {}} />);

    expect(screen.getByText("SLEAP Label Desktop")).toBeInTheDocument();
    expect(screen.queryByText("SLEAP Label Web")).not.toBeInTheDocument();
  });

  it("still reports the real version on desktop", async () => {
    const { HelpDialog } = await import("@/components/dialogs/HelpDialog");
    const { baseElement } = render(
      <HelpDialog open onOpenChange={() => {}} />,
    );

    expect(baseElement.textContent).toContain(APP_VERSION);
    expect(baseElement.textContent).not.toContain("Version 0.1.0");
  });
});
