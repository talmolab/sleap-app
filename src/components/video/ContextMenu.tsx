/**
 * Right-click context menu for the video canvas.
 *
 * Shows context-sensitive actions for the clicked instance/node:
 * - Toggle node visibility
 * - Delete instance
 * - Assign to track
 * - Add new instance
 */

import { useEffect, useRef, useState } from "react";
import { PredictedInstance } from "@talmolab/sleap-io.js";
import { useAppStore } from "../../stores/appStore";
import {
  commandContext,
  AddInstance,
  DeleteSelectedInstance,
  CopyInstance,
  PasteInstance,
  DeleteFramePredictions,
  AddTrack,
  SetInstanceTrack,
} from "../../commands";
import { cn } from "@/lib/utils";

interface ContextMenuProps {
  x: number;
  y: number;
  instanceIdx: number | null;
  nodeIdx: number | null;
  selectedNodes?: Set<string>;
  onToggleSelectedNodesVisibility?: () => void;
  onClose: () => void;
}

export function ContextMenu({
  x,
  y,
  nodeIdx,
  selectedNodes,
  onToggleSelectedNodesVisibility,
  onClose,
}: ContextMenuProps) {
  const labels = useAppStore((s) => s.labels);
  const instance = useAppStore((s) => s.instance);
  const clipboardInstance = useAppStore((s) => s.clipboardInstance);

  // Close on click outside
  useEffect(() => {
    const handler = () => onClose();
    window.addEventListener("click", handler);
    return () => window.removeEventListener("click", handler);
  }, [onClose]);

  // Close on escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Clamp menu position to viewport bounds
  const menuRef = useRef<HTMLDivElement>(null);
  const [clampedPos, setClampedPos] = useState({ left: x, top: y });

  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top = y;
    if (left + rect.width > vw) {
      left = vw - rect.width;
    }
    if (top + rect.height > vh) {
      top = vh - rect.height;
    }
    if (left < 0) left = 0;
    if (top < 0) top = 0;
    setClampedPos({ left, top });
  }, [x, y]);

  const exec = (cmd: Parameters<typeof commandContext.execute>[0], params?: Record<string, unknown>) => {
    onClose();
    commandContext.execute(cmd, params);
  };

  const hasInstance = instance !== null;
  const hasNode = hasInstance && nodeIdx !== null;
  const isPredicted = instance instanceof PredictedInstance;
  const tracks = labels?.tracks ?? [];

  return (
    <div
      ref={menuRef}
      className="fixed z-50 min-w-[180px] bg-popover text-popover-foreground border border-border rounded-md shadow-md py-1"
      style={{ left: clampedPos.left, top: clampedPos.top }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Selected nodes visibility toggle */}
      {selectedNodes && selectedNodes.size > 1 && !isPredicted && (
        <>
          <ContextMenuItem
            label={`Toggle ${selectedNodes.size} Selected Nodes Visibility`}
            shortcut="V"
            onClick={() => {
              onToggleSelectedNodesVisibility?.();
              onClose();
            }}
          />
          <ContextMenuSeparator />
        </>
      )}

      {/* Node-specific actions */}
      {hasNode && !isPredicted && (
        <>
          <ContextMenuItem
            label={
              instance.points[nodeIdx!]?.visible
                ? "Mark Node Non-Visible"
                : "Mark Node Visible"
            }
            shortcut="V"
            onClick={() => {
              const point = instance.points[nodeIdx!];
              if (point) {
                point.visible = !point.visible;
                useAppStore.getState().markChanged();
                useAppStore.getState().bumpOverlayVersion();
              }
              onClose();
            }}
          />
          <ContextMenuSeparator />
        </>
      )}

      {/* Instance actions */}
      {hasInstance && (
        <>
          <ContextMenuItem
            label="Copy Instance"
            shortcut="Ctrl+C"
            onClick={() => exec(CopyInstance)}
          />
          <ContextMenuItem
            label="Delete Instance"
            shortcut="Ctrl+Bksp"
            onClick={() => exec(DeleteSelectedInstance)}
          />
          <ContextMenuSeparator />
        </>
      )}

      {/* Track assignment submenu */}
      {hasInstance && !isPredicted && tracks.length > 0 && (
        <>
          <div className="px-2 py-1 text-[10px] text-muted-foreground uppercase tracking-wide">
            Assign Track
          </div>
          {tracks.map((track, i) => (
            <ContextMenuItem
              key={i}
              label={track.name}
              active={instance.track === track}
              onClick={() => exec(SetInstanceTrack, { trackIdx: i })}
            />
          ))}
          <ContextMenuItem
            label="+ New Track"
            onClick={() => exec(AddTrack)}
          />
          <ContextMenuSeparator />
        </>
      )}

      {/* General actions */}
      <ContextMenuItem
        label="Add Instance"
        shortcut="Ctrl+I"
        onClick={() => exec(AddInstance)}
      />
      {clipboardInstance && (
        <ContextMenuItem
          label="Paste Instance"
          shortcut="Ctrl+V"
          onClick={() => exec(PasteInstance)}
        />
      )}
      <ContextMenuSeparator />
      <ContextMenuItem
        label="Delete Predictions"
        onClick={() => exec(DeleteFramePredictions)}
      />
    </div>
  );
}

function ContextMenuItem({
  label,
  shortcut,
  onClick,
  disabled,
  active,
}: {
  label: string;
  shortcut?: string;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      className={cn(
        "w-full flex items-center justify-between px-2 py-1.5 text-sm text-left rounded-sm",
        disabled
          ? "text-muted-foreground cursor-default"
          : "text-popover-foreground hover:bg-accent hover:text-accent-foreground"
      )}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
    >
      <span>
        {active && <span className="mr-1.5 text-primary">&#x2713;</span>}
        {label}
      </span>
      {shortcut && (
        <span className="text-muted-foreground ml-4 text-xs">
          {shortcut}
        </span>
      )}
    </button>
  );
}

function ContextMenuSeparator() {
  return <div className="my-1 border-t border-border mx-1" />;
}
