/**
 * ReplaceSkeletonDialog — link/rename table for importing a skeleton over an
 * existing one (#163). Port of PyQt's `ReplaceSkeletonTableDialog`
 * (`sleap/gui/dialogs/merge.py:428`).
 *
 * Given a {@link SkeletonDiff} (from {@link compareSkeletons}), the dialog shows
 * the nodes that will be deleted / added and lets the user LINK each new node to
 * an about-to-be-deleted old node — so that old node's instance points are
 * carried onto the renamed new node (instead of being dropped). It reports the
 * chosen `{newName: oldName}` link map via `onConfirm`.
 *
 * This component is PURE/controlled: it owns only the in-progress selection
 * state and never touches the store or executes commands — the caller (Task 4's
 * SkeletonPanel) runs `OpenSkeletonCommand` with the returned link map.
 *
 * The link/rename LOGIC is factored into the exported pure helpers
 * {@link newSkeletonNodes}, {@link unusedDeleteNodes}, and {@link computeLinkMap}
 * so it is unit-testable without driving the Radix `<Select>` popover (which is
 * unreliable under happy-dom).
 */

import { useEffect, useMemo, useState } from "react";
import type { SkeletonDiff } from "@/lib/skeletonIO";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";

export interface ReplaceSkeletonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Node-name diff between the current and the imported skeleton. */
  diff: SkeletonDiff;
  /** Display name of the imported skeleton (optional, for the message). */
  newSkeletonName?: string;
  /** Called with the link map `newName -> oldName` when Replace is confirmed. */
  onConfirm: (linkMap: Map<string, string>) => void;
}

/**
 * Radix `<Select>` forbids an empty-string item value, so the "unlinked" option
 * uses this sentinel internally and is mapped back to `""` everywhere else.
 */
const UNLINKED = "__none__";

/**
 * The new skeleton's node names in table-row order: kept (rename) nodes first,
 * then added nodes. Port of `new_skeleton_nodes = rename_nodes + add_nodes`.
 */
export function newSkeletonNodes(diff: SkeletonDiff): string[] {
  return [...diff.renameNodes, ...diff.addNodes];
}

/**
 * The `deleteNodes` still available to link (not yet chosen by another row).
 * Port of `find_unused_nodes` — mutual exclusion across the combo boxes. Empty
 * (`""`) selections do not consume an option.
 *
 * @param selections newName -> chosen oldName ("" = unlinked).
 */
export function unusedDeleteNodes(
  diff: SkeletonDiff,
  selections: Map<string, string>,
): string[] {
  const used = new Set<string>();
  for (const old of selections.values()) {
    if (old !== "") used.add(old);
  }
  return diff.deleteNodes.filter((name) => !used.has(name));
}

/**
 * Build the link map `{newName: oldName}` from the current selections. Port of
 * `get_table_data`:
 *   - keep an entry only where `old !== "" && new !== old`;
 *   - reject the bipartite conflict where a produced mapping's NEW name is
 *     itself an existing skeleton node (`renameNodes ∪ deleteNodes`) — PyQt's
 *     "rename existing node manually first" `ValueError`.
 *
 * @throws Error on the bipartite conflict (caller surfaces it inline).
 */
export function computeLinkMap(
  diff: SkeletonDiff,
  selections: Map<string, string>,
): Map<string, string> {
  // skeleton_nodes = rename_nodes + delete_nodes (the OLD/existing skeleton).
  const skeletonNodes = new Set([...diff.renameNodes, ...diff.deleteNodes]);

  const entries: Array<[string, string]> = [];
  for (const [newNode, oldNode] of selections) {
    if (oldNode !== "" && newNode !== oldNode) {
      entries.push([newNode, oldNode]);
    }
  }

  // PyQt sorts so mappings whose NEW name is NOT an existing skeleton node come
  // first, then flags a conflict if the first entry's NEW name is an existing
  // node (i.e. the user tried to rename a kept node onto a deleted one without
  // first manually renaming the kept node).
  //
  // DEFENSIVE — this guard is UNREACHABLE via the current UI: every editable row
  // is an ADDED node (kept/rename rows render as static "— (kept)" labels and
  // never produce a selection), so a produced mapping's NEW name is never in
  // `renameNodes ∪ deleteNodes`. It is retained for PyQt parity and to stay
  // correct if kept rows ever become editable — do NOT try to reproduce it
  // interactively, and do not "simplify" it away. (Unit-tested directly.)
  entries.sort(
    (a, b) => Number(skeletonNodes.has(a[0])) - Number(skeletonNodes.has(b[0])),
  );
  if (entries.length > 0) {
    const [firstNew, firstOld] = entries[0];
    if (skeletonNodes.has(firstNew)) {
      throw new Error(
        `Cannot rename skeleton node '${firstOld}' to already existing node ` +
          `'${firstNew}'. Please rename existing skeleton node '${firstNew}' ` +
          `manually before linking.`,
      );
    }
  }

  return new Map(entries);
}

