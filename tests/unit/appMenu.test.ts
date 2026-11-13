/**
 * The app menu definition (`buildAppMenu`), which the menu bar, Search Menus
 * and the native menu all render from.
 */
import { describe, it, expect } from "../bun-test";
import { buildAppMenu, type MenuSnapshot } from "@/lib/menu/appMenu";
import { searchableCommands } from "@/lib/menu/searchable";
import type { AppMenu, MenuNode, TopMenu } from "@/lib/menu/types";

const BASE: MenuSnapshot = {
  isTauri: true,
  projectLoaded: true,
  hasProjectPath: true,
  videoNames: ["a.mp4", "b.mp4"],
  trackNames: ["mouse1", "mouse2"],
  hasInstance: true,
  hasClipboardInstance: true,
  skeletonHasNodes: true,
  undoLabel: "Undo Move Node",
  redoLabel: null,
  navigationDomain: "all",
  sidebarCollapsed: false,
  sidebarSide: "right",
  sidebarMultiPanel: false,
  fit: false,
  defaultToPan: false,
  placementMode: false,
  showInstances: true,
  showNonVisibleNodes: true,
  qcDisplayMode: "all",
  showLabels: true,
  showEdges: true,
  showQcFlags: true,
  showCrosshair: true,
  showInset: true,
  temporalLoupe: false,
  edgeStyle: "Line",
  markerSize: 4,
  poseOpacity: 100,
  nodeLabelSize: 10,
  trailLength: 0,
  palette: "standard",
  distinctlyColor: "auto",
  colorPredicted: false,
  showTrackScore: false,
  scrubProxyEnabled: false,
  hiddenPanels: [],
  instanceInitMethod: "best",
  showLabelingHints: true,
  frameIsNegative: false,
  hasFrameRange: false,
  totalLabeled: 3,
  totalInstances: 7,
  overlayModelCount: 0,
  overlayModelOutputs: false,
  propagateTrackLabels: true,
  seekbarHeaderGraph: "none",
};

function all(menu: AppMenu): MenuNode[] {
  const out: MenuNode[] = [];
  const walk = (nodes: MenuNode[]) => {
    for (const n of nodes) {
      out.push(n);
      if (n.kind === "submenu") walk(n.items);
    }
  };
  for (const top of menu) if (top.kind === "menu") walk(top.items);
  return out;
}

const find = (menu: AppMenu, id: string) => all(menu).find((n) => "id" in n && n.id === id);
const top = (menu: AppMenu, id: string) => menu.find((t) => t.id === id) as TopMenu;

describe("buildAppMenu", () => {
  it("has PyQt SLEAP's menus in its order, with Connect and Start Tutorial as buttons", () => {
    expect(buildAppMenu(BASE).map((t) => t.label)).toEqual([
      "File", "Go", "View", "Labels", "Analyze", "Tracks", "Predict",
      "Connect", "Start Tutorial", "Help",
    ]);
  });

  it("imports predictions through File ▸ Merge into Project, as legacy SLEAP does (no Predict item)", () => {
    // Legacy's "import predictions" action IS File ▸ Merge into Project...
    // (sleap/gui/app.py); its Predict menu has no import item. sleap-app used
    // to show a Predict ▸ Import Predictions... stub that only said "not yet
    // implemented" (audit bug B11).
    const menu = buildAppMenu(BASE);
    const labels = all(menu).map((n) => ("label" in n ? n.label : ""));
    expect(labels.some((l) => /import predictions/i.test(l))).toBe(false);
    expect(find(menu, "predict.importPredictions")).toBeUndefined();
    expect(top(menu, "file").items.map((n) => ("id" in n ? n.id : n.kind))).toContain("file.merge");
    expect(find(menu, "file.merge")).toMatchObject({ label: "Merge into Project..." });
  });

  it("has Panels under View, the clipboard and undo under Labels, Connect under Predict", () => {
    const menu = buildAppMenu(BASE);
    expect(find(menu, "view.panels")).toMatchObject({ kind: "submenu", label: "Panels" });
    expect(top(menu, "labels").items[0]).toMatchObject({ id: "labels.undo" });
    expect(find(menu, "labels.copyInstance")).toBeDefined();
    const predict = top(menu, "predict").items.map((n) => ("id" in n ? n.id : n.kind));
    expect(predict.slice(0, 3)).toEqual(["predict.training", "predict.inference", "predict.connect"]);
    expect(find(menu, "predict.connect")).toMatchObject({ label: "Connect (Remote Training / Inference)..." });
  });

  it("gives every node a unique id", () => {
    const ids = all(buildAppMenu(BASE)).flatMap((n) => ("id" in n ? [n.id] : []));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses only shortcuts made of known tokens", () => {
    const token = /^(\$mod|Shift|Alt|Control|Key[A-Z]|Digit\d|Arrow(Left|Right|Up|Down)|Backspace|Space|Backquote|Escape|Equal|Minus)$/;
    for (const n of all(buildAppMenu(BASE))) {
      if ((n.kind === "item" || n.kind === "check") && n.shortcut) {
        for (const t of n.shortcut.split("+")) expect(t).toMatch(token);
      }
    }
  });

  it("greys out project commands with no project", () => {
    const menu = buildAppMenu({ ...BASE, projectLoaded: false, hasInstance: false });
    expect(find(menu, "file.save")).toMatchObject({ enabled: false });
    expect(find(menu, "go.nextLabeled")).toMatchObject({ enabled: false });
    expect(find(menu, "file.open")).not.toMatchObject({ enabled: false });
  });

  it("names undo after the command, and disables redo with nothing to redo", () => {
    const menu = buildAppMenu(BASE);
    expect(find(menu, "labels.undo")).toMatchObject({ label: "Undo Move Node" });
    expect(find(menu, "labels.redo")).toMatchObject({ label: "Redo", enabled: false });
  });

  it("lists the project's videos and tracks, and drops track menus with no tracks", () => {
    const menu = buildAppMenu(BASE);
    expect(find(menu, "file.replaceVideo.1")).toMatchObject({ label: "b.mp4" });
    expect(find(menu, "tracks.setTrack.0")).toMatchObject({ label: "mouse1", shortcut: "$mod+Digit1" });
    const noTracks = buildAppMenu({ ...BASE, trackNames: [] });
    expect(find(noTracks, "tracks.setTrack")).toBeUndefined();
    expect(find(noTracks, "tracks.delete")).toBeUndefined();
  });

  it("only offers the desktop file commands on desktop", () => {
    expect(find(buildAppMenu(BASE), "file.reveal")).toBeDefined();
    expect(find(buildAppMenu({ ...BASE, isTauri: false }), "file.reveal")).toBeUndefined();
  });

  it("reflects checked state", () => {
    const menu = buildAppMenu({ ...BASE, hiddenPanels: ["labelingTips"], fit: true });
    expect(find(menu, "view.fit")).toMatchObject({ checked: true });
    expect(top(menu, "labels").items.at(-1)).toMatchObject({ text: "3 labeled frames, 7 instances" });
  });
});

