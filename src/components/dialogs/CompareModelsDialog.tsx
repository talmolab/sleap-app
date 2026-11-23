/**
 * Predict ▸ Compare Model Predictions… — pick prediction `.slp` files to draw
 * over the current video, one colour per model (Lightning Pose style).
 *
 * On desktop the dialog lists every `.slp` in the project's folder, `models/`
 * and `models/<run>/`, and checks each one: it must contain this video (same
 * path, else same file name with the same frame count and size) and have the
 * project's node names. Files that don't fit stay in the list, greyed, with
 * the reason. Browse… adds any other file (the only way in the browser, which
 * can't list folders). Usable files start ticked; "Show" loads the ticked ones.
 *
 * View only: nothing is written to the project.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/stores/appStore";
import { useModelOverlayStore, type NewOverlayModel } from "@/stores/modelOverlayStore";
import { getPlatform, isTauri } from "@/platform/index";
import { targetFromVideo, normalizePath, isTrainingSplitFile, type OverlayPose } from "@/lib/modelOverlay/core";
import {
  checkCacheKey,
  getCachedCheck,
  setCachedCheck,
  summarize,
  type CheckSummary,
} from "@/lib/modelOverlay/checkCache";
import { scanPredictionFiles, MAX_SCAN_BYTES } from "@/lib/modelOverlay/scan";
import { loadAndAnalyze, sourceKey, sourceFileName, type PredictionSource } from "@/lib/modelOverlay/load";

/** What a row knows about its file: the check's verdict, plus the poses while they're kept. */
type RowResult = CheckSummary & { frames?: Map<number, OverlayPose[]> };

interface Row {
  key: string;
  source: PredictionSource;
  /** Shown under the model name: path relative to the project folder, or the file name. */
  where: string;
  result: RowResult | null;
  checked: boolean;
}

function relativeTo(projectPath: string | null, path: string): string {
  if (!projectPath) return path;
  const dir = normalizePath(projectPath).replace(/\/[^/]*$/, "");
  const p = normalizePath(path);
  return p.startsWith(dir + "/") ? p.slice(dir.length + 1) : path;
}

