/**
 * The native menu bar's data (`toNativeSpec`) and click routing
 * (`runNativeMenuItem`), built from the shared app menu definition.
 */
import { describe, it, expect } from "../bun-test";
import { runNativeMenuItem, toAccelerator, toNativeSpec, type NativeNode } from "@/lib/menu/nativeMenu";
import type { AppMenu } from "@/lib/menu/types";

const calls: string[] = [];
const MENU: AppMenu = [
  {
    kind: "menu",
    id: "file",
    label: "File",
    items: [
      { kind: "item", id: "file.save", label: "Save", shortcut: "$mod+KeyS", run: () => void calls.push("save") },
      { kind: "item", id: "file.saveAs", label: "Save As...", shortcut: "$mod+Shift+KeyS", enabled: false, run: () => void calls.push("saveAs") },
      { kind: "separator" },
      { kind: "item", id: "file.quit", label: "Quit", shortcut: "$mod+KeyQ", run: () => void calls.push("quit") },
    ],
  },
  {
    kind: "menu",
    id: "go",
    label: "Go",
    items: [
      { kind: "item", id: "go.nextSuggestion", label: "Next Suggestion", shortcut: "Space", run: () => void calls.push("next") },
      { kind: "item", id: "go.lastInteracted", label: "Last Interacted Frame", shortcut: "$mod+KeyA", run: () => void calls.push("last") },
      {
        kind: "submenu",
        id: "go.more",
        label: "More",
        items: [
          { kind: "radio", id: "go.domain", value: "all", options: [{ value: "all", label: "All" }, { value: "labeled", label: "Labeled" }], select: (v) => void calls.push(`domain=${v}`) },
          { kind: "label", id: "go.count", text: "3 frames" },
        ],
      },
    ],
  },
  { kind: "menu", id: "predict", label: "Predict", items: [{ kind: "item", id: "predict.training", label: "Training...", run: () => {} }] },
  { kind: "action", id: "connect", label: "Connect", searchGroup: "Predict", run: () => void calls.push("connect") },
  { kind: "action", id: "tutorial", label: "Start Tutorial", searchGroup: "Help", run: () => {} },
  { kind: "menu", id: "help", label: "Help", items: [{ kind: "item", id: "help.about", label: "About", run: () => {} }] },
];

const byId = (nodes: NativeNode[], id: string): NativeNode | undefined => {
  for (const n of nodes) {
    if ("id" in n && n.id === id) return n;
    if (n.kind === "submenu") {
      const inner = byId(n.items, id);
      if (inner) return inner;
    }
  }
  return undefined;
};

describe("toAccelerator", () => {
  it("turns ⌘ bindings into Tauri accelerators", () => {
    expect(toAccelerator("$mod+Shift+KeyS")).toBe("CmdOrCtrl+Shift+S");
    expect(toAccelerator("$mod+Digit3")).toBe("CmdOrCtrl+3");
    expect(toAccelerator("$mod+Shift+Backspace")).toBe("CmdOrCtrl+Shift+Backspace");
  });

  it("leaves bare keys, ⌥/⇧-only combos and text-editing keys to the app", () => {
    for (const b of ["Space", "KeyP", "Escape", "Alt+ArrowRight", "Shift+Space", "$mod+KeyZ", "$mod+KeyC", "$mod+KeyV", "$mod+KeyA"]) {
      expect(toAccelerator(b)).toBeUndefined();
    }
  });
});

describe("toNativeSpec", () => {
  const spec = toNativeSpec(MENU);
  const file = spec.menus.find((m) => m.id === "file")!.items;
  const go = spec.menus.find((m) => m.id === "go")!.items;

  it("keeps the menus, without the in-window buttons as menus", () => {
    expect(spec.menus.map((m) => m.id)).toEqual(["file", "go", "predict", "help"]);
  });

  it("gives ⌘ items accelerators and carries enabled state", () => {
    expect(byId(file, "file.save")).toMatchObject({ accelerator: "CmdOrCtrl+S", enabled: true });
    expect(byId(file, "file.saveAs")).toMatchObject({ enabled: false });
  });

  it("drops File ▸ Quit (the application menu has it) and the separator it leaves", () => {
    expect(byId(file, "file.quit")).toBeUndefined();
    expect(file.at(-1)?.kind).not.toBe("separator");
  });

  it("shows app-owned shortcuts as a hint after the label", () => {
    const next = byId(go, "go.nextSuggestion");
    expect(next).toMatchObject({ label: "Next Suggestion    Space" });
    expect(next && "accelerator" in next ? next.accelerator : undefined).toBeUndefined();
    expect(byId(go, "go.lastInteracted")).toMatchObject({ accelerator: undefined });
  });

  it("turns radio choices into check items and labels into disabled items", () => {
    expect(byId(go, "go.domain=all")).toMatchObject({ kind: "check", checked: true });
    expect(byId(go, "go.domain=labeled")).toMatchObject({ kind: "check", checked: false });
    expect(byId(go, "go.count")).toMatchObject({ kind: "item", label: "3 frames", enabled: false });
  });

  it("puts Connect at the end of Predict and Start Tutorial at the top of Help", () => {
    const predict = spec.menus.find((m) => m.id === "predict")!.items;
    const help = spec.menus.find((m) => m.id === "help")!.items;
    expect(predict.at(-1)).toMatchObject({ id: "connect", label: "Connect" });
    expect(help[0]).toMatchObject({ id: "tutorial", label: "Start Tutorial" });
  });
});

describe("runNativeMenuItem", () => {
  it("runs items, radio choices and the in-window buttons by id", () => {
    calls.length = 0;
    expect(runNativeMenuItem(MENU, "file.save")).toBe(true);
    expect(runNativeMenuItem(MENU, "go.domain=labeled")).toBe(true);
    expect(runNativeMenuItem(MENU, "connect")).toBe(true);
    expect(runNativeMenuItem(MENU, "file.quit")).toBe(true); // from the application menu
    expect(calls).toEqual(["save", "domain=labeled", "connect", "quit"]);
  });

  it("ignores disabled items and ids it doesn't know (system items)", () => {
    calls.length = 0;
    expect(runNativeMenuItem(MENU, "file.saveAs")).toBe(false);
    expect(runNativeMenuItem(MENU, "copy")).toBe(false);
    expect(calls).toEqual([]);
  });
});
