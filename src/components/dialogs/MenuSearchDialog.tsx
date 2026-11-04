/**
 * Menu command palette ("Search the menus", #278).
 *
 * A filterable list of every menu command: typing filters by label/menu;
 * Up/Down move the highlight and Enter runs the highlighted command (clicking
 * runs it too). The list comes from the same menu definition the menu bar
 * renders (`buildAppMenu`), so it can't drift from the menus, and each entry
 * runs exactly what the menu item does.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { formatShortcut } from "@/lib/formatShortcut";
import { currentAppMenu } from "@/lib/menu/useAppMenu";
import { searchableCommands, type SearchableCommand as MenuAction } from "@/lib/menu/searchable";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function MenuSearchDialog() {
  const open = useAppStore((s) => s.menuSearchDialogOpen);
  const setOpen = useAppStore((s) => s.setMenuSearchDialogOpen);

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  // Read when the palette opens: enabled/checked state and the track/video
  // lists are those of the moment.
  const actions = useMemo(
    () => (open ? searchableCommands(currentAppMenu()) : []),
    [open],
  );
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return actions;
    return actions.filter(
      (a) =>
        a.label.toLowerCase().includes(q) ||
        a.group.toLowerCase().includes(q),
    );
  }, [actions, query]);

  // Reset the query/highlight each time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  // Keep the highlight in range as the filter narrows.
  useEffect(() => {
    setActive((a) => (a >= filtered.length ? 0 : a));
  }, [filtered.length]);

  const runAction = (a: MenuAction | undefined) => {
    if (!a) return;
    setOpen(false);
    // Defer so this palette fully unmounts before an action that opens another
    // dialog mounts — avoids two Radix dialogs fighting over focus.
    requestAnimationFrame(() => a.run());
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runAction(filtered[active]);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        className="p-0 gap-0 overflow-hidden sm:max-w-[560px]"
      >
        <DialogTitle className="sr-only">Search menus</DialogTitle>
        <div className="relative border-b border-border">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search menus..."
            aria-label="Filter menu commands"
            className="h-11 rounded-none border-0 pl-9 text-sm shadow-none focus-visible:ring-0"
          />
        </div>
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <p className="px-3 py-6 text-center text-xs text-muted-foreground">
              No matching commands.
            </p>
          ) : (
            filtered.map((a, i) => (
              <button
                key={a.id}
                type="button"
                onClick={() => runAction(a)}
                onMouseMove={() => setActive(i)}
                className={cn(
                  "flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left text-sm",
                  i === active
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground",
                )}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground w-14">
                    {a.group}
                  </span>
                  <span className="truncate">{a.label}</span>
                  {a.checked && (
                    <span className="shrink-0 text-[10px] text-muted-foreground">✓ on</span>
                  )}
                </span>
                {a.shortcut && (
                  <kbd className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {formatShortcut(a.shortcut)}
                  </kbd>
                )}
              </button>
            ))
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
