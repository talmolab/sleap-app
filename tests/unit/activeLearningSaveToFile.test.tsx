/**
 * Render test for the active-learning workflow builder's "Save to file…" button
 * (YAML tab). The AL store isn't persisted, so this button is the supported way
 * to keep a built workflow across reloads (re-imported via the panel's
 * "Import .yaml…").
 *
 * Proves the BUTTON WIRING: it serializes the editor draft and routes to the
 * file sink. We run the browser path (`isTauri: false`) so it lands on the
 * shared `downloadFile` helper, which we spy.
 *
 * Mocks are registered at MODULE SCOPE: the bun-test `vi.mock` shim is NOT
 * hoisted, so it only affects modules imported AFTER it runs — the dialog is
 * therefore imported dynamically inside the test, after these top-level mocks.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  vi,
} from "../bun-test";
import {
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";

const downloadFileSpy = vi.fn(
  (_content: string | Blob, _filename: string, _mime?: string) => undefined,
);

vi.mock("@/lib/notify", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/lib/exportUtils", () => ({ downloadFile: downloadFileSpy }));
vi.mock("@/platform", () => ({
  isTauri: false,
  getPlatform: vi.fn(async () => ({
    isTauri: false,
    showOpenDialog: vi.fn(async () => null),
    showSaveDialog: vi.fn(async () => null),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    exists: vi.fn(async () => false),
  })),
}));

// Radix Dialog/Tabs/Select need these DOM shims under the bun test runner.
beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});

describe("ActiveLearningConfigDialog — Save to file… (YAML tab)", () => {
  it("browser path: serializes the workflow draft and calls downloadFile with a .yaml name", async () => {
    downloadFileSpy.mockClear();

    const { ActiveLearningConfigDialog } = await import(
      "@/components/dialogs/ActiveLearningConfigDialog"
    );

    // No stored config → the dialog seeds the draft from these node names.
    render(
      <ActiveLearningConfigDialog
        open
        onOpenChange={() => {}}
        nodeNames={["head", "tail"]}
      />,
    );

    // The button lives in the YAML tab, which Radix only mounts when active.
    // Radix Tabs need a pointer-down sequence; a plain click is a no-op in
    // happy-dom (matching the other Radix-tab tests in this suite).
    const yamlTab = screen
      .getAllByRole("tab")
      .find((t) => /yaml/i.test(t.textContent ?? ""))!;
    fireEvent.pointerDown(yamlTab, { button: 0 });
    fireEvent.mouseDown(yamlTab, { button: 0 });

    fireEvent.click(
      await screen.findByRole("button", { name: /save to file/i }),
    );

    await waitFor(() => {
      expect(downloadFileSpy).toHaveBeenCalled();
    });

    const [content, filename] = downloadFileSpy.mock.calls[0];
    // The saved YAML is the serialized workflow, not the raw textarea.
    expect(String(content)).toContain("localize");
    expect(String(content)).toContain("head");
    expect(String(filename)).toBe("active-learning.yaml");
  });
});
