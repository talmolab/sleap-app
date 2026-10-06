/**
 * Connect window §4b.5 — the Data access tab: the worker's configured
 * mounts (read-only, from `fs.mounts`) and this worker's remembered
 * local↔worker path rules (Locate-on-worker overrides), with Clear. No
 * mapping editor — rules are only ever created by browsing elsewhere
 * ("Locate on worker…", connectStore's `addPathRule`).
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import type { Mount } from "@/lib/protocolV1/client";
import type { PathMapping } from "@/lib/pathMappings";
import { useConnectStore } from "@/stores/connectStore";

// Stable empty-array fallback — a fresh `[]` literal on every selector call
// would give zustand's useSyncExternalStore a "changed" snapshot on every
// render (it's a new reference each time) and loop forever.
const NO_PATH_RULES: PathMapping[] = [];

export interface WorkerDataAccessProps {
  workerId: string;
}

export function WorkerDataAccess({ workerId }: WorkerDataAccessProps) {
  const clientFor = useConnectStore((s) => s.clientFor);
  const clearPathRule = useConnectStore((s) => s.clearPathRule);
  // A reactive selector rather than the non-hook `pathRulesFor` helper
  // (which just reads a snapshot) — Clear needs this list to re-render.
  const pathRules = useConnectStore(
    (s) => s.pairedWorkers.find((w) => w.nodeId === workerId)?.pathRules ?? NO_PATH_RULES,
  );

  const [mounts, setMounts] = useState<Mount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setMounts([]);
    setError(null);
    void (async () => {
      try {
        const client = await clientFor(workerId);
        const result = await client.fsMounts();
        if (!cancelled) setMounts(result);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workerId, clientFor]);

  return (
    <div className="space-y-5 max-w-xl">
      <div className="space-y-1.5">
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
          Folders this worker shares (set with --mount on the worker)
        </p>
        {error && <p className="text-[11px] text-red-400">{error}</p>}
        {loading ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : mounts.length === 0 ? (
          <p className="text-xs text-muted-foreground">No mounts configured.</p>
        ) : (
          <div className="space-y-1">
            {mounts.map((m) => (
              <div
                key={m.path}
                className="flex items-center gap-3 px-2.5 py-1.5 border border-border rounded-md bg-zinc-800/50 font-mono text-xs"
              >
                <span className="truncate">{m.path}</span>
                {m.label && <span className="text-muted-foreground shrink-0">{m.label}</span>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
          Remembered locations — learned when you use &quot;Locate on worker…&quot;
        </p>
        {pathRules.length === 0 ? (
          <p className="text-xs text-muted-foreground">None yet.</p>
        ) : (
          <div className="space-y-1">
            {pathRules.map((rule, i) => (
              <div
                key={`${i}:${rule.local}`}
                className="flex items-center gap-2 px-2.5 py-1.5 border border-border rounded-md bg-zinc-800/50 text-xs"
              >
                {/* Both sides on their own wrapping line: a single truncated
                    "local → worker" line hid the worker side entirely. */}
                <div className="min-w-0 flex-1 space-y-0.5 font-mono text-[11px]">
                  <div className="flex gap-2">
                    <span className="w-16 shrink-0 font-sans text-[10px] text-muted-foreground">This computer</span>
                    <span className="break-all">{rule.local}</span>
                  </div>
                  <div className="flex gap-2">
                    <span className="w-16 shrink-0 font-sans text-[10px] text-muted-foreground">Worker</span>
                    <span className="break-all">{rule.worker}</span>
                  </div>
                </div>
                <Button
                  size="xs"
                  variant="outline"
                  className="ml-auto h-6 text-[10px] shrink-0"
                  onClick={() => clearPathRule(workerId, rule.local)}
                >
                  Clear
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
