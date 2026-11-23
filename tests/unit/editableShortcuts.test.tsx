/**
 * Editable keyboard shortcuts (Help ▸ Keyboard Shortcuts…, PyQt's
 * dialogs/shortcuts.py): rebinding, the "used by X — move it here?" conflict
 * rule, saving with the preferences, the menus (native accelerators, Search
 * Menus) following the user's keys, Reset Preferences, and the
 * shortcuts.yaml file.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from "../bun-test";
import { render, renderHook, screen, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import { useAppStore, PERSISTED_KEYS, PREFERENCES_STORAGE_KEY, type AppState } from "@/stores/appStore";
import { useConfirmStore } from "@/stores/confirmStore";
import { useKeyboardShortcuts, syncShortcutsAcrossWindows } from "@/hooks/useKeyboardShortcuts";
import { ownedShortcuts } from "@/lib/menu/useNativeMenu";
import { shortcutText } from "@/lib/shortcutPrefs";
import { commandContext } from "@/commands";
import { DEFAULT_SHORTCUTS, shortcutBindings } from "@/lib/shortcuts";
import {
  EDITABLE_ACTIONS,
  UNEDITABLE_ACTIONS,
  assignShortcut,
  clearShortcut,
  defaultKeyConflicts,
  duplicateKeys,
  findConflict,
  keyFromEvent,
  resetShortcut,
  reservedKeyLabel,
  sanitizeOverrides,
} from "@/lib/shortcutEditing";
import { exportShortcutsYaml, fromQtKey, parseShortcutsYaml, toQtKey } from "@/lib/shortcutsFile";
import { currentAppMenu, pickInputs, snapshotFrom, subscribeAppMenu } from "@/lib/menu/useAppMenu";
import { buildAppMenu } from "@/lib/menu/appMenu";
import { MENU_SHORTCUT_ACTIONS, menuItemForAction } from "@/lib/menu/menuShortcuts";
import { toNativeSpec, type NativeNode } from "@/lib/menu/nativeMenu";
import { searchableCommands } from "@/lib/menu/searchable";
import { resetPreferencesToDefaults } from "@/lib/preferences";
import { ShortcutsDialog } from "@/components/dialogs/ShortcutsDialog";

/** PyQt SLEAP's sleap/config/shortcuts.yaml (develop), verbatim. */
const PYQT_DEFAULT_YAML = `add instance: Ctrl+I
add videos: 
clear selection: Esc
close: Ctrl+Q
color predicted: 
delete area: Ctrl+K
delete clip:
delete instance: Ctrl+Backspace
delete track: Ctrl+Shift+Backspace
export clip:
fit: Ctrl+=
goto frame: Ctrl+J
goto marked: Ctrl+Shift+M
goto last interacted: Ctrl+A
goto next suggestion: Space
goto next track spawn: Ctrl+E
goto next user: Ctrl+U
goto prev user: Ctrl+Shift+U
goto next labeled: Alt+Right
goto prev suggestion: Shift+Space
goto prev labeled: Alt+Left
learning: Ctrl+L
mark negative: 'N'
merge instance:
new: Ctrl+N
next video: Alt+Shift+Right
open: Ctrl+O
prev video: Alt+Shift+Left
save as: Ctrl+Shift+S
save: Ctrl+S
select next: '\`'
select to frame: Ctrl+Shift+J
show instances: H
show non-visible nodes: Shift+V
show edges: Ctrl+Shift+Tab
show labels: Ctrl+Tab
show trails: 
transpose: Ctrl+T
propagate track labels: P
frame next: Right
frame prev: Left
frame next medium step: Ctrl+Right
frame prev medium step: Ctrl+Left
frame next large step: Ctrl+Alt+Right
frame prev large step: Ctrl+Alt+Left
export_analysis_current: Ctrl+Alt+E
`;

// tinykeys reads $mod as ⌘ on Apple platforms, Ctrl elsewhere; press the same.
const MAC = /Mac|iPod|iPhone|iPad/.test(navigator.platform);

