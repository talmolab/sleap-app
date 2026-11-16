/**
 * Settable medium / large frame step sizes (PyQt SLEAP's "medium step size" /
 * "large step size" preferences, fixed at 10 / 100 in sleap-app before):
 * Go ▸ Frame Step Sizes… sets them, Ctrl(+Shift)+arrow uses them, and they are
 * saved with the other preferences.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from "../bun-test";
import { render, renderHook, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { useAppStore, PERSISTED_KEYS, type AppState } from "@/stores/appStore";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { FrameStepSizesDialog, stepKeysLabel } from "@/components/dialogs/FrameStepSizesDialog";
import { parseStepSize } from "@/lib/preferences";
import { MAX_STEP_SIZE, shortcutBindings } from "@/lib/shortcuts";
import { formatShortcut } from "@/lib/formatShortcut";

beforeAll(() => {
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
});
afterEach(() => cleanup());

describe("step size defaults and persistence", () => {
  // A fresh install keeps PyQt's 10 / 100.
  it("defaults to 10 and 100 frames", () => {
    expect(useAppStore.getState().mediumStepSize).toBe(10);
    expect(useAppStore.getState().largeStepSize).toBe(100);
  });

  // They must survive a restart like the other preferences.
  it("is saved with the preferences", () => {
    expect(PERSISTED_KEYS).toContain("mediumStepSize");
    expect(PERSISTED_KEYS).toContain("largeStepSize");
  });

  // A hand-edited or corrupt saved value must not break Ctrl+arrow.
  it("falls back to the default when a saved value is unusable", () => {
    const merge = useAppStore.persist.getOptions().merge!;
    const current = useAppStore.getInitialState();
    const bad = merge({ mediumStepSize: "abc", largeStepSize: 0 }, current) as AppState;
    expect(bad.mediumStepSize).toBe(10);
    expect(bad.largeStepSize).toBe(100);
    const good = merge({ mediumStepSize: 5, largeStepSize: 250 }, current) as AppState;
    expect(good.mediumStepSize).toBe(5);
    expect(good.largeStepSize).toBe(250);
  });
});

describe("parseStepSize", () => {
  // Only whole, positive frame counts make sense as a jump.
  it("accepts whole numbers from 1 up to the limit", () => {
    expect(parseStepSize("1")).toBe(1);
    expect(parseStepSize(" 25 ")).toBe(25);
    expect(parseStepSize(String(MAX_STEP_SIZE))).toBe(MAX_STEP_SIZE);
  });

  // Anything else is refused so the dialog can say so.
  it("rejects zero, negatives, decimals, empty and huge values", () => {
    for (const bad of ["0", "-5", "2.5", "", "ten", "1e3", String(MAX_STEP_SIZE + 1)]) {
      expect(parseStepSize(bad)).toBeNull();
    }
  });
});

describe("Ctrl+arrow uses the step size preferences", () => {
  const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
  const press = (shiftKey: boolean, key: "ArrowRight" | "ArrowLeft") =>
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          code: key,
          shiftKey,
          metaKey: isMac,
          ctrlKey: !isMac,
          bubbles: true,
        }),
      );
    });

  // The shortcuts used to jump a hard-coded 10 / 100 frames.
  it("jumps by the medium and large step sizes the user set", () => {
    const steps: number[] = [];
    useAppStore.setState({
      mediumStepSize: 7,
      largeStepSize: 300,
      incrementFrameIdx: (step: number) => {
        steps.push(step);
      },
    });
    renderHook(() => useKeyboardShortcuts());
    press(false, "ArrowRight");
    press(false, "ArrowLeft");
    press(true, "ArrowRight");
    press(true, "ArrowLeft");
    expect(steps).toEqual([7, -7, 300, -300]);
  });

  // ⌘←/→ in a text field (like this dialog's own step fields) moves the caret;
  // it used to also jump frames behind the dialog and swallow the keystroke.
  it("leaves the keys to a focused text field", () => {
    const steps: number[] = [];
    useAppStore.setState({ incrementFrameIdx: (step: number) => void steps.push(step) });
    renderHook(() => useKeyboardShortcuts());
    const input = document.createElement("input");
    document.body.appendChild(input);
    for (const shiftKey of [false, true]) {
      const ev = new KeyboardEvent("keydown", {
        key: "ArrowRight",
        code: "ArrowRight",
        shiftKey,
        metaKey: isMac,
        ctrlKey: !isMac,
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        input.dispatchEvent(ev);
      });
      expect(ev.defaultPrevented).toBe(false);
    }
    expect(steps).toEqual([]);
    input.remove();
  });
});

describe("step key hint", () => {
  // The hint lists every key bound to the step (#473 adds Ctrl+Alt+arrows),
  // not just one hard-coded pair.
  it("lists each bound key pair from shortcutBindings", () => {
    const fwd = shortcutBindings("frame next large step");
    const back = shortcutBindings("frame prev large step");
    const label = stepKeysLabel("frame next large step", "frame prev large step");
    expect(label.split(", ").length).toBe(fwd.length);
    expect(label).toContain(`${formatShortcut(fwd[0])} / ${formatShortcut(back[0])}`);
  });
});

describe("Frame Step Sizes dialog", () => {
  const open = () => {
    act(() => useAppStore.getState().set("frameStepSizesDialogOpen", true));
  };
  const field = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;

  // The dialog starts from the current values, not the defaults.
  it("shows the current step sizes", () => {
    useAppStore.setState({ mediumStepSize: 4, largeStepSize: 40 });
    render(<FrameStepSizesDialog />);
    open();
    expect(field(/Medium step/).value).toBe("4");
    expect(field(/Large step/).value).toBe("40");
  });

  // OK saves both values and closes.
  it("saves new values on OK", () => {
    render(<FrameStepSizesDialog />);
    open();
    fireEvent.change(field(/Medium step/), { target: { value: "15" } });
    fireEvent.change(field(/Large step/), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    const s = useAppStore.getState();
    expect(s.mediumStepSize).toBe(15);
    expect(s.largeStepSize).toBe(500);
    expect(s.frameStepSizesDialogOpen).toBe(false);
  });

  // A bad value stays in the dialog with a message and saves nothing.
  it("refuses an invalid value and keeps the dialog open", () => {
    render(<FrameStepSizesDialog />);
    open();
    fireEvent.change(field(/Medium step/), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(screen.getByText(/whole numbers of frames/)).toBeTruthy();
    expect(useAppStore.getState().mediumStepSize).toBe(10);
    expect(useAppStore.getState().frameStepSizesDialogOpen).toBe(true);
  });

  // Defaults refills 10 / 100 without saving until OK.
  it("Defaults refills 10 and 100", () => {
    useAppStore.setState({ mediumStepSize: 3, largeStepSize: 33 });
    render(<FrameStepSizesDialog />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "Defaults" }));
    expect(field(/Medium step/).value).toBe("10");
    expect(field(/Large step/).value).toBe("100");
    expect(useAppStore.getState().mediumStepSize).toBe(3);
    fireEvent.click(screen.getByRole("button", { name: "OK" }));
    expect(useAppStore.getState().mediumStepSize).toBe(10);
    expect(useAppStore.getState().largeStepSize).toBe(100);
  });
});
