/**
 * The Connect window (design §4.2, docs/plans/2026-10-04-connect-window-design.md)
 * — a full-window overlay listing every paired worker and the jobs on it,
 * opened from the Connect panel, a "Run again"/"Open in Connect" action on a
 * RemoteRunCard, or a job-finished toast's "Open" action.
 *
 * The worker picked here is LOCAL to this window: it never touches
 * `connectStore`'s `selectedWorkerId` (the app's actual training/inference
 * backend, owned by `BackendPicker`) — browsing another worker's jobs/info
 * must not change what a running Training/Inference panel talks to.
 *
 * On close, idle (non-selected, no-active-job) managed connections opened
 * just to populate this window are released (`releaseIdleConnections`) —
 * otherwise browsing every paired worker here would leave all of them
 * connected indefinitely.
 */
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useConnectStore } from "@/stores/connectStore";
import { WorkerList } from "./WorkerList";

// WorkerJobs (§4b.4) and WorkerDataAccess (§4b.5) land in their own
// follow-up commits — the tab bodies are placeholders until then.

export interface ConnectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type WorkerTab = "jobs" | "data";

export function ConnectDialog({ open, onOpenChange }: ConnectDialogProps) {
  const pairedWorkers = useConnectStore((s) => s.pairedWorkers);
  const activeSelectedWorkerId = useConnectStore((s) => s.selectedWorkerId);
  const refreshWorkerInfo = useConnectStore((s) => s.refreshWorkerInfo);
  const releaseIdleConnections = useConnectStore((s) => s.releaseIdleConnections);

  const [pickedWorkerId, setPickedWorkerId] = useState<string | null>(null);
  const [tab, setTab] = useState<WorkerTab>("jobs");

  // Refresh every paired worker's info in parallel each time the window
  // opens, so cards show live specs/busy state right away rather than only
  // once each one is individually selected.
  useEffect(() => {
    if (!open) return;
    for (const w of pairedWorkers) void refreshWorkerInfo(w.nodeId);
    // Deliberately runs once per open, not on every pairedWorkers change —
    // a worker paired WHILE the window is already open gets refreshed when
    // its own card first renders (WorkerList selects it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Default to the app's current backend worker (the common case: opening
  // from a running job's "Open in Connect"/finish toast) if it's paired,
  // else the first paired worker — and re-pick if the current pick was
  // forgotten while the window was open.
  useEffect(() => {
    if (!open) return;
    if (pickedWorkerId && pairedWorkers.some((w) => w.nodeId === pickedWorkerId)) return;
    const fallback = pairedWorkers.some((w) => w.nodeId === activeSelectedWorkerId)
      ? activeSelectedWorkerId
      : (pairedWorkers[0]?.nodeId ?? null);
    setPickedWorkerId(fallback);
  }, [open, pairedWorkers, pickedWorkerId, activeSelectedWorkerId]);

  const handleOpenChange = (next: boolean) => {
    if (!next) releaseIdleConnections();
    onOpenChange(next);
  };

  const pickedWorker = pairedWorkers.find((w) => w.nodeId === pickedWorkerId) ?? null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="w-[92vw] h-[90vh] min-w-[640px] min-h-[480px] max-w-[96vw] sm:max-w-[96vw] max-h-[94vh] resize overflow-hidden p-0 inset-0 translate-x-0 translate-y-0 m-auto flex flex-col"
      >
        <div className="flex items-center gap-2 px-6 py-2.5 border-b shrink-0">
          <DialogTitle className="text-sm font-semibold text-foreground">Connect</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground mt-0">
            Your workers and the jobs on them
          </DialogDescription>
          <DialogClose asChild>
            <Button variant="ghost" size="icon-xs" className="ml-auto" aria-label="Close">
              <X className="h-4 w-4" />
            </Button>
          </DialogClose>
        </div>

        <div className="flex flex-1 min-h-0">
          <div className="w-[320px] shrink-0 border-r overflow-y-auto">
            <WorkerList selectedId={pickedWorkerId} onSelect={setPickedWorkerId} />
          </div>

          <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
            {pickedWorker ? (
              <>
                <div className="flex items-center gap-3 px-4 py-2 border-b shrink-0">
                  <span className="text-sm font-semibold truncate">{pickedWorker.label}</span>
                  <Tabs value={tab} onValueChange={(v) => setTab(v as WorkerTab)}>
                    <TabsList>
                      <TabsTrigger value="jobs" className="text-xs">
                        Jobs
                      </TabsTrigger>
                      <TabsTrigger value="data" className="text-xs">
                        Data access
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto p-4 text-xs text-muted-foreground">
                  {tab === "jobs" ? "Jobs — coming in §4b.4." : "Data access — coming in §4b.5."}
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground p-4 text-center">
                Pair a worker to see its jobs here.
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