function press(code: string, m: { mod?: boolean; shift?: boolean; ctrl?: boolean } = {}, type = "keydown") {
  const key = code.startsWith("Key") ? code.slice(3).toLowerCase() : code;
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent(type, {
        key,
        code,
        metaKey: !!m.mod && MAC,
        ctrlKey: !!m.ctrl || (!!m.mod && !MAC),
        shiftKey: !!m.shift,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
}

const findNative = (nodes: NativeNode[], id: string): NativeNode | undefined => {
  for (const n of nodes) {
    if ("id" in n && n.id === id) return n;
    if (n.kind === "submenu") {
      const inner = findNative(n.items, id);
      if (inner) return inner;
    }
  }
  return undefined;
};
const accelerator = (id: string) => {
  for (const m of toNativeSpec(currentAppMenu()).menus) {
    const n = findNative(m.items, id);
    if (n) return "accelerator" in n ? n.accelerator : undefined;
  }
  throw new Error(`no menu item ${id}`);
};

beforeAll(() => {
  const proto = Element.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.setPointerCapture ??= () => {};
  proto.releasePointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});

beforeEach(() => {
  useAppStore.setState(useAppStore.getInitialState());
});
afterEach(() => cleanup());

describe("which actions can be rebound", () => {
  // A shortcut added to DEFAULT_SHORTCUTS later must show up in the dialog
  // (or be left out on purpose), never silently not editable.
  it("covers every shortcut name, each in exactly one category", () => {
    for (const action of Object.keys(DEFAULT_SHORTCUTS)) {
      const n = EDITABLE_ACTIONS.filter((a) => a === action).length;
      expect(n + (UNEDITABLE_ACTIONS.includes(action) ? 1 : 0)).toBe(1);
    }
  });

  // The menu map must point at real items, whose built-in key is the
  // action's default — otherwise the menu would show the wrong key.
  it("maps each menu item to an action whose default key it already showed", () => {
    const s = useAppStore.getState();
    const raw = buildAppMenu({
      ...snapshotFrom(pickInputs(s)),
      projectLoaded: true,
      hasInstance: true,
      trackNames: ["t1"],
    });
    for (const [id, action] of Object.entries(MENU_SHORTCUT_ACTIONS)) {
      expect(EDITABLE_ACTIONS).toContain(action);
      const item = menuItemForAction(raw, action);
      expect(item?.id).toBe(id);
      if (item?.shortcut) expect(item.shortcut).toBe(DEFAULT_SHORTCUTS[action]);
    }
  });
});

describe("rebinding", () => {
  // Picking a new key replaces the action's keys; nothing else changes.
  it("gives the action the new key, and only that key", () => {
    const o = assignShortcut({}, "show labels", "KeyG", true);
    expect(shortcutBindings("show labels", o)).toEqual(["KeyG"]);
    expect(shortcutBindings("show instances", o)).toEqual(["KeyH"]);
  });

  // Setting a default back drops the override instead of storing a copy.
  it("stores nothing for an action set back to its default", () => {
    expect(assignShortcut({}, "save", "$mod+KeyS", true)).toEqual({});
    const o = clearShortcut({}, "save");
    expect(shortcutBindings("save", o)).toEqual([]);
    expect(resetShortcut(o, "save", true)).toEqual({});
  });

  // The key press → binding the dialog stores, per platform.
  it("reads a key press as a binding", () => {
    expect(keyFromEvent({ code: "KeyS", metaKey: true, ctrlKey: false, altKey: false, shiftKey: true }, true)).toBe("$mod+Shift+KeyS");
    expect(keyFromEvent({ code: "Tab", metaKey: false, ctrlKey: true, altKey: false, shiftKey: false }, true)).toBe("Control+Tab");
    expect(keyFromEvent({ code: "KeyK", metaKey: false, ctrlKey: true, altKey: true, shiftKey: false }, false)).toBe("$mod+Alt+KeyK");
    expect(keyFromEvent({ code: "ShiftLeft", metaKey: false, ctrlKey: false, altKey: false, shiftKey: true }, false)).toBeNull();
  });

  // The global key handler follows the user's keys: new key works, old one doesn't.
  it("moves the canvas key handler to the new key", () => {
    useAppStore.setState({ shortcutOverrides: { "show instances": ["KeyG"] } });
    renderHook(() => useKeyboardShortcuts());
    const before = useAppStore.getState().showInstances;
    press("KeyH");
    expect(useAppStore.getState().showInstances).toBe(before);
    press("KeyG");
    expect(useAppStore.getState().showInstances).toBe(!before);
  });

  // A change made while the app is running takes effect without a restart
  // (PyQt needs one).
  it("rebinds live when the preference changes", () => {
    renderHook(() => useKeyboardShortcuts());
    const before = useAppStore.getState().showInstances;
    act(() => useAppStore.setState({ shortcutOverrides: { "show instances": ["KeyG"] } }));
    press("KeyG");
    expect(useAppStore.getState().showInstances).toBe(!before);
  });

  // An action that's only a menu command still runs from a key the user gives it.
  it("runs a menu-only action from its new key", () => {
    useAppStore.setState({ shortcutOverrides: { "color predicted": ["KeyG"] } });
    renderHook(() => useKeyboardShortcuts());
    const before = useAppStore.getState().colorPredicted;
    press("KeyG");
    expect(useAppStore.getState().colorPredicted).toBe(!before);
  });

  // A key that the Label QC Review window also uses (A = accept) still works
  // for the user's action outside that window.
  it("lets an action share a review-only key outside review", () => {
    useAppStore.setState({ shortcutOverrides: { "show instances": ["KeyA"] } });
    renderHook(() => useKeyboardShortcuts());
    const before = useAppStore.getState().showInstances;
    press("KeyA");
    expect(useAppStore.getState().showInstances).toBe(!before);
  });
});

describe("conflicts", () => {
  // The decided rule: say who has the key; Yes moves it and leaves the other unbound.
  it("names the action that has the key, and moving it leaves that one unbound", () => {
    expect(findConflict({}, "add track", "$mod+KeyK", { mac: true })).toEqual({
      kind: "action",
      action: "delete area predictions",
    });
    const o = assignShortcut({}, "add track", "$mod+KeyK", true);
    expect(shortcutBindings("add track", o)).toEqual(["$mod+KeyK"]);
    expect(shortcutBindings("delete area predictions", o)).toEqual([]);
  });

  // An action with two keys only loses the one that moved.
  it("keeps an action's other key when one of two moves away", () => {
    const o = assignShortcut({}, "add track", "Control+Tab", true);
    expect(shortcutBindings("show labels", o)).toEqual(["KeyT"]);
  });

  // On Windows/Linux Ctrl+Tab and $mod+Tab are the same keys; on macOS they aren't.
  it("compares keys as the platform sees them", () => {
    expect(findConflict({}, "add track", "$mod+Tab", { mac: false, web: false })).toEqual({ kind: "action", action: "show labels" });
    expect(findConflict({}, "add track", "$mod+Shift+KeyY", { mac: true, web: false })).toBeNull();
  });

  // Undo, the track digits and (on the macOS desktop) ⌘Q can't be taken.
  it("refuses keys that can't be reassigned", () => {
    expect(findConflict({}, "add track", "$mod+KeyZ", { mac: true })).toEqual({ kind: "reserved", label: "Undo" });
    expect(findConflict({}, "add track", "$mod+Digit3", { mac: true })?.kind).toBe("reserved");
    expect(findConflict({}, "add track", "$mod+KeyQ", { mac: true, nativeMenu: true, web: false })).toEqual({ kind: "reserved", label: "Quit SLEAP" });
    expect(findConflict({}, "close", "$mod+KeyQ", { mac: true, nativeMenu: true, web: false })).toBeNull();
  });

  // Resetting one action can need a key another has since taken: say so, then move it back.
  it("finds and moves back a default key taken in the meantime", () => {
    const o = assignShortcut({}, "add track", "$mod+KeyK", true);
    expect(defaultKeyConflicts(o, "delete area predictions", true)).toEqual([{ key: "$mod+KeyK", action: "add track" }]);
    const back = resetShortcut(o, "delete area predictions", true);
    expect(shortcutBindings("delete area predictions", back)).toEqual(["$mod+KeyK"]);
    expect(shortcutBindings("add track", back)).toEqual([]);
  });

  // Whatever the user does, no key ends up on two actions.
  it("never leaves a key on two actions", () => {
    let o = {};
    for (const [action, key] of [
      ["add track", "$mod+KeyK"],
      ["show labels", "KeyH"],
      ["show instances", "KeyT"],
      ["fit", "Control+Tab"],
      ["delete area predictions", "$mod+Digit0"],
    ] as const) {
      o = assignShortcut(o, action, key, true);
    }
    o = resetShortcut(o, "add track", true);
    expect(duplicateKeys(o, true)).toEqual([]);
    expect(duplicateKeys({}, true)).toEqual([]);
  });
});

describe("the dialog", () => {
  let confirms: string[];
  let answer: boolean;
  beforeEach(() => {
    confirms = [];
    answer = true;
    useConfirmStore.setState({
      confirm: async (req: { message: string }) => {
        confirms.push(req.message);
        return answer;
      },
    } as never);
  });

  function openDialog() {
    render(<ShortcutsDialog open onOpenChange={() => {}} />);
  }
  const keyButton = (action: string) =>
    document.querySelector(`[data-action="${action}"] button`) as HTMLButtonElement;

  // The whole flow: click a key, press one in use, answer the question, Save.
  it("asks before moving a key and saves the move", async () => {
    openDialog();
    fireEvent.click(keyButton("add track"));
    press("KeyK", { mod: true });
    await waitFor(() => expect(confirms).toHaveLength(1));
    expect(confirms[0]).toContain("is used by Delete Area Predictions — move it here?");
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("moved from Delete Area Predictions"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(useAppStore.getState().shortcutOverrides).toEqual({
      "add track": ["$mod+KeyK"],
      "delete area predictions": [],
    });
  });

  // No means nothing changes.
  it("keeps both actions as they were when the move is declined", async () => {
    answer = false;
    openDialog();
    fireEvent.click(keyButton("add track"));
    press("KeyK", { mod: true });
    await waitFor(() => expect(confirms).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(useAppStore.getState().shortcutOverrides).toEqual({});
  });

  // A captured key must not also run its action (here: N would mark the frame negative).
  it("doesn't let the key being captured reach the app", () => {
    renderHook(() => useKeyboardShortcuts());
    openDialog();
    const before = useAppStore.getState().showInstances;
    fireEvent.click(keyButton("add track"));
    press("KeyH");
    expect(useAppStore.getState().showInstances).toBe(before);
    expect(confirms[0]).toContain("is used by Show Instances");
  });

  // Cancel throws the draft away (PyQt's Cancel).
  it("changes nothing on Cancel", () => {
    let open = true;
    render(<ShortcutsDialog open={open} onOpenChange={(v) => (open = v)} />);
    fireEvent.click(keyButton("add track"));
    press("KeyG");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(open).toBe(false);
    expect(useAppStore.getState().shortcutOverrides).toEqual({});
  });
});

describe("saved with the preferences", () => {
  // Per computer, with the other preferences.
  it("is a persisted preference", () => {
    expect(PERSISTED_KEYS).toContain("shortcutOverrides");
  });

  // A stale or hand-edited saved value keeps only what makes sense.
  it("drops unknown actions and malformed keys when loading", () => {
    const merge = useAppStore.persist.getOptions().merge!;
    const state = merge(
      {
        shortcutOverrides: {
          save: ["$mod+KeyG"],
          "no such action": ["KeyA"],
          open: "KeyO",
          fit: ["<script>"],
          "show edges": [],
        },
      },
      useAppStore.getInitialState(),
    ) as AppState;
    expect(state.shortcutOverrides).toEqual({ save: ["$mod+KeyG"], "show edges": [] });
    expect(sanitizeOverrides("garbage")).toEqual({});
  });

  // File ▸ Reset Preferences to Defaults puts the keys back too (#483).
  it("is reset by Reset Preferences", () => {
    useAppStore.setState({ shortcutOverrides: { save: ["$mod+KeyG"] } });
    resetPreferencesToDefaults();
    expect(useAppStore.getState().shortcutOverrides).toEqual({});
  });
});

describe("the menus", () => {
  // The native macOS menu's accelerators follow the user's keys.
  it("updates native menu accelerators", () => {
    expect(accelerator("file.save")).toBe("CmdOrCtrl+S");
    useAppStore.setState({ shortcutOverrides: { save: ["$mod+KeyG"], open: [] } });
    expect(accelerator("file.save")).toBe("CmdOrCtrl+G");
    expect(accelerator("file.open")).toBeUndefined();
  });

  // The native menu is rebuilt when the keys change.
  it("rebuilds the menu when shortcuts change", () => {
    const seen: (string | undefined)[] = [];
    const unsubscribe = subscribeAppMenu((menu) => {
      seen.push(menuItemForAction(menu, "save")?.shortcut);
    });
    useAppStore.setState({ shortcutOverrides: { save: ["$mod+KeyG"] } });
    unsubscribe();
    expect(seen).toEqual(["$mod+KeyS", "$mod+KeyG"]);
  });

  // Search Menus shows the same key.
  it("shows the user's key in Search Menus", () => {
    useAppStore.setState({ shortcutOverrides: { "show labels": ["Shift+KeyL"] } });
    const cmd = searchableCommands(currentAppMenu()).find((c) => c.id === "view.showLabels");
    expect(cmd?.shortcut).toBe("Shift+KeyL");
  });
});

describe("shortcuts.yaml", () => {
  // Qt's key names, as PyQt writes them.
  it("converts keys to and from Qt's names", () => {
    expect(toQtKey("$mod+Shift+KeyS")).toBe("Ctrl+Shift+S");
    expect(toQtKey("Alt+ArrowRight")).toBe("Alt+Right");
    expect(toQtKey("Control+Tab")).toBe("Meta+Tab");
    expect(fromQtKey("Ctrl+=")).toBe("$mod+Equal");
    expect(fromQtKey("Esc")).toBe("Escape");
    expect(fromQtKey("`")).toBe("Backquote");
    expect(fromQtKey("Shift+Space")).toBe("Shift+Space");
    expect(fromQtKey("$mod+KeyK")).toBe("$mod+KeyK");
    expect(fromQtKey("Ctrl+K, Ctrl+L")).toBeNull();
    expect(fromQtKey("Hyper+K")).toBeNull();
  });

  // Export then import gives back the same shortcuts.
  it("round-trips through a file", () => {
    let o = assignShortcut({}, "add track", "$mod+KeyK", true);
    o = clearShortcut(o, "export clip");
    o = assignShortcut(o, "fit", "Shift+F1", true);
    const back = parseShortcutsYaml(exportShortcutsYaml(o), { mac: true });
    expect(back.overrides).toEqual(o);
    expect(back.invalid).toEqual([]);
    expect(back.unknown).toEqual([]);
  });

  // Importing PyQt SLEAP's own default shortcuts.yaml must change nothing:
  // its entries are either empty or PyQt's defaults, which sleap-app has
  // replaced with its own (T for node names, Shift+M merge, Ctrl+Shift+arrows).
  it("keeps sleap-app's keys when importing PyQt's default shortcuts.yaml", () => {
    const r = parseShortcutsYaml(PYQT_DEFAULT_YAML, { mac: true, web: false });
    expect(r.overrides).toEqual({});
    expect(r.moved).toEqual([]);
    expect(r.unknown).toEqual(["add videos", "show trails"]);
    expect(shortcutBindings("show labels", r.overrides)).toEqual(["KeyT", "Control+Tab"]);
    expect(shortcutBindings("merge instance", r.overrides)).toEqual(["Shift+KeyM"]);
    expect(shortcutBindings("frame next large step", r.overrides)).toEqual(["$mod+Shift+ArrowRight", "$mod+Alt+ArrowRight"]);
  });

  // A key the user changed in PyQt comes across (with PyQt names), keeps
  // sleap-app's extra key, and moves a key another action had.
  it("imports the keys a PyQt user changed", () => {
    const r = parseShortcutsYaml(
      ["delete area: Ctrl+G", "frame next large step: Alt+PgDown", "goto next labeled: P", "merge instance:"].join("\n"),
      { mac: true, web: false },
    );
    expect(r.overrides).toEqual({
      "delete area predictions": ["$mod+KeyG"],
      "frame next large step": ["Alt+PageDown", "$mod+Alt+ArrowRight"],
      "goto next labeled": ["KeyP"],
      "toggle pan mode": [],
    });
    expect(r.moved).toEqual([{ key: "KeyP", from: "toggle pan mode", to: "goto next labeled" }]);
  });

  // A legacy key this platform keeps for itself (⌘Tab is the macOS app switcher) is refused, not imported dead.
  it("refuses reserved keys from a legacy file", () => {
    const r = parseShortcutsYaml("fit: Ctrl+Tab", { mac: true, web: false });
    expect(r.overrides).toEqual({});
    expect(r.invalid[0]).toContain("the macOS app switcher");
  });

  // The Windows key survives a round trip instead of turning into Ctrl.
  it("writes the Windows key as Win", () => {
    expect(toQtKey("Meta+KeyX")).toBe("Win+X");
    expect(fromQtKey("Win+X")).toBe("Meta+KeyX");
  });

  // A file that isn't a shortcuts file says so instead of resetting everything.
  it("rejects a file that isn't a mapping", () => {
    expect(() => parseShortcutsYaml("- a\n- b")).toThrow();
  });
});

describe("review fixes", () => {
  // Fit used to be ⌘= only; bound to a plain D it must not fire while typing
  // (here in a text field), but still work on the canvas.
  it("doesn't run plain-key actions while typing in a text field", () => {
    useAppStore.setState({ shortcutOverrides: { fit: ["KeyD"] } });
    renderHook(() => useKeyboardShortcuts());
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    const before = useAppStore.getState().fit;
    const ev = new KeyboardEvent("keydown", { code: "KeyD", key: "d", bubbles: true, cancelable: true });
    act(() => void input.dispatchEvent(ev));
    expect(useAppStore.getState().fit).toBe(before);
    expect(ev.defaultPrevented).toBe(false);
    press("KeyD");
    expect(useAppStore.getState().fit).toBe(!before);
    input.remove();
  });

  // ⌘ shortcuts are commands, so they still work from a text field.
  it("still runs ⌘ shortcuts from a text field", () => {
    useAppStore.setState({ shortcutOverrides: { "goto frame": ["$mod+KeyG"] } });
    renderHook(() => useKeyboardShortcuts());
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    act(() =>
      void input.dispatchEvent(
        new KeyboardEvent("keydown", { code: "KeyG", key: "g", metaKey: MAC, ctrlKey: !MAC, bubbles: true, cancelable: true }),
      ),
    );
    expect(useAppStore.getState().goToFrameDialogOpen).toBe(true);
    input.remove();
  });

  // A saved key that's also another action's default (from another window,
  // an older build or a hand edit) must not leave both bound: the saved one
  // wins and the default action loses it, so R doesn't silently do two things.
  it("resolves a key on two actions when loading", () => {
    const merge = useAppStore.persist.getOptions().merge!;
    const state = merge({ shortcutOverrides: { "show instances": ["KeyR"] } }, useAppStore.getInitialState()) as AppState;
    expect(state.shortcutOverrides).toEqual({ "show instances": ["KeyR"], "reset view": [] });
    expect(duplicateKeys(state.shortcutOverrides)).toEqual([]);
  });

  // On the macOS desktop app Quit lives only in the SLEAP menu (⌘Q): a key
  // the user moves Close to must stay with the app's handler, not be skipped
  // as menu-owned.
  it("doesn't treat Close's own key as native-menu owned", () => {
    useAppStore.setState({ shortcutOverrides: { close: ["$mod+KeyG"] } });
    const owned = ownedShortcuts(currentAppMenu());
    expect(owned).toContain("$mod+KeyQ");
    expect(owned).not.toContain("$mod+KeyG");
    expect(owned).toContain("$mod+KeyS");
  });

  // Keys the browser or macOS keep never reach the app: refuse them up front.
  it("refuses keys the browser or macOS keep", () => {
    expect(reservedKeyLabel("$mod+KeyW", "add track", { mac: false, web: true })).toBe("closing the browser tab");
    expect(reservedKeyLabel("$mod+KeyT", "add track", { mac: true, web: true })).toBe("opening a browser tab");
    const desktop = { mac: true, web: false, nativeMenu: true };
    expect(reservedKeyLabel("$mod+KeyH", "add track", desktop)).toBe("Hide SLEAP");
    expect(reservedKeyLabel("$mod+Alt+KeyH", "add track", desktop)).toBe("Hide Others");
    expect(reservedKeyLabel("$mod+KeyM", "add track", desktop)).toBe("Minimize (Window menu)");
    expect(reservedKeyLabel("$mod+KeyW", "add track", desktop)).toBe("Close Window (Window menu)");
    expect(reservedKeyLabel("$mod+Tab", "add track", desktop)).toBe("the macOS app switcher");
    expect(reservedKeyLabel("Alt+F4", "add track", { mac: false, web: false })).toBe("closing the window");
    // An action can keep its own default (Mark Frame is ⌘M; Transpose ⌘T).
    expect(reservedKeyLabel("$mod+KeyM", "mark frame", desktop)).toBeNull();
    expect(reservedKeyLabel("$mod+KeyT", "transpose", { mac: true, web: true })).toBeNull();
    // On the desktop app the browser's keys are free.
    expect(reservedKeyLabel("$mod+KeyT", "add track", { mac: false, web: false })).toBeNull();
  });

  // Holding Space pans the view, so only the suggestion keys may use it.
  it("keeps Space for panning and the suggestion keys", () => {
    expect(reservedKeyLabel("Space", "show instances", { mac: true })).toBe("panning (hold Space and drag)");
    expect(reservedKeyLabel("Space", "goto prev suggestion", { mac: true })).toBeNull();
  });

  // A ⌘ key for Next Suggestion acts on press (macOS sends no keyup while ⌘ is held).
  it("runs a non-Space suggestion key on press", () => {
    useAppStore.setState({ shortcutOverrides: { "goto next suggestion": ["$mod+KeyG"] } });
    renderHook(() => useKeyboardShortcuts());
    const ran: string[] = [];
    const original = commandContext.execute.bind(commandContext);
    commandContext.execute = ((cmd: { name?: string; label?: string }) => {
      ran.push(String(cmd.label ?? cmd.name));
    }) as never;
    try {
      press("KeyG", { mod: true });
    } finally {
      commandContext.execute = original;
    }
    expect(ran).toHaveLength(1);
  });

  // Shortcuts saved in another window reach this one, so this window
  // neither keeps the old keys nor writes them back over the new ones.
  it("takes shortcuts saved by another window", () => {
    const stop = syncShortcutsAcrossWindows();
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: PREFERENCES_STORAGE_KEY,
          newValue: JSON.stringify({ state: { shortcutOverrides: { save: ["$mod+KeyG"] } }, version: 0 }),
        }),
      );
    });
    stop();
    expect(useAppStore.getState().shortcutOverrides).toEqual({ save: ["$mod+KeyG"] });
  });

  // Hints (Labeling Tips, labeling hints, Label QC Review) name the user's key.
  it("names the user's key in hints", () => {
    useAppStore.setState({ shortcutOverrides: { "merge instance": ["KeyG"], "add instance": [] } });
    expect(shortcutText("merge instance")).toBe("G");
    expect(shortcutText("add instance")).toBe("no key");
  });
});
