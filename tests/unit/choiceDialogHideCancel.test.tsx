/**
 * `hideCancel` on a choice prompt: the edit-list prompt (#274) has exactly two
 * answers (Shift / Keep as is), so it must not show a third "Cancel" button.
 */
import { describe, it, expect, beforeAll, afterEach } from "../bun-test";
import { render, screen, cleanup, act } from "@testing-library/react";
import { ChoiceDialog } from "@/components/dialogs/ChoiceDialog";
import { choiceDialog, useChoiceStore } from "@/stores/choiceStore";

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(() => {
  act(() => useChoiceStore.getState().respond(null));
  cleanup();
});

describe("ChoiceDialog hideCancel", () => {
  // Default prompts keep their Cancel button.
  it("shows Cancel by default", () => {
    render(<ChoiceDialog />);
    act(() => {
      void choiceDialog({ message: "m", options: [{ key: "a", label: "A" }] });
    });
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeNull();
  });

  // hideCancel leaves only the given options.
  it("hides Cancel when asked", () => {
    render(<ChoiceDialog />);
    act(() => {
      void choiceDialog({
        message: "m",
        options: [
          { key: "shift", label: "Shift" },
          { key: "keep", label: "Keep as is", primary: true },
        ],
        hideCancel: true,
      });
    });
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    expect(screen.getByRole("button", { name: "Keep as is" })).not.toBeNull();
  });
});