export function ReplaceSkeletonDialog({
  open,
  onOpenChange,
  diff,
  newSkeletonName,
  onConfirm,
}: ReplaceSkeletonDialogProps) {
  // newName -> chosen oldName ("" = unlinked). Only added-node rows are editable
  // (kept/rename rows auto-link to themselves and render as a static label).
  const [selections, setSelections] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);

  // Self-heal across `diff` changes: if the caller keeps this dialog mounted and
  // swaps `diff` for a second import, drop the prior import's selections/error so
  // stale links (which may reference old-node names absent from the new diff)
  // never bleed into the next link map.
  useEffect(() => {
    setSelections(new Map());
    setError(null);
  }, [diff]);

  const rows = useMemo(() => newSkeletonNodes(diff), [diff]);
  const renameSet = useMemo(
    () => new Set(diff.renameNodes),
    [diff.renameNodes],
  );

  const handleSelect = (newNode: string, value: string) => {
    const old = value === UNLINKED ? "" : value;
    setSelections((prev) => {
      const next = new Map(prev);
      if (old === "") next.delete(newNode);
      else next.set(newNode, old);
      return next;
    });
    setError(null);
  };

  const handleCancel = () => {
    onOpenChange(false);
  };

  const handleReplace = () => {
    let linkMap: Map<string, string>;
    try {
      linkMap = computeLinkMap(diff, selections);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return; // keep dialog open so the user can fix the conflict
    }
    onConfirm(linkMap);
    onOpenChange(false);
  };

  const deleteSummary =
    diff.deleteNodes.length > 0 ? diff.deleteNodes.join(", ") : null;
  const addSummary = diff.addNodes.length > 0 ? diff.addNodes.join(", ") : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Replace Nodes</DialogTitle>
          <DialogDescription>
            Pre-existing skeleton found
            {newSkeletonName ? ` — replacing with "${newSkeletonName}"` : ""}.
            Link old nodes to new nodes to preserve their instance points.
          </DialogDescription>
        </DialogHeader>

        {/* Change summary (port of merge.py's dynamic message). */}
        <div className="text-xs text-muted-foreground space-y-1">
          {deleteSummary ? (
            <p>
              These nodes will be <span className="font-medium">deleted</span>{" "}
              from all instances:{" "}
              <span className="text-foreground">{deleteSummary}</span>
            </p>
          ) : (
            <p>No nodes will be deleted.</p>
          )}
          {addSummary ? (
            <p>
              These nodes will be <span className="font-medium">added</span> to
              all instances:{" "}
              <span className="text-foreground">{addSummary}</span>
            </p>
          ) : (
            <p>No nodes will be added.</p>
          )}
        </div>

        {/* [&_[data-slot=table-container]]:overflow-visible neutralizes
            Table's own overflow-x-auto wrapper, which otherwise counts as
            its own scroll container and steals the sticky thead's "nearest
            scrolling ancestor" — making sticky a no-op. */}
        {rows.length > 0 && (
          <div className="max-h-72 overflow-auto rounded-md border border-border/40 [&_[data-slot=table-container]]:overflow-visible">
            <Table className="border-separate border-spacing-0">
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow className="border-b hover:bg-transparent">
                  <TableHead className="py-1 px-2 text-xs font-normal h-auto border-b">
                    New
                  </TableHead>
                  <TableHead className="py-1 px-2 text-xs font-normal h-auto border-b">
                    Old
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((newNode) => {
                  const isKept = renameSet.has(newNode);
                  const selected = selections.get(newNode) ?? "";
                  // Options for THIS row: the unused delete nodes, plus the row's
                  // own current selection (so it stays visible after exclusion).
                  const options = unusedDeleteNodes(diff, selections);
                  const optionNames =
                    selected && !options.includes(selected)
                      ? [selected, ...options]
                      : options;
                  return (
                    <TableRow
                      key={newNode}
                      className="border-b-0 hover:bg-transparent"
                    >
                      <TableCell className="py-0.5 px-2 text-xs text-foreground">
                        {newNode}
                      </TableCell>
                      <TableCell className="py-0.5 px-2 text-xs">
                        {isKept ? (
                          <span className="text-muted-foreground">
                            — (kept)
                          </span>
                        ) : (
                          <Select
                            value={selected === "" ? UNLINKED : selected}
                            onValueChange={(v) => handleSelect(newNode, v)}
                          >
                            <SelectTrigger
                              className="w-full h-7 text-xs"
                              size="sm"
                              aria-label={`Link for ${newNode}`}
                            >
                              <SelectValue placeholder="(unlinked)" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value={UNLINKED}>(unlinked)</SelectItem>
                              {optionNames.map((name) => (
                                <SelectItem key={name} value={name}>
                                  {name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {error && <p className="text-xs text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={handleCancel}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleReplace}>
            Replace
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
