/**
 * "Devices with access": every device paired with a worker (who can use
 * it), with when it paired and was last seen — from the worker's
 * `clients.list`. Read-only, except renaming this device. Removing devices
 * is done on the worker (`sleap-rtc clients`).
 *
 * Shown as a header button ("N devices with access") that opens a popover.
 */
import { useCallback, useEffect, useState } from "react";
import { Check, Globe, Laptop, Pencil, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { timeAgo } from "@/lib/timestamp";
import { useConnectStore } from "@/stores/connectStore";
import { WorkerProtocolError, PROTO_UNKNOWN_METHOD } from "@/lib/protocolV1/errors";
import { DEVICE_NAME_MAX } from "@/lib/protocolV1/deviceName";
import type { PairedDevice } from "@/lib/protocolV1/client";

/** This device first, then most recently seen. */
export function sortDevices(devices: PairedDevice[]): PairedDevice[] {
  return [...devices].sort((a, b) => {
    if (a.you !== b.you) return a.you ? -1 : 1;
    return (b.lastSeenAt ?? "").localeCompare(a.lastSeenAt ?? "");
  });
}

function DeviceRow({ device, onRename }: { device: PairedDevice; onRename: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(device.name ?? "");
  const Icon = device.platform === "web" ? Globe : Laptop;
  const save = () => {
    const name = draft.trim();
    if (name && name !== device.name) onRename(name);
    setEditing(false);
  };
  return (
    <li className="flex items-center gap-2.5 rounded-md border border-border bg-zinc-800/50 p-2">
      <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-xs font-medium min-w-0">
          {editing ? (
            <>
              <Input
                autoFocus
                onFocus={(e) => e.currentTarget.select()}
                value={draft}
                maxLength={DEVICE_NAME_MAX}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") save();
                  if (e.key === "Escape") {
                    // Close the editor, not the popover.
                    e.stopPropagation();
                    setEditing(false);
                  }
                }}
                className="h-6 text-xs"
                aria-label="Device name"
              />
              <Button size="icon-xs" variant="ghost" aria-label="Save name" onClick={save}>
                <Check className="h-3 w-3" />
              </Button>
              <Button size="icon-xs" variant="ghost" aria-label="Cancel rename" onClick={() => setEditing(false)}>
                <X className="h-3 w-3" />
              </Button>
            </>
          ) : (
            <>
              <span className={`truncate ${device.name ? "" : "italic text-muted-foreground"}`}>
                {device.name ?? "Unnamed device"}
              </span>
              {device.you && (
                <span className="shrink-0 rounded-full border border-primary/60 bg-primary/10 px-1.5 text-[10px] text-primary">
                  This device
                </span>
              )}
              {device.you && (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="shrink-0"
                  aria-label="Rename this device"
                  onClick={() => {
                    setDraft(device.name ?? "");
                    setEditing(true);
                  }}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              )}
            </>
          )}
        </div>
        <div className="text-[10px] text-muted-foreground truncate">
          {device.platform
            ? `${device.platform === "web" ? "Browser" : "Desktop app"}${device.appVersion ? ` · sleap-app ${device.appVersion}` : ""}`
            : "Paired before devices were named"}
        </div>
      </div>
      <div className="shrink-0 text-right text-[10px] text-muted-foreground leading-tight">
        <div>{device.lastSeenAt ? `seen ${timeAgo(device.lastSeenAt)}` : "never seen"}</div>
        <div>{device.pairedAt ? `paired ${timeAgo(device.pairedAt)}` : ""}</div>
      </div>
    </li>
  );
}

export interface WorkerDevicesListProps {
  devices: PairedDevice[];
  onRenameThisDevice: (name: string) => void;
}

export function WorkerDevicesList({ devices, onRenameThisDevice }: WorkerDevicesListProps) {
  return (
    <div className="space-y-1.5">
      {/* The popover portals outside the Connect dialog, whose scroll lock
          (react-remove-scroll, a document-level listener) would otherwise
          swallow wheel/touch scrolling here — keep those events in the list. */}
      <ul
        className="max-h-[50vh] space-y-1.5 overflow-y-auto overscroll-contain pr-1"
        onWheel={(e) => e.stopPropagation()}
        onTouchMove={(e) => e.stopPropagation()}
      >
        {sortDevices(devices).map((d) => (
          <DeviceRow key={d.nodeId} device={d} onRename={onRenameThisDevice} />
        ))}
      </ul>
      <p className="text-[10px] text-muted-foreground">
        Every device paired with this worker can use it. To see them on the worker, run{" "}
        <code className="font-mono">sleap-rtc clients</code>.
      </p>
    </div>
  );
}

function describeError(err: unknown): string {
  if (err instanceof WorkerProtocolError && err.code === PROTO_UNKNOWN_METHOD) {
    return "This worker's sleap-rtc is too old to list devices — update it to see who has access.";
  }
  return `Couldn't load devices: ${err instanceof Error ? err.message : String(err)}`;
}

export interface WorkerDevicesButtonProps {
  workerId: string;
  workerLabel: string;
  /** Bumped by the Connect window's Refresh. */
  refreshToken?: number;
}

/** Header button: "N devices with access" → popover listing them. */
export function WorkerDevicesButton({ workerId, workerLabel, refreshToken }: WorkerDevicesButtonProps) {
  const devicesFor = useConnectStore((s) => s.devicesFor);
  const setDeviceName = useConnectStore((s) => s.setDeviceName);
  const [devices, setDevices] = useState<PairedDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (isCurrent: () => boolean = () => true) => {
      try {
        const list = await devicesFor(workerId);
        if (!isCurrent()) return;
        setDevices(list);
        setError(null);
      } catch (err) {
        if (!isCurrent()) return;
        setError(describeError(err));
      }
    },
    [devicesFor, workerId],
  );

  useEffect(() => {
    let current = true;
    setDevices(null);
    setError(null);
    void load(() => current);
    return () => {
      current = false;
    };
  }, [load, refreshToken]);

  const rename = async (name: string) => {
    // Optimistic: the list shows the new name right away.
    setDevices((ds) => ds && ds.map((d) => (d.you ? { ...d, name } : d)));
    await setDeviceName(name);
    void load();
  };

  const label =
    devices === null
      ? error
        ? "Devices with access"
        : "Devices…"
      : `${devices.length} device${devices.length === 1 ? "" : "s"} with access`;

  return (
    <Popover onOpenChange={(open) => open && void load()}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="xs" className="ml-auto h-7 text-xs">
          <Users className="h-3.5 w-3.5" />
          {label}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[420px] p-3">
        <p className="mb-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wider truncate">
          Devices with access to {workerLabel}
        </p>
        {error && !devices ? (
          <p className="text-xs text-muted-foreground">{error}</p>
        ) : devices ? (
          <WorkerDevicesList devices={devices} onRenameThisDevice={(name) => void rename(name)} />
        ) : (
          <p className="text-xs text-muted-foreground">Loading…</p>
        )}
      </PopoverContent>
    </Popover>
  );
}
