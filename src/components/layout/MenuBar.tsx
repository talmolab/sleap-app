/**
 * The in-window menu bar, rendered from the app menu definition
 * (`buildAppMenu` in `src/lib/menu/`), which Search Menus and the native menu
 * share — so all three show the same items.
 */

import type { ReactNode } from "react";
import { isTauri } from "../../lib/platform";
import { APP_VERSION, APP_VERSION_KIND_LABEL } from "@/lib/version";
import { formatShortcut } from "@/lib/formatShortcut";
import { useAppMenu } from "@/lib/menu/useAppMenu";
import type { MenuNode, TopMenu } from "@/lib/menu/types";
import {
  Menubar,
  MenubarMenu,
  MenubarTrigger,
  MenubarContent,
  MenubarItem,
  MenubarSeparator,
  MenubarCheckboxItem,
  MenubarShortcut,
  MenubarLabel,
  MenubarSub,
  MenubarSubTrigger,
  MenubarSubContent,
  MenubarRadioGroup,
  MenubarRadioItem,
} from "@/components/ui/menubar";
import { Button } from "@/components/ui/button";

export function MenuBar() {
  const menu = useAppMenu();
  return (
    <Menubar
      className={`h-8 rounded-none border-0 border-b border-border bg-card pr-0 gap-0 shadow-none ${
        // Web deployments have no OS title bar to carry the app's identity, so
        // show a SLEAP icon + wordmark on the left. The desktop (Tauri) build
        // already has a native title bar showing "SLEAP", so it's hidden there
        // to avoid the redundancy that removed it originally (#133 / #142).
        isTauri ? "pl-2" : "pl-0"
      }`}
    >
      {!isTauri && (
        <div className="flex items-baseline gap-1.5 px-3 text-sm font-semibold tracking-wider text-primary select-none">
          <img
            src={`${import.meta.env.BASE_URL}icon.png`}
            alt=""
            className="h-4 w-4 self-center"
          />
          <span>SLEAP</span>
          {/* The desktop shell gets its version from the native title bar
              ("SLEAP v1.2.3"), which the web has no equivalent of -- a browser
              tab title is usually truncated to the point of being unreadable.
              So carry it here instead, in the block that exists for exactly
              this reason (#133 / #142). Same @/lib/version source as the title
              and the About dialog, so a deployed path can't misreport itself.
              `title` spells out the channel wording rather than crowding the
              bar with it. */}
          <span
            className="text-[10px] font-normal tracking-normal text-muted-foreground select-text"
            title={`SLEAP v${APP_VERSION} — ${APP_VERSION_KIND_LABEL}`}
            data-testid="menubar-version"
          >
            v{APP_VERSION}
          </span>
        </div>
      )}
      {menu.map((top) =>
        top.kind === "action" ? (
          <Button
            key={top.id}
            variant="ghost"
            size="sm"
            className="h-8 rounded-none px-3 text-xs font-normal"
            onClick={() => void top.run()}
          >
            {top.label}
          </Button>
        ) : (
          <TopMenuView key={top.id} menu={top} />
        ),
      )}
    </Menubar>
  );
}

function TopMenuView({ menu }: { menu: TopMenu }) {
  return (
    <MenubarMenu>
      <MenubarTrigger
        className="px-3 h-8 text-xs rounded-none"
        data-tutorial={menu.tutorialId}
      >
        {menu.label}
      </MenubarTrigger>
      <MenubarContent
        className={
          // Long menus (View) are capped to the viewport and scroll so items
          // near the bottom stay reachable on short screens.
          menu.scroll
            ? "max-h-(--radix-menubar-content-available-height) overflow-x-hidden overflow-y-auto"
            : undefined
        }
      >
        <Nodes nodes={menu.items} />
      </MenubarContent>
    </MenubarMenu>
  );
}

function Shortcut({ binding, hint }: { binding?: string; hint?: string }) {
  if (binding) return <MenubarShortcut>{formatShortcut(binding)}</MenubarShortcut>;
  if (hint) return <MenubarShortcut className="text-xs opacity-60">{hint}</MenubarShortcut>;
  return null;
}

function Nodes({ nodes }: { nodes: MenuNode[] }) {
  return <>{nodes.map((node, i) => <NodeView key={"id" in node ? node.id : `sep-${i}`} node={node} />)}</>;
}

function NodeView({ node }: { node: MenuNode }): ReactNode {
  switch (node.kind) {
    case "separator":
      return <MenubarSeparator />;
    case "label":
      return (
        <MenubarLabel className="text-xs text-muted-foreground font-normal">
          {node.text}
        </MenubarLabel>
      );
    case "item":
      return (
        <MenubarItem
          disabled={node.enabled === false}
          title={node.title}
          onClick={() => void node.run()}
        >
          {node.label} <Shortcut binding={node.shortcut} hint={node.hint} />
        </MenubarItem>
      );
    case "check":
      return (
        <MenubarCheckboxItem
          checked={node.checked}
          disabled={node.enabled === false}
          title={node.title}
          onSelect={node.keepOpen ? (e) => e.preventDefault() : undefined}
          onCheckedChange={() => void node.run()}
        >
          {node.label} <Shortcut binding={node.shortcut} />
        </MenubarCheckboxItem>
      );
    case "radio":
      return (
        <MenubarRadioGroup value={node.value} onValueChange={node.select}>
          {node.options.map((o) => (
            <MenubarRadioItem key={o.value} value={o.value} disabled={o.enabled === false}>
              {o.label}
            </MenubarRadioItem>
          ))}
        </MenubarRadioGroup>
      );
    case "submenu":
      return (
        <MenubarSub>
          <MenubarSubTrigger disabled={node.enabled === false}>{node.label}</MenubarSubTrigger>
          <MenubarSubContent>
            {node.scroll ? (
              // Bounded, scrollable so long lists (many videos or tracks)
              // don't overflow the screen (the sub-content is overflow-hidden).
              <div className="max-h-[60vh] overflow-y-auto">
                <Nodes nodes={node.items} />
              </div>
            ) : (
              <Nodes nodes={node.items} />
            )}
          </MenubarSubContent>
        </MenubarSub>
      );
  }
}
