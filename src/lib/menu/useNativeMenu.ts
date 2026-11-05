/**
 * Installs the native menu bar (macOS desktop) and keeps it in step with the
 * app: rebuilt from the app menu definition when what it shows changes, and
 * clicks routed back to the menu commands. See nativeMenu.ts.
 */

import { useEffect } from "react";
import { sleapCmd } from "@/lib/sleapPlugin";
import { subscribeAppMenu } from "./useAppMenu";
import { runNativeMenuItem, toAccelerator, toNativeSpec } from "./nativeMenu";
import { setNativeMenuShortcuts } from "./nativeMenuOwnership";
import type { AppMenu, MenuNode } from "./types";
import { NATIVE_MENU_BAR } from "./nativeMenuBar";

/** Where the page's single menu-click listener is kept (survives hot reloads). */
const menuWindow = window as Window & { __sleapNativeMenuUnlisten?: () => void };

/** Coalesce bursts of changes (e.g. a frame change) into one rebuild. */
const REBUILD_DELAY_MS = 50;

/** The shortcuts the native menu owns, for the app's key handler to skip. */
function ownedShortcuts(menu: AppMenu): string[] {
  const out = ["$mod+KeyQ"]; // SLEAP ▸ Quit, in the application menu
  const walk = (nodes: MenuNode[]) => {
    for (const n of nodes) {
      if ((n.kind === "item" || n.kind === "check") && toAccelerator(n.shortcut)) {
        out.push(n.shortcut!);
      }
      if (n.kind === "submenu") walk(n.items);
    }
  };
  for (const top of menu) if (top.kind === "menu") walk(top.items);
  return out;
}

export function useNativeMenu() {
  useEffect(() => {
    if (!NATIVE_MENU_BAR) return;
    let latest: AppMenu | null = null;
    let sent = "";
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    // The menu bar is shared by every SLEAP window: only the focused one
    // drives it (and takes over when it gains focus), so the menu never shows
    // another window's state.
    const send = async (force = false) => {
      if (!latest || disposed || !document.hasFocus()) return;
      const spec = toNativeSpec(latest);
      const json = JSON.stringify(spec);
      if (json === sent && !force) return; // nothing visible changed
      sent = json;
      setNativeMenuShortcuts(ownedShortcuts(latest));
      try {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke(sleapCmd("set_app_menu"), { spec });
      } catch (e) {
        sent = "";
        console.error("[menu] couldn't update the native menu bar:", e);
      }
    };

    const unsubscribe = subscribeAppMenu((menu) => {
      latest = menu;
      clearTimeout(timer);
      timer = setTimeout(() => void send(), REBUILD_DELAY_MS);
    });

    const onFocus = () => void send(true);
    window.addEventListener("focus", onFocus);

    let unlisten: (() => void) | undefined;
    // This window's own listener: Rust sends a click to the window it was
    // made in (the focused one). The global `listen` from
    // @tauri-apps/api/event would hear clicks meant for EVERY window, so each
    // open window ran the command (Merge into Project, Connect, …).
    void import("@tauri-apps/api/webviewWindow").then(({ getCurrentWebviewWindow }) =>
      getCurrentWebviewWindow().listen<string>("app-menu", (e) => {
        if (latest) runNativeMenuItem(latest, e.payload);
      }).then((fn) => {
        if (disposed) {
          fn();
          return;
        }
        // One listener per page, ever: a listener left behind (a hot reload
        // that failed mid-way, a double mount) would run each click again —
        // e.g. one file picker per stray listener for File ▸ Open Project.
        menuWindow.__sleapNativeMenuUnlisten?.();
        menuWindow.__sleapNativeMenuUnlisten = fn;
        unlisten = fn;
      }),
    );

    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribe();
      window.removeEventListener("focus", onFocus);
      unlisten?.();
      if (menuWindow.__sleapNativeMenuUnlisten === unlisten) {
        menuWindow.__sleapNativeMenuUnlisten = undefined;
      }
      setNativeMenuShortcuts([]);
    };
  }, []);
}
