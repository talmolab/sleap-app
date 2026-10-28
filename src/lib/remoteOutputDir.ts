/**
 * Where a "this window" remote run saves its models and predictions on the
 * worker (folder access stage 4). Pure apart from the injected `stat`.
 *
 * Default, in order:
 * 1. the project's own folder on the worker — the local project path, already
 *    a worker path or translated by a path rule, if that folder exists there
 *    inside a shared folder;
 * 2. `<serve folder>/sleap-connect/<project name>/`, if the worker's serve
 *    folder is shared;
 * 3. none — outputs stay in the worker's job folder.
 * The user can pick another folder (Change…), remembered per project+worker.
 */
import { isWorkerPath, translatePath, type PathMapping } from "@/lib/pathMappings";

export type OutputDirSource = "project" | "serve-folder" | "chosen";

export interface OutputDirChoice {
  dir: string;
  source: OutputDirSource;
}

function posixDirname(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i <= 0 ? "/" : trimmed.slice(0, i);
}

/** "labels.v002.slp" → "labels.v002" (the folder name under sleap-connect/). */
export function projectFolderName(projectName: string): string {
  const base = projectName.replace(/\.(pkg\.)?slp$/i, "");
  return base.replace(/[\\/]/g, "_") || "untitled";
}

export async function defaultOutputDir(opts: {
  projectPath: string | null;
  projectName: string;
  rules: PathMapping[];
  mounts: string[];
  serveFolder: string | null;
  /** Whether `path` is a folder on the worker inside a shared folder. */
  isSharedFolder: (path: string) => Promise<boolean>;
}): Promise<OutputDirChoice | null> {
  const { projectPath, rules, mounts, serveFolder } = opts;
  if (projectPath) {
    const onWorker = isWorkerPath(projectPath, mounts) ? projectPath : translatePath(projectPath, rules);
    if (onWorker) {
      const dir = posixDirname(onWorker);
      try {
        if (isWorkerPath(dir, mounts) && (await opts.isSharedFolder(dir))) {
          return { dir, source: "project" };
        }
      } catch {
        // Can't tell — fall through to the serve folder.
      }
    }
  }
  if (serveFolder) {
    return {
      dir: `${serveFolder.replace(/\/+$/, "")}/sleap-connect/${projectFolderName(opts.projectName)}`,
      source: "serve-folder",
    };
  }
  return null;
}
