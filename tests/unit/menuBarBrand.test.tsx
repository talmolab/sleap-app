/**
 * Menu-bar SLEAP brand block: desktop (Tauri) behaviour.
 *
 * The web-mode assertion lives in components.test.tsx (which mocks the platform
 * as isTauri: false, so the brand renders). This file mocks the platform as the
 * desktop shell (isTauri: true). Under `bun test --isolate` each file gets a
 * fresh module registry, so this mock never leaks into the web-mode suite — and
 * MenuBar, imported dynamically below (after the mock is registered), binds to
 * it. It verifies the icon + wordmark are hidden on desktop, where the native
 * OS title bar already shows "SLEAP" (#133 / #142).
 */

import { describe, it, expect, vi } from "../bun-test";
import { render, screen } from "@testing-library/react";

// Desktop shell: isTauri true. Registered here (module body) before the dynamic
// MenuBar import in the test — bun's mock.module only affects modules imported
// after this call, so a static top-of-file MenuBar import would miss it.
vi.mock("@/lib/platform", () => ({
  isTauri: true,
  isMac: false,
  modKey: "Ctrl",
  altKey: "Alt",
}));

// MenuBar's click handlers route through sonner via @/lib/notify; stub it so no
// real toast host is required.
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

describe("MenuBar SLEAP brand (desktop / Tauri)", () => {
  it("hides the icon + wordmark on desktop (#133)", async () => {
    const { MenuBar } = await import("@/components/layout/MenuBar");
    const { container } = render(<MenuBar />);
    // The menu itself still renders...
    expect(screen.getByText("File")).toBeInTheDocument();
    // ...but the brand block (wordmark + its decorative icon) does not.
    expect(screen.queryByText("SLEAP")).not.toBeInTheDocument();
    expect(container.querySelector("img")).not.toBeInTheDocument();
  });
});
