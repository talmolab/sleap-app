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
  showCrosshair: true,
  showInset: true,
  edgeStyle: "Line",
  markerSize: 4,
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
  it("has the menus in order, with Connect and Start Tutorial as buttons", () => {
    expect(buildAppMenu(BASE).map((t) => t.label)).toEqual([
      "File", "Edit", "Go", "View", "Panels", "Labels", "Predict", "Tracks", "Analyze",
      "Connect", "Start Tutorial", "Help",
    ]);
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
    expect(find(menu, "edit.undo")).toMatchObject({ label: "Undo Move Node" });
    expect(find(menu, "edit.redo")).toMatchObject({ label: "Redo", enabled: false });
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
      new Set(["File", "Edit", "Go", "View", "Panels", "Labels", "Predict", "Tracks", "Analyze", "Help"]),
    );
    expect(labels).toContain("Predict: Connect");
    expect(labels).toContain("Help: Start Tutorial");
    expect(labels).toContain("Tracks: Delete Track › mouse2");
  });

  it("leaves out disabled commands and Search Menus itself", () => {
    expect(labels).not.toContain("Edit: Redo");
    expect(cmds.find((c) => c.id === "help.searchMenus")).toBeUndefined();
    expect(new Set(cmds.map((c) => c.id)).size).toBe(cmds.length);
  });
});