function formatMb(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

/**
 * Whether a usable file starts ticked. Not when its video only probably
 * matches (same name, nothing to confirm it), nor for a run's train/val/test
 * split predictions (they only cover labeled frames).
 */
export function tickedByDefault(key: string, r: CheckSummary): boolean {
  return r.ok && r.matchedBy !== "probable" && !isTrainingSplitFile(key);
}

/** The grey note under a usable row, if any. */
export function rowNote(key: string, r: CheckSummary): string | null {
  if (!r.ok) return null;
  const notes: string[] = [];
  if (isTrainingSplitFile(key)) notes.push("Predictions on a training split: only covers that split's labeled frames");
  if (r.matchedBy === "probable")
    notes.push("Probably this video: same file name, but neither file records the frame count or size to confirm it");
  if (r.ignoredSkeletons) {
    const n = r.ignoredSkeletons;
    notes.push(
      `Using ${r.skeletonName ? `${r.skeletonName} ` : "this skeleton's "}predictions only (${n} other skeleton${n === 1 ? "" : "s"} ignored)`,
    );
  }
  return notes.length > 0 ? notes.join(" · ") : null;
}

export function CompareModelsDialog() {
  const open = useModelOverlayStore((s) => s.dialogOpen);
  const setOpen = useModelOverlayStore((s) => s.setDialogOpen);
  const addModels = useModelOverlayStore((s) => s.addModels);
  const loaded = useModelOverlayStore((s) => s.models);
  const labels = useAppStore((s) => s.labels);
  const video = useAppStore((s) => s.video);
  const skeleton = useAppStore((s) => s.skeleton);
  const projectPath = useAppStore((s) => s.projectPath);

  const [rows, setRows] = useState<Row[]>([]);
  const [scanning, setScanning] = useState(false);
  const [loadingChosen, setLoadingChosen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Each open (and each project/video change) starts a new generation; results
  // from an older one are dropped.
  const gen = useRef(0);

  const nodeNames = skeleton?.nodes.map((n) => n.name) ?? [];
  const nodeKey = nodeNames.join("\u0000");

  /** Check rows' files (reading them), keeping the poses only for rows that start ticked. */
  const analyzeRows = useCallback(
    async (todo: { row: Row; cacheKey: string | null }[], g: number) => {
      if (!video) return;
      const target = targetFromVideo(video);
      const names = nodeKey === "" ? [] : nodeKey.split("\u0000");
      for (const { row, cacheKey } of todo) {
        const a = await loadAndAnalyze(row.source, target, names);
        if (g !== gen.current) return;
        setCachedCheck(cacheKey, a);
        const summary = summarize(a);
        const checked = tickedByDefault(row.key, summary);
        const result: RowResult = a.ok && checked ? { ...summary, frames: a.frames } : summary;
        setRows((prev) => prev.map((r) => (r.key === row.key ? { ...r, result, checked } : r)));
      }
    },
    [video, nodeKey]
  );

  // Closing the dialog drops every row, and with them any poses read for it.
  useEffect(() => {
    if (!open) {
      gen.current++;
      setRows([]);
      setLoadingChosen(false);
    }
  }, [open]);

  // On open: list and check the files near the project (desktop). Files
  // checked before and unchanged since (same size and modified time) reuse
  // that verdict instead of being read again.
  useEffect(() => {
    if (!open) return;
    const g = ++gen.current;
    setRows([]);
    setError(null);
    if (!isTauri || !projectPath || !video) return;
    setScanning(true);
    (async () => {
      const found = await scanPredictionFiles(projectPath).catch(() => []);
      if (g !== gen.current) return;
      const target = targetFromVideo(video);
      const names = nodeKey === "" ? [] : nodeKey.split("\u0000");
      const todo: { row: Row; cacheKey: string | null }[] = [];
      const fresh: Row[] = found.map((f) => {
        const row: Row = { key: f.path, source: f.path, where: relativeTo(projectPath, f.path), checked: false, result: null };
        if (f.size !== null && f.size > MAX_SCAN_BYTES) {
          row.result = {
            ok: false,
            name: sourceFileName(f.path).replace(/\.slp$/i, ""),
            reason: `Too big to check automatically (${formatMb(f.size)}); use Browse… to open it`,
          };
          return row;
        }
        const cacheKey = checkCacheKey(f.path, f.size, f.mtime, target, names);
        const cached = getCachedCheck(cacheKey);
        if (cached) {
          // Ticked from the cache: the poses are read when you click Show.
          row.result = cached;
          row.checked = tickedByDefault(f.path, cached);
        } else {
          todo.push({ row, cacheKey });
        }
        return row;
      });
      setRows(fresh);
      setScanning(false);
      await analyzeRows(todo, g);
    })();
  }, [open, projectPath, video, nodeKey, analyzeRows]);

  const browse = useCallback(async () => {
    setError(null);
    let picked: string | string[] | File | File[] | null;
    try {
      const platform = await getPlatform();
      picked = await platform.showOpenDialog({
        multiple: true,
        filters: [{ name: "SLEAP predictions", extensions: ["slp"] }],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return;
    }
    if (!picked) return;
    const sources: PredictionSource[] = Array.isArray(picked) ? [...picked] : [picked];
    const g = gen.current;
    const added: Row[] = sources.map((s) => ({
      key: sourceKey(s),
      source: s,
      where: typeof s === "string" ? relativeTo(projectPath, s) : s.name,
      result: null,
      checked: false,
    }));
    setRows((prev) => {
      const next = [...prev];
      for (const row of added) {
        const at = next.findIndex((r) => r.key === row.key);
        if (at >= 0) next[at] = row;
        else next.push(row);
      }
      return next;
    });
    await analyzeRows(
      added.map((row) => ({ row, cacheKey: null })),
      g
    );
  }, [analyzeRows, projectPath]);

  const setChecked = (key: string, checked: boolean) =>
    setRows((prev) =>
      prev.map((x) => {
        if (x.key !== key) return x;
        // Unticking releases the poses read for this file.
        if (!checked && x.result?.ok && x.result.frames) {
          const { frames: _drop, ...rest } = x.result;
          void _drop;
          return { ...x, checked, result: rest };
        }
        return { ...x, checked };
      })
    );

  const chosen = rows.filter((r) => r.checked && r.result?.ok);
  const pending = rows.some((r) => r.result === null);

  const show = async () => {
    if (!labels || !video) return;
    const g = gen.current;
    setLoadingChosen(true);
    const target = targetFromVideo(video);
    const added: NewOverlayModel[] = [];
    for (const r of chosen) {
      let frames = r.result?.ok ? r.result.frames : undefined;
      let name = r.result?.name ?? sourceFileName(r.source);
      if (!frames) {
        // Ticked from the cache or re-ticked: read the poses now.
        const a = await loadAndAnalyze(r.source, target, nodeNames);
        if (g !== gen.current) return;
        if (!a.ok) {
          setError(`${r.where}: ${a.reason}`);
          continue;
        }
        frames = a.frames;
        name = a.name;
      }
      added.push({ name, source: r.key, video, frames });
    }
    if (g !== gen.current) return;
    setLoadingChosen(false);
    if (added.length > 0) addModels(labels, added);
    setOpen(false);
  };

  const shownKeys = new Set(loaded.filter((m) => m.video === video).map((m) => m.source));

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Compare Model Predictions</DialogTitle>
          <DialogDescription>
            Draw predictions from several models over this video, one colour per model. Pick
            prediction <code>.slp</code> files made for this video with the same skeleton. Nothing
            is added to the project.
          </DialogDescription>
        </DialogHeader>

        {!video ? (
          <p className="text-sm text-muted-foreground">Open a video first.</p>
        ) : (
          <div className="min-w-0 space-y-2">
            {!isTauri && (
              <p className="text-sm text-muted-foreground">
                The browser can't look through the project folder. Use Browse… to pick prediction
                files.
              </p>
            )}
            {isTauri && !projectPath && (
              <p className="text-sm text-muted-foreground">
                Save the project to look for prediction files next to it, or use Browse….
              </p>
            )}
            {scanning && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Looking for prediction files…
              </p>
            )}
            {isTauri && projectPath && !scanning && rows.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No <code>.slp</code> files in the project folder or <code>models/</code>.
              </p>
            )}
            {rows.length > 0 && (
              <ul className="max-h-[50vh] space-y-1 overflow-y-auto pr-1" data-testid="compare-models-list">
                {rows.map((r) => {
                  const bad = r.result !== null && !r.result.ok;
                  return (
                    <li
                      key={r.key}
                      className={`flex items-start gap-2 rounded px-1 py-1 text-sm ${bad ? "opacity-60" : ""}`}
                      data-testid="compare-models-row"
                    >
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={r.checked}
                        disabled={!r.result?.ok}
                        onChange={(e) => setChecked(r.key, e.target.checked)}
                        aria-label={`Show ${r.where}`}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium">{r.result?.name ?? sourceFileName(r.source)}</span>
                          {r.result?.ok && (
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {r.result.frameCount} frame{r.result.frameCount === 1 ? "" : "s"}
                              {r.result.matchedBy === "name" ? " · matched by file name" : ""}
                            </span>
                          )}
                          {shownKeys.has(r.key) && (
                            <span className="shrink-0 rounded bg-muted px-1 text-xs text-muted-foreground">shown</span>
                          )}
                        </div>
                        <div className="truncate text-xs text-muted-foreground" title={r.key}>
                          {r.where}
                        </div>
                        {r.result?.ok && rowNote(r.key, r.result) && (
                          <div className="text-xs text-muted-foreground" data-testid="compare-models-note">
                            {rowNote(r.key, r.result)}
                          </div>
                        )}
                        {r.result === null && (
                          <div className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Loader2 className="h-3 w-3 animate-spin" /> Checking…
                          </div>
                        )}
                        {bad && r.result && !r.result.ok && (
                          <div className="text-xs text-muted-foreground" data-testid="compare-models-reason">
                            {r.result.reason}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
          </div>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button variant="outline" onClick={browse} disabled={!video}>
            Browse…
          </Button>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void show()} disabled={chosen.length === 0 || !labels || !video || loadingChosen}>
              {loadingChosen
                ? "Loading…"
                : pending && chosen.length === 0
                ? "Checking…"
                : `Show ${chosen.length} model${chosen.length === 1 ? "" : "s"}`}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