describe("Predict ▸ Training… / Inference…", () => {
  it("open the panel and ask it for its Full Configuration window", async () => {
    const { useAppStore } = await import("@/stores/appStore");
    for (const panel of ["training", "inference"] as const) {
      const item = find(buildAppMenu(BASE), `predict.${panel}`);
      if (item?.kind !== "item") throw new Error("missing");
      await item.run();
      expect(useAppStore.getState().configDialogRequest).toBe(panel);
      expect(useAppStore.getState().sidebarOpenPanels).toContain(panel);
    }
  });
});

describe("searchableCommands", () => {
  const cmds = searchableCommands(buildAppMenu(BASE));
  const labels = cmds.map((c) => `${c.group}: ${c.label}`);

  it("names nested commands by their path, without the trailing dots", () => {
    expect(labels).toContain("File: Export › Analysis CSV › All Videos");
    expect(labels).toContain("File: Save As");
  });

  it("lists each radio choice, marking the current one", () => {
    const wedge = cmds.find((c) => c.label === "Edge Style: Wedge");
    const line = cmds.find((c) => c.label === "Edge Style: Line");
    expect(wedge?.checked).toBe(false);
    expect(line?.checked).toBe(true);
  });

  it("includes every menu, the top-level buttons, and the dynamic lists", () => {
    expect(new Set(cmds.map((c) => c.group))).toEqual(
      new Set(["File", "Go", "View", "Labels", "Analyze", "Tracks", "Predict", "Help"]),
    );
    expect(labels).toContain("Predict: Connect (Remote Training / Inference)");
    // Listed once (the in-window Connect button isn't a second entry).
    expect(labels.filter((l) => l.startsWith("Predict: Connect"))).toHaveLength(1);
    expect(labels).toContain("Help: Start Tutorial");
    expect(labels).toContain("Tracks: Delete Track › mouse2");
  });

  it("leaves out disabled commands and Search Menus itself", () => {
    expect(labels).not.toContain("Labels: Redo");
    expect(cmds.find((c) => c.id === "help.searchMenus")).toBeUndefined();
    expect(new Set(cmds.map((c) => c.id)).size).toBe(cmds.length);
  });

  it("has Labels ▸ Merge Instance after Delete Instance, on Shift+M (#merge-instance)", () => {
    const labels = top(buildAppMenu(BASE), "labels");
    const ids = labels.items.flatMap((n) => ("id" in n ? [n.id] : []));
    expect(ids.indexOf("labels.mergeInstance")).toBe(ids.indexOf("labels.deleteInstance") + 1);
    const item = find(buildAppMenu(BASE), "labels.mergeInstance");
    expect(item && "shortcut" in item ? item.shortcut : null).toBe("Shift+KeyM");
    const off = find(buildAppMenu({ ...BASE, hasInstance: false }), "labels.mergeInstance");
    expect(off && "enabled" in off ? off.enabled : null).toBe(false);
  });
});
