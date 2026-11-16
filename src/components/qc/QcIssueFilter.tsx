/**
 * Label QC issue-type filter: a button with a menu of checkboxes, one per
 * issue type flagged (PyQt's "Issue types: all" button). Unticking a type
 * hides its flags everywhere: the dialog's tables, the panel's list, the
 * Review window, F / Shift+F and the boxes on the video. Session only.
 */
import { useMemo } from "react";
import { ListFilter } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useQcStore } from "@/stores/qcStore";
import { qcIssueTypes } from "@/lib/analyze/qc/settings";

/** The button's caption for `shown` of `total` issue types ticked. */
export function issueFilterCaption(shown: number, total: number): string {
  if (total === 0 || shown === total) return "Issue types: all";
  if (shown === 0) return "Issue types: none";
  return `Issue types: ${shown} of ${total}`;
}

export function QcIssueFilter({ className }: { className?: string }) {
  const findings = useQcStore((s) => s.findings);
  const anomaly = useQcStore((s) => s.anomaly);
  const settings = useQcStore((s) => s.settings);
  const hidden = useQcStore((s) => s.hiddenIssues);
  const setHidden = useQcStore((s) => s.setHiddenIssues);
  const types = useMemo(() => qcIssueTypes(findings, anomaly, settings), [findings, anomaly, settings]);
  const shown = types.filter((t) => !hidden.has(t.type)).length;

  const toggle = (type: string, on: boolean) => {
    const next = new Set(hidden);
    if (on) next.delete(type);
    else next.add(type);
    setHidden(next);
  };
  // Keep the menu open while ticking (PyQt's CheckableFilterMenu).
  const keepOpen = (e: Event) => e.preventDefault();
  const group = (g: "rule" | "pose", label: string) => {
    const items = types.filter((t) => t.group === g);
    if (items.length === 0) return null;
    return (
      <>
        <DropdownMenuLabel className="text-[10px] font-medium text-muted-foreground">
          {label}
        </DropdownMenuLabel>
        {items.map((t) => (
          <DropdownMenuCheckboxItem
            key={t.type}
            checked={!hidden.has(t.type)}
            onCheckedChange={(on) => toggle(t.type, on === true)}
            onSelect={keepOpen}
            className="text-[11px]"
          >
            <span className="flex-1">{t.type}</span>
            <span className="font-mono tabular-nums text-muted-foreground">{t.count}</span>
          </DropdownMenuCheckboxItem>
        ))}
      </>
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          className={cn(
            "h-6 gap-1 px-1.5 text-[11px]",
            shown < types.length && "border-primary/60 text-primary",
            className,
          )}
          disabled={types.length === 0}
          title="Show only some kinds of issue. Applies to the dialog, the panel, Review and F / Shift+F."
        >
          <ListFilter className="h-3 w-3" />
          {issueFilterCaption(shown, types.length)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 min-w-56 overflow-auto">
        <DropdownMenuItem className="text-[11px]" onSelect={keepOpen} onClick={() => setHidden(new Set())}>
          All
        </DropdownMenuItem>
        <DropdownMenuItem
          className="text-[11px]"
          onSelect={keepOpen}
          onClick={() => setHidden(new Set([...hidden, ...types.map((t) => t.type)]))}
        >
          None
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {group("rule", "Rule checks")}
        {group("pose", "Pose scores")}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
