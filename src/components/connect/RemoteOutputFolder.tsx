/**
 * "Models and predictions saved on worker: <folder> [Change…]" for a remote
 * training run (folder access stage 4).
 *
 * - Labels sent from this window: a default folder (the project's own folder
 *   on the worker, else `<serve folder>/sleap-connect/<project>/`), or one
 *   picked with Change… and remembered per project+worker. Reported up via
 *   `onChange` so it's sent as `output_dir`.
 * - A labels file on the worker: read-only — outputs go next to it, like
 *   SLEAP.
 * Workers without `output_dir` support keep outputs in their job folder.
 */
import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RemoteFileBrowser } from "@/components/dialogs/RemoteFileBrowser";
import { projectTag } from "@/lib/projectTag";
import { defaultOutputDir, type OutputDirChoice } from "@/lib/remoteOutputDir";
import { pathRulesFor, useConnectStore } from "@/stores/connectStore";

export interface RemoteOutputFolderProps {
  workerId: string | null;
  labelsSource: "window" | "worker-file";
  /** labelsSource "worker-file": the labels file on the worker. */
  workerLabelsPath?: string;
  projectPath: string | null;
  /** The open project's file name, used when there's no local path (browser). */
  filename?: string | null;
  /** The folder to send as `output_dir` ("window" runs), or null for the job folder. */
  onChange: (dir: string | null) => void;
}

interface WorkerFacts {
  features: string[];
  mounts: string[];
  serveFolder: string | null;
}

function dirname(path: string): string {
  const i = path.replace(/\/+$/, "").lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

export function RemoteOutputFolder({
  workerId,
  labelsSource,
  workerLabelsPath,
  projectPath,
  filename,
  onChange,
}: RemoteOutputFolderProps) {
  const clientFor = useConnectStore((s) => s.clientFor);
  const setOutputDir = useConnectStore((s) => s.setOutputDir);
  // Named after the file when there's no local path (a browser-opened
  // project), not "untitled.slp".
  const project = useMemo(() => {
    const tag = projectTag(projectPath);
    return projectPath || !filename ? tag : { ...tag, name: filename };
  }, [projectPath, filename]);
  // Remembered per project: by path, else by file name (every path-less
  // project shares one id).
  const projectKey = useMemo(
    () => projectTag(projectPath || filename || null).id,
    [projectPath, filename],
  );
  const chosen = useConnectStore(
    (s) => s.pairedWorkers.find((w) => w.nodeId === workerId)?.outputDirs?.[projectKey] ?? null,
  );

  const [facts, setFacts] = useState<WorkerFacts | null>(null);
  const [fallback, setFallback] = useState<OutputDirChoice | null>(null);
  const [checking, setChecking] = useState(false);
  const [browsing, setBrowsing] = useState(false);

  // What the worker supports, its shared folders and serve folder.
  useEffect(() => {
    setFacts(null);
    if (!workerId) return;
    let cancelled = false;
    void (async () => {
      try {
        const client = await clientFor(workerId);
        const [info, mounts] = await Promise.all([client.workerInfo(), client.fsMountsAndServeFolder()]);
        if (!cancelled) {
          setFacts({
            features: info.features,
            mounts: mounts.mounts.map((m) => m.path),
            serveFolder: mounts.serveFolder,
          });
        }
      } catch {
        if (!cancelled) setFacts({ features: [], mounts: [], serveFolder: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workerId, clientFor]);

  const supportsOutputDir = !!facts?.features.includes("output_dir");

  // The default folder for "window" runs (only needed when nothing's chosen).
  useEffect(() => {
    setFallback(null);
    if (!workerId || !facts || !supportsOutputDir || labelsSource !== "window" || chosen) return;
    let cancelled = false;
    setChecking(true);
    void (async () => {
      const client = await clientFor(workerId).catch(() => null);
      const result = await defaultOutputDir({
        projectPath,
        projectName: project.name,
        rules: pathRulesFor(workerId),
        mounts: facts.mounts,
        serveFolder: facts.serveFolder,
        isSharedFolder: async (p) => {
          if (!client) return false;
          const stat = await client.fsStat(p);
          return stat.type === "directory" && stat.shared;
        },
      });
      if (!cancelled) {
        setFallback(result);
        setChecking(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workerId, facts, supportsOutputDir, labelsSource, chosen, projectPath, project.name, clientFor]);

  const current: OutputDirChoice | null = chosen ? { dir: chosen, source: "chosen" } : fallback;
  const outputDir = labelsSource === "window" && supportsOutputDir ? (current?.dir ?? null) : null;
  useEffect(() => onChange(outputDir), [outputDir, onChange]);

  if (!workerId || !facts) return null;

  const line = (text: React.ReactNode) => (
    <div className="text-[10px] text-muted-foreground">{text}</div>
  );

  if (labelsSource === "worker-file") {
    if (!facts.features.includes("sleap_outputs")) {
      return line("Models and predictions are saved in the worker's job folder.");
    }
    return line(
      <>
        Models and predictions saved on worker next to the labels file
        {workerLabelsPath ? (
          <>
            : <span className="font-mono break-all">{dirname(workerLabelsPath)}</span>
          </>
        ) : (
          "."
        )}
      </>,
    );
  }

  if (!supportsOutputDir) {
    return line("Models and predictions stay in the worker's job folder (update sleap-rtc on the worker to choose a folder).");
  }

  return (
    <div className="space-y-0.5 text-[10px]">
      <div className="text-muted-foreground">Models and predictions saved on worker:</div>
      <div className="flex items-start gap-1.5">
        {checking && !current ? (
          <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
        ) : current ? (
          <span className="min-w-0 flex-1 font-mono break-all">{current.dir}</span>
        ) : (
          <span className="min-w-0 flex-1 text-amber-400">
            the worker&apos;s job folder — pick a folder to keep them browsable
          </span>
        )}
        <Button
          variant="link"
          size="xs"
          className="h-4 px-0 text-[10px] shrink-0"
          onClick={() => setBrowsing(true)}
        >
          {current ? "Change…" : "Choose folder…"}
        </Button>
        {chosen && (
          <Button
            variant="link"
            size="xs"
            className="h-4 px-0 text-[10px] shrink-0 text-muted-foreground"
            onClick={() => setOutputDir(workerId, projectKey, null)}
          >
            Reset
          </Button>
        )}
      </div>
      {current?.source === "serve-folder" && (
        <p className="text-muted-foreground">Created on the worker if needed.</p>
      )}
      <RemoteFileBrowser
        open={browsing}
        onClose={() => setBrowsing(false)}
        mode="directory"
        workerId={workerId}
        mounts={facts.mounts}
        onSelect={(dir) => {
          setOutputDir(workerId, projectKey, dir);
          setBrowsing(false);
        }}
      />
    </div>
  );
}
