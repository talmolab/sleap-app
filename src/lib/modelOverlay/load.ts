/**
 * Open one prediction file (a path on desktop, a picked File in the browser)
 * and check it against the project with {@link analyzePredictionFile}.
 * A file that can't be read comes back as not usable, with the error as the
 * reason, so one bad file never stops the others.
 */
import type { Labels } from "@/types";
import { analyzePredictionFile, pathBaseName, type CandidateAnalysis, type TargetVideo } from "./core";

export type PredictionSource = string | File;

export function sourceKey(source: PredictionSource): string {
  return typeof source === "string" ? source : source.name;
}

export function sourceFileName(source: PredictionSource): string {
  return typeof source === "string" ? pathBaseName(source) : source.name;
}

export interface LoadDeps {
  loadPath: (path: string) => Promise<Labels>;
  loadFile: (file: File) => Promise<Labels>;
}

async function defaultDeps(): Promise<LoadDeps> {
  const [{ loadLabelsFromSlpFile, loadLabelsFromSlpPath }, { getPlatform }] = await Promise.all([
    import("@/lib/loadProject"),
    import("@/platform/index"),
  ]);
  const platform = await getPlatform();
  return {
    loadPath: (p) => loadLabelsFromSlpPath(p, platform.readFile),
    loadFile: (f) => loadLabelsFromSlpFile(f),
  };
}

export async function loadAndAnalyze(
  source: PredictionSource,
  target: TargetVideo,
  projectNodeNames: readonly string[],
  deps?: LoadDeps
): Promise<CandidateAnalysis> {
  const fileName = sourceFileName(source);
  let labels: Labels;
  try {
    const d = deps ?? (await defaultDeps());
    labels = typeof source === "string" ? await d.loadPath(source) : await d.loadFile(source);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // h5wasm reports a non-HDF5 file as "Aborted(…)", which means nothing to a user.
    const reason = /Aborted\(/.test(msg) || msg.trim() === ""
      ? "Couldn't read the file (is it a SLEAP .slp file?)"
      : `Couldn't read the file: ${msg}`;
    return { ok: false, name: fileName.replace(/\.slp$/i, ""), reason };
  }
  return analyzePredictionFile(labels, fileName, target, projectNodeNames);
}
