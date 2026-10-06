/**
 * About dialog version display -- web mode.
 *
 * Regression guard: this dialog used to render a hardcoded "Version 0.1.0"
 * string literal, so the one place a user would look to check what they were
 * running was the one place guaranteed to be wrong -- on desktop too, and no
 * matter what CI stamped. It must read @/lib/version instead.
 *
 * The desktop-mode counterpart lives in aboutDialogVersionDesktop.test.tsx
 * (platform mocks are per-file under `bun test --isolate`).
 */

import { describe, it, expect, vi } from "../bun-test";
import { render, screen } from "@testing-library/react";
import { APP_VERSION, APP_VERSION_KIND_LABEL } from "@/lib/version";

vi.mock("@/lib/platform", () => ({
  isTauri: false,
  isMac: false,
  modKey: "Ctrl",
  altKey: "Alt",
}));

describe("HelpDialog version (web)", () => {
  it("shows the build's real version, not a hardcoded literal", async () => {
    const { HelpDialog } = await import("@/components/dialogs/HelpDialog");
    render(<HelpDialog open onOpenChange={() => {}} />);

    expect(
      screen.getByText(new RegExp(`Version\\s+${escapeRe(APP_VERSION)}`)),
    ).toBeInTheDocument();
  });

  it("names the channel the build is on", async () => {
    const { HelpDialog } = await import("@/components/dialogs/HelpDialog");
    render(<HelpDialog open onOpenChange={() => {}} />);

    expect(screen.getByTestId("about-version-kind")).toHaveTextContent(
      APP_VERSION_KIND_LABEL,
    );
  });

  it("identifies itself as the web build", async () => {
    const { HelpDialog } = await import("@/components/dialogs/HelpDialog");
    render(<HelpDialog open onOpenChange={() => {}} />);

    expect(screen.getByText("SLEAP Label Web")).toBeInTheDocument();
  });

  it("no longer contains the old hardcoded 0.1.0 string", async () => {
    const { HelpDialog } = await import("@/components/dialogs/HelpDialog");
    const { baseElement } = render(
      <HelpDialog open onOpenChange={() => {}} />,
    );

    expect(baseElement.textContent).not.toContain("Version 0.1.0");
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
