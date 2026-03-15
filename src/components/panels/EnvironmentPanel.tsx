/**
 * Environment panel for Python/uv toolchain configuration.
 *
 * Shows the status of `uv`, installed tools (sleap-nn, sleap),
 * and allows selecting a Python interpreter.
 */

import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  XCircle,
  Loader2,
  RefreshCw,
  Terminal,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { isTauri } from "../../platform/index";
import {
  detectUv,
  listUvTools,
  checkPython,
  type UvInfo,
  type UvTool,
  type PythonInfo,
} from "../../platform/backend";

type Status = "idle" | "checking" | "done" | "error";

function StatusIcon({ ok }: { ok: boolean }) {
  return ok ? (
    <CheckCircle2 className="h-3.5 w-3.5 text-green-500 shrink-0" />
  ) : (
    <XCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />
  );
}

function StatusRow({
  label,
  ok,
  detail,
}: {
  label: string;
  ok: boolean;
  detail?: string;
}) {
  return (
    <div className="flex items-center gap-2 py-1">
      <StatusIcon ok={ok} />
      <span className="text-xs font-medium">{label}</span>
      {detail && (
        <span className="text-xs text-muted-foreground ml-auto truncate max-w-[140px]" title={detail}>
          {detail}
        </span>
      )}
    </div>
  );
}

export function EnvironmentPanel() {
  const [status, setStatus] = useState<Status>("idle");
  const [uv, setUv] = useState<UvInfo | null>(null);
  const [tools, setTools] = useState<UvTool[]>([]);
  const [python, setPython] = useState<PythonInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setStatus("checking");
    setError(null);
    console.log("[env] Starting environment detection...");

    try {
      // Step 1: Detect uv
      const uvInfo = await detectUv();
      console.log("[env] uv:", uvInfo);
      setUv(uvInfo);

      if (!uvInfo.available) {
        setTools([]);
        setPython(null);
        setStatus("done");
        return;
      }

      // Step 2: List uv tools
      const uvTools = await listUvTools();
      console.log("[env] uv tools:", uvTools);
      setTools(uvTools);

      // Step 3: Check default Python
      const pythonInfo = await checkPython("python3");
      console.log("[env] python3:", pythonInfo);
      setPython(pythonInfo);

      setStatus("done");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[env] Detection failed:", err);
      setError(msg);
      setStatus("error");
    }
  }, []);

  // Auto-detect on mount (only in Tauri mode)
  useEffect(() => {
    if (isTauri) {
      refresh();
    } else {
      setStatus("done");
    }
  }, [refresh]);

  if (!isTauri) {
    return (
      <div className="p-2 text-xs text-muted-foreground">
        <p>Environment detection is only available in the desktop app.</p>
        <p className="mt-1">
          Run <code className="bg-muted px-1 rounded">sleap-label</code> as a
          desktop application to configure Python environments.
        </p>
      </div>
    );
  }

  const sleapNnTool = tools.find((t) => t.name === "sleap-nn");
  const sleapTool = tools.find((t) => t.name === "sleap");

  return (
    <div className="flex flex-col gap-3 -m-2">
      {/* Header with refresh */}
      <div className="flex items-center gap-2 px-2 py-1 border-b border-border shrink-0">
        <Terminal className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium">Environment</span>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 ml-auto"
          onClick={refresh}
          disabled={status === "checking"}
          title="Refresh environment detection"
        >
          <RefreshCw
            className={`h-3 w-3 ${status === "checking" ? "animate-spin" : ""}`}
          />
        </Button>
      </div>

      <div className="px-2 flex flex-col gap-3">
        {/* Status indicator */}
        {status === "checking" && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Detecting environment...
          </div>
        )}

        {error && (
          <div className="text-xs text-red-500 bg-red-500/10 rounded px-2 py-1">
            {error}
          </div>
        )}

        {/* uv section */}
        {(status === "done" || status === "error") && (
          <section>
            <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
              Package Manager
            </h4>
            <StatusRow
              label="uv"
              ok={uv?.available ?? false}
              detail={
                uv?.available
                  ? `v${uv.version}`
                  : "Not found on PATH"
              }
            />
            {uv?.path && (
              <div className="text-[10px] text-muted-foreground pl-5 truncate" title={uv.path}>
                {uv.path}
              </div>
            )}
          </section>
        )}

        {/* Tools section */}
        {(status === "done" || status === "error") && uv?.available && (
          <section>
            <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
              UV Tools
            </h4>

            <StatusRow
              label="sleap-nn"
              ok={!!sleapNnTool}
              detail={
                sleapNnTool
                  ? `v${sleapNnTool.version}`
                  : "Not installed"
              }
            />
            {sleapNnTool && sleapNnTool.commands.length > 0 && (
              <div className="flex flex-wrap gap-1 pl-5 mt-0.5">
                {sleapNnTool.commands.map((cmd) => (
                  <Badge
                    key={cmd}
                    variant="secondary"
                    className="text-[10px] px-1.5 py-0 h-4 rounded-sm font-mono"
                  >
                    {cmd}
                  </Badge>
                ))}
              </div>
            )}

            <StatusRow
              label="sleap"
              ok={!!sleapTool}
              detail={
                sleapTool
                  ? `v${sleapTool.version}`
                  : "Not installed"
              }
            />
            {sleapTool && sleapTool.commands.length > 0 && (
              <div className="flex flex-wrap gap-1 pl-5 mt-0.5">
                {sleapTool.commands.map((cmd) => (
                  <Badge
                    key={cmd}
                    variant="secondary"
                    className="text-[10px] px-1.5 py-0 h-4 rounded-sm font-mono"
                  >
                    {cmd}
                  </Badge>
                ))}
              </div>
            )}

            {tools.length > 0 && !sleapNnTool && !sleapTool && (
              <div className="text-[10px] text-muted-foreground mt-1">
                {tools.length} other tool{tools.length !== 1 ? "s" : ""} installed
              </div>
            )}

            {tools.length === 0 && (
              <div className="text-[10px] text-muted-foreground mt-1">
                No tools installed via <code className="bg-muted px-0.5 rounded">uv tool</code>
              </div>
            )}
          </section>
        )}

        {/* Python section */}
        {(status === "done" || status === "error") && (
          <section>
            <h4 className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
              Python
            </h4>
            <StatusRow
              label="python3"
              ok={!!python?.version}
              detail={
                python?.version
                  ? `v${python.version}`
                  : "Not found"
              }
            />
            {python?.path && python.version && (
              <div className="text-[10px] text-muted-foreground pl-5 truncate" title={python.path}>
                {python.path}
              </div>
            )}

            {python?.version && (
              <>
                <StatusRow
                  label="sleap-nn (import)"
                  ok={!!python.sleapNnVersion}
                  detail={
                    python.sleapNnVersion
                      ? `v${python.sleapNnVersion}`
                      : "Not importable"
                  }
                />
                <StatusRow
                  label="sleap (import)"
                  ok={!!python.sleapVersion}
                  detail={
                    python.sleapVersion
                      ? `v${python.sleapVersion}`
                      : "Not importable"
                  }
                />
              </>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
