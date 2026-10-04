/**
 * "Labels sent from this window" visibility summary (PR3b
 * docs/plans/2026-10-04-connect-pr3-detailed-plan.md §3b.1) — shown under
 * the "This window" labels-source radio in TrainingPanel. Runs
 * `checkVideoVisibility` against the project's videos (debounced, stale
 * results ignored) and reports how many the worker can see directly, with a
 * "Locate on worker…" escape hatch per hidden video (§3b.2).
 *
 * The check function and debounce delay are both injectable so tests never
 * need a real worker connection or real timers beyond a short, explicit wait.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RemoteFileBrowser } from "@/components/dialogs/RemoteFileBrowser";
import { useConnectStore } from "@/stores/connectStore";
import {
  checkVideoVisibility,
  classifyVisibility,
  projectVideoPaths,
  type VideoVisibility,
} from "@/lib/remoteVisibility";
import type { PathMapping } from "@/lib/pathMappings";
import type { Labels } from "@/types";

const DEFAULT_DEBOUNCE_MS = 300;
const EMPTY_RULES: PathMapping[] = [];
const EMPTY_MOUNTS: string[] = [];
const MAX_HIDDEN_SHOWN = 3;

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** File extension (with dot), lowercased, or `undefined` if none — used to
 * scope the Locate file browser to the same kind of file as the hidden video. */
function extOf(path: string): string | undefined {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLowerCase() : undefined;
}

/** Shared with HiddenVideosDialog so both surfaces describe coverage identically. */
export function describeVisibilityOutcome(visibility: VideoVisibility[]): string {
  const kase = classifyVisibility(visibility);
  if (kase === "all") return "Training + inference on worker";
  if (kase === "none") return "Training only — videos not visible";
  const visibleCount = visibility.filter((v) => v.visible).length;
  return `Training on worker · inference on ${visibleCount} of ${visibility.length} videos`;
}

export interface RemoteDataSummaryProps {
  workerId: string | null;
  labels: Labels | null;
  /** Lifts the latest result to the panel (null while unknown/still checking) so Start can use it. */
  onResult: (visibility: VideoVisibility[] | null) => void;
  /** Overridable for tests; defaults to the real `checkVideoVisibility`. */
  checkFn?: typeof checkVideoVisibility;
  /** Debounce delay in ms; tests pass 0 for an immediate check. */
  debounceMs?: number;
}

export function RemoteDataSummary({
  workerId,
  labels,
  onResult,
  checkFn = checkVideoVisibility,
  debounceMs = DEFAULT_DEBOUNCE_MS,
}: RemoteDataSummaryProps) {
  const pairedWorkers = useConnectStore((s) => s.pairedWorkers);
  const connectionStatus = useConnectStore((s) => s.connectionStatus);
  const connectedMounts = useConnectStore((s) => s.workerMounts);
  const statWorkerPath = useConnectStore((s) => s.statWorkerPath);

  const worker = workerId ? pairedWorkers.find((w) => w.nodeId === workerId) : undefined;
  const rules = worker?.pathRules ?? EMPTY_RULES;
  const mounts = useMemo(
    () => (connectionStatus === "connected" ? connectedMounts.map((m) => m.path) : EMPTY_MOUNTS),
    [connectionStatus, connectedMounts],
  );
  const videoPaths = useMemo(() => (labels ? projectVideoPaths(labels) : []), [labels]);

  const [result, setResult] = useState<VideoVisibility[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [locateFor, setLocateFor] = useState<VideoVisibility | null>(null);
  const requestRef = useRef(0);
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  useEffect(() => {
    if (!workerId) {
      setResult(null);
      setChecking(false);
      onResultRef.current(null);
      return;
    }
    const myRequest = ++requestRef.current;
    setChecking(true);
    const timer = setTimeout(() => {
      void checkFn(videoPaths, {
        rules,
        mounts,
        stat: (p) => statWorkerPath(p).then((r) => r.exists),
      }).then((v) => {
        if (requestRef.current !== myRequest) return; // a newer check superseded this one
        setResult(v);
        setChecking(false);
        onResultRef.current(v);
      });
    }, debounceMs);
    return () => clearTimeout(timer);
  }, [workerId, rules, mounts, videoPaths, checkFn, debounceMs, statWorkerPath]);

  if (!workerId || !labels) return null;

  const workerLabel = worker?.label ?? "worker";
  const hidden = result?.filter((v) => !v.visible) ?? [];
  const visibleCount = result ? result.length - hidden.length : 0;
  const shown = hidden.slice(0, MAX_HIDDEN_SHOWN);

  return (
    <div className="rounded-md border border-border bg-muted/30 p-2 space-y-1.5 text-[10px]">
      <div className="text-muted-foreground">Labels ↑ sent from this window</div>

      <div className="flex items-center gap-1.5">
        {checking && <Loader2 className="h-3 w-3 animate-spin shrink-0 text-muted-foreground" />}
        {result && (
          <span className={hidden.length === 0 ? "text-green-400" : "text-muted-foreground"}>
            Videos {visibleCount}/{result.length} visible on {workerLabel}
          </span>
        )}
      </div>

      {shown.length > 0 && (
        <div className="space-y-1">
          {shown.map((v) => (
            <div key={v.index} className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-muted-foreground">{basename(v.local)}</span>
              <Button
                variant="link"
                size="xs"
                className="h-5 px-0 text-[10px] shrink-0"
                onClick={() => setLocateFor(v)}
              >
                Locate on worker…
              </Button>
            </div>
          ))}
          {hidden.length > MAX_HIDDEN_SHOWN && (
            <p className="text-muted-foreground">and {hidden.length - MAX_HIDDEN_SHOWN} more</p>
          )}
        </div>
      )}

      {result && <p className="text-muted-foreground">{describeVisibilityOutcome(result)}</p>}

      <RemoteFileBrowser
        open={locateFor !== null}
        onClose={() => setLocateFor(null)}
        onSelect={() => setLocateFor(null)}
        mounts={mounts}
        mode="file"
        fileFilter={locateFor ? extOf(locateFor.local) : undefined}
      />
    </div>
  );
}
