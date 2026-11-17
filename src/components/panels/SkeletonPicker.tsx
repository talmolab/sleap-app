/**
 * Skeleton panel header: which skeleton you're editing, plus Add / Rename.
 *
 * A project can hold several skeletons (e.g. a mouse skeleton and a 1-node
 * pellet skeleton on the same video). The ACTIVE skeleton (`appStore.skeleton`)
 * is the one the rest of the Skeleton panel edits and the one new instances get.
 * With a single skeleton this shows just its name, as before; the dropdown
 * appears once there are two or more.
 */

import { useState } from "react";
import { Pencil, Plus } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { commandContext } from "../../commands/CommandContext";
import {
  AddSkeletonCommand,
  RenameSkeletonCommand,
} from "../../commands/skeletonCommands";
import {
  isValidSkeletonName,
  nextSkeletonName,
  skeletonDisplayName,
} from "@/lib/multiSkeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type NameDialog = { mode: "add" | "rename"; value: string } | null;

export function SkeletonPicker() {
  const labels = useAppStore((s) => s.labels);
  const active = useAppStore((s) => s.skeleton);
  // `labels.skeletons` is mutated in place (Add pushes, undo reassigns), and
  // renames mutate a skeleton in place: re-render on the count and on edits.
  useAppStore((s) => s.labels?.skeletons.length ?? 0);
  useAppStore((s) => s.editSeq);
  useAppStore((s) => s.overlayVersion);
  const setActiveSkeleton = useAppStore((s) => s.setActiveSkeleton);
  const [dialog, setDialog] = useState<NameDialog>(null);

  const skeletons = labels?.skeletons ?? [];
  const activeIdx = active ? skeletons.indexOf(active) : -1;
  const multi = skeletons.length > 1;

  const nodeCount = active?.nodes.length ?? 0;
  const edgeCount = active?.edges.length ?? 0;

  const dialogValid =
    !!dialog &&
    isValidSkeletonName(
      dialog.value,
      skeletons,
      dialog.mode === "rename" ? active : null,
    );

  const submit = () => {
    if (!dialog || !dialogValid) return;
    if (dialog.mode === "add") {
      commandContext.execute(AddSkeletonCommand, { name: dialog.value.trim() });
    } else {
      commandContext.execute(RenameSkeletonCommand, {
        newName: dialog.value.trim(),
      });
    }
    setDialog(null);
  };

  return (
    <div className="px-2 py-1.5 border-b border-border">
      <div className="flex items-center gap-1">
        {multi ? (
          <Select
            value={activeIdx >= 0 ? String(activeIdx) : undefined}
            onValueChange={(v) => {
              const next = skeletons[Number(v)];
              if (next) setActiveSkeleton(next);
            }}
          >
            <SelectTrigger
              className="flex-1 min-w-0 h-7 text-xs"
              size="sm"
              aria-label="Active skeleton"
              data-testid="skeleton-picker"
            >
              <SelectValue placeholder="Choose a skeleton" />
            </SelectTrigger>
            <SelectContent>
              {skeletons.map((sk, i) => (
                <SelectItem key={i} value={String(i)}>
                  {skeletonDisplayName(sk, skeletons)}{" "}
                  <span className="text-muted-foreground">
                    ({sk.nodes.length} node{sk.nodes.length !== 1 ? "s" : ""})
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="flex-1 min-w-0 truncate text-xs font-medium text-foreground">
            {active?.name || "Unnamed skeleton"}
          </div>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          title="Rename skeleton"
          aria-label="Rename skeleton"
          disabled={!active}
          onClick={() => setDialog({ mode: "rename", value: active?.name ?? "" })}
        >
          <Pencil />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          title="Add another skeleton to this project (e.g. a 1-node centroid for objects)"
          aria-label="Add skeleton"
          disabled={!labels}
          onClick={() =>
            setDialog({ mode: "add", value: nextSkeletonName(skeletons) })
          }
        >
          <Plus />
        </Button>
      </div>
      <div className="text-xs text-muted-foreground">
        {nodeCount} node{nodeCount !== 1 ? "s" : ""},{" "}
        {edgeCount} edge{edgeCount !== 1 ? "s" : ""}
        {multi && (
          <>
            {" "}· {skeletons.length} skeletons in project; new instances use
            this one
          </>
        )}
      </div>

      <Dialog open={dialog !== null} onOpenChange={(o) => !o && setDialog(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {dialog?.mode === "add" ? "Add Skeleton" : "Rename Skeleton"}
            </DialogTitle>
            <DialogDescription>
              {dialog?.mode === "add"
                ? "Add another skeleton to this project, e.g. a 1-node centroid for objects. It starts empty and becomes the active skeleton: add nodes or load a template, then add instances of it."
                : "Enter a new name for this skeleton."}
            </DialogDescription>
          </DialogHeader>
          <Input
            value={dialog?.value ?? ""}
            onChange={(e) =>
              setDialog((d) => (d ? { ...d, value: e.target.value } : d))
            }
            placeholder="Skeleton name"
            aria-label="Skeleton name"
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
            }}
            autoFocus
          />
          {dialog && dialog.value.trim() && !dialogValid && (
            <p className="text-xs text-destructive">
              A skeleton with this name already exists.
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button size="sm" onClick={submit} disabled={!dialogValid}>
              {dialog?.mode === "add" ? "Add" : "Rename"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
