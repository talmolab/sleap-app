/**
 * "Unsaved work" dropdown for the Welcome screen: a compact pill above New/Open
 * whose menu lists recoverable labels drafts (browser OPFS + desktop crash
 * drafts, see `recoverableDrafts.ts`) with where each lives, what it carries
 * and when it was saved. Clicking a draft restores it; the trash icon (or
 * "Discard all…") asks for an inline confirm before deleting.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, History, RotateCcw, Trash2 } from "lucide-react";
import type { RecoverableDraft } from "@/lib/recoverableDrafts";
import { cn } from "@/lib/utils";

/** Compact "saved N ago". */
function timeAgo(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  return `${d} day${d > 1 ? "s" : ""} ago`;
}

/** "~/labels/mice" — the folder a draft's project lives in, home-abbreviated. */
export function folderOf(path: string): string {
  const dir = path.replace(/[\\/][^\\/]*$/, "");
  return dir.replace(/^\/(Users|home)\/[^/]+/, "~").replace(/^[A-Z]:\\Users\\[^\\]+/i, "~");
}

/** "2 videos" / "embedded frames" — what the draft carries. */
export function contentsLabel(d: RecoverableDraft): string {
  if (d.embedded) return "embedded frames";
  if (d.videoCount === 0) return "no videos";
  return `${d.videoCount} video${d.videoCount > 1 ? "s" : ""}`;
}

interface ViewerProps {
  drafts: RecoverableDraft[];
  loading: boolean;
  onDiscard: (d: RecoverableDraft) => Promise<void>;
  onDiscardAll: () => Promise<void>;
}

/** Inline "Discard permanently?" confirm (replaces the old window.confirm). */
function DiscardConfirm({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground">Discard permanently?</span>
      <Button size="xs" variant="destructive" onClick={onConfirm}>
        Discard
      </Button>
      <Button size="xs" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

/** Dropdown: a pill that opens a menu of drafts — Restore on click, discard via the trash icon. */
export function UnsavedWorkDropdown({ drafts, loading, onDiscard, onDiscardAll }: ViewerProps) {
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) {
          setConfirmingKey(null);
          setConfirmingAll(false);
        }
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="rounded-full bg-card/95 backdrop-blur-sm shadow-md ring-1 ring-amber-500/50 dark:border-white/20"
        >
          <History className="h-4 w-4 text-amber-500" />
          Unsaved work
          <span className="rounded-full bg-amber-500/15 px-1.5 text-xs text-amber-600 dark:text-amber-400">
            {drafts.length}
          </span>
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" side="top" className="w-80">
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          Restore autosaved changes that were never saved
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {drafts.map((d) =>
          confirmingKey === d.key ? (
            <div key={d.key} className="px-2 py-1.5">
              <div className="truncate text-sm font-medium">{d.displayName}</div>
              <DiscardConfirm
                onConfirm={() => {
                  setConfirmingKey(null);
                  void onDiscard(d);
                }}
                onCancel={() => setConfirmingKey(null)}
              />
            </div>
          ) : (
            <DropdownMenuItem
              key={d.key}
              disabled={loading}
              className="group items-start"
              onSelect={() => void d.restore()}
            >
              <RotateCcw className="mt-0.5 h-4 w-4" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{d.displayName}</div>
                <div
                  className="truncate text-xs text-muted-foreground"
                  title={d.projectPath ?? undefined}
                >
                  {d.projectPath ? folderOf(d.projectPath) : "never saved to disk"}
                </div>
                <div className="text-xs text-muted-foreground">
                  {contentsLabel(d)} · saved {timeAgo(d.savedAt)}
                </div>
              </div>
              <button
                type="button"
                aria-label={`Discard ${d.displayName}`}
                className={cn(
                  "rounded p-1 text-muted-foreground opacity-0 hover:bg-destructive/15 hover:text-destructive",
                  "group-hover:opacity-100 group-data-[highlighted]:opacity-100",
                )}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setConfirmingKey(d.key);
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </DropdownMenuItem>
          ),
        )}
        {drafts.length > 1 && (
          <>
            <DropdownMenuSeparator />
            {confirmingAll ? (
              <div className="px-2 py-1.5">
                <DiscardConfirm
                  onConfirm={() => {
                    setConfirmingAll(false);
                    void onDiscardAll();
                  }}
                  onCancel={() => setConfirmingAll(false)}
                />
              </div>
            ) : (
              <DropdownMenuItem
                className="text-muted-foreground"
                onSelect={(e) => {
                  e.preventDefault();
                  setConfirmingAll(true);
                }}
              >
                <Trash2 className="h-4 w-4" />
                Discard all…
              </DropdownMenuItem>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
