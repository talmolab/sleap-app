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

    const send = async () => {
      if (!latest || disposed) return;
      const spec = toNativeSpec(latest);
      const json = JSON.stringify(spec);
      if (json === sent) return; // nothing visible changed
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

    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<string>("app-menu", (e) => {
        if (latest) runNativeMenuItem(latest, e.payload);
      }).then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      }),
    );

    return () => {
      disposed = true;
      clearTimeout(timer);
      unsubscribe();
      unlisten?.();
      setNativeMenuShortcuts([]);
    };
  }, []);
}
