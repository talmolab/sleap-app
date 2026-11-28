/**
 * Prepare the currently open SLEAP project for upload to SLEAP Share without
 * mutating `projectPath`, `hasChanges`, `filename`, or `_slpLayout`.
 *
 * Supports:
 *  - `embedded_existing`: already-embedded `.pkg.slp` (direct zero-copy reuse if clean,
 *    or streamed/serialized temp build if edited).
 *  - `package`: build a portable `.pkg.slp` with embedded frames (user/training/full,
 *    PNG/JPEG) streamed to disk (desktop temp file / browser OPFS) or in-memory fallback.
 *  - `multifile`: serialized `.slp` (with `/preview` thumbnail) + selected companion video(s).
 *  - `labels_only`: serialized `.slp` (with `/preview` thumbnail), no video media.
 */

import {
  ExportCancelled,
  StreamingH5Writer,
  appendEncodedVideos,
  buildSerializableEmbedPlan,
  saveSlpStructureToBytes,
  saveSlpToBytes,
  type SlpVersion,
  type SlpWriteOptions,
  type Video,
} from "@talmolab/sleap-io.js";
import {
  canStreamPackage,
  derivePackageFilename,
  embedModeForLevel,
  labelsForLevel,
  videosToEmbed,
  type ExportPackageLevel,
} from "@/commands/exportPackageCommands";
import { withImageFormat, type PackageImageOptions } from "@/lib/packageImageFormat";
import { ensureProjectPreviewFrame } from "@/lib/previewCapture";
import {
  browserVideoFile,
  getBasename,
  prepareVideosForFrameReads,
} from "@/lib/resolveVideos";
import { saveEmbeddedPkgStreaming } from "@/lib/saveEmbeddedPkgStreaming";
import type { UnlabeledAs } from "@/lib/slpFormatStatus";
import { fileSize } from "@/lib/nativeRange";
import { removeFile } from "@/lib/nativeWrite";
import { sleapCmd } from "@/lib/sleapPlugin";
import {
  createFfmpegFrameReader,
  createTauriExtractFramesDeps,
} from "@/lib/transcode/extractFrames";
import { getPlatform, isTauri } from "@/platform/index";
import { useAppStore } from "@/stores/appStore";
import { UploadCancelledError, type UploadSourcePayload } from "./uploadClient";

export type UploadMode = "embedded_existing" | "package" | "multifile" | "labels_only";

const COMPANION_VIDEO_EXTS = new Set([
  "mp4",
  "avi",
  "mov",
  "mkv",
  "webm",
  "h5",
  "hdf5",
]);

const H5WASM_URL =
  typeof location !== "undefined"
    ? `${location.origin}/h5wasm/h5wasm.js`
    : undefined;

export interface CompanionVideoCandidate {
  videoIndex: number;
  video: Video;
  filename: string;
  ext: string;
  supported: boolean;
  isRemoteUrl: boolean;
  localPath: string | null;
  browserFile: File | null;
  size: number | null;
}

export interface ProjectUploadSummary {
  allEmbedded: boolean;
  hasEmbeddedAny: boolean;
  canReuseExistingFile: boolean;
  existingFileSize: number | null;
  defaultMode: UploadMode;
  defaultName: string;
  companions: CompanionVideoCandidate[];
}

export interface PrepareUploadOptions {
  mode: UploadMode;
  packageLevel: ExportPackageLevel;
  image?: PackageImageOptions;
  slpVersion?: SlpVersion;
  unlabeledAs?: UnlabeledAs;
  /** Selected companion video indices for `mode === "multifile"`. */
  selectedCompanionIndices?: number[];
  /** Browser-attached local Files keyed by videoIndex for `mode === "multifile"`. */
  attachedBrowserFiles?: Record<number, File>;
  signal?: AbortSignal;
  onProgress?: (detail: string, percent?: number) => void;
}

export interface PreparedUpload {
  payloads: UploadSourcePayload[];
  totalBytes: number;
  cleanup: () => Promise<void>;
}

function getExtension(filename: string): string {
  const base = getBasename(filename);
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function defaultDatasetName(filename: string | null): string {
  if (!filename) return "labels";
  return filename
    .replace(/\.pkg\.slp$/i, "")
    .replace(/\.slp$/i, "")
    .replace(/\.json$/i, "")
    .trim() || "labels";
}

function ensureSlpFilename(filename: string | null): string {
  const base = (filename ?? "labels.slp").trim() || "labels.slp";
  if (base.toLowerCase().endsWith(".slp")) return base;
  return `${base.replace(/\.[^.]+$/, "")}.slp`;
}

async function tauriPathExists(path: string): Promise<boolean> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<boolean>(sleapCmd("path_exists"), { path });
  } catch {
    return false;
  }
}

async function allocateTempPath(filename: string): Promise<string> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<string>(sleapCmd("sleap_share_temp_path"), { filename });
}

function isOpfsAvailable(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.storage &&
    typeof navigator.storage.getDirectory === "function" &&
    typeof Worker !== "undefined"
  );
}

async function removeOpfsEntry(name: string): Promise<void> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(name);
  } catch {
    /* best-effort cleanup */
  }
}

async function resolveDesktopVideoPath(video: Video): Promise<string | null> {
  const candidates: string[] = [];
  if (typeof video.filename === "string" && video.filename) {
    candidates.push(video.filename);
  }
  const backendFile = (video.backend as { filename?: unknown } | null)?.filename;
  if (typeof backendFile === "string" && backendFile && !candidates.includes(backendFile)) {
    candidates.push(backendFile);
  }
  for (const cand of candidates) {
    if (/^https?:\/\//i.test(cand)) continue;
    if (await tauriPathExists(cand)) return cand;
  }
  return null;
}

/** Inspect the currently loaded project to populate UploadToShareDialog defaults. */
export async function inspectProjectForUpload(): Promise<ProjectUploadSummary | null> {
  const state = useAppStore.getState();
  const { labels, filename, projectPath, projectFile, projectFileHandle, hasChanges, pendingExport } =
    state;
  if (!labels) return null;

  const videos = labels.videos ?? [];
  const allEmbedded = videos.length > 0 && videos.every((v) => v.hasEmbeddedImages);
  const hasEmbeddedAny = videos.some((v) => v.hasEmbeddedImages);

  let existingFileSize: number | null = null;
  const canReuseExistingFile =
    allEmbedded &&
    !hasChanges &&
    !pendingExport &&
    (isTauri ? !!projectPath : !!(projectFileHandle || projectFile));

  if (canReuseExistingFile) {
    try {
      if (isTauri && projectPath) {
        existingFileSize = await fileSize(projectPath);
      } else if (projectFileHandle) {
        existingFileSize = (await projectFileHandle.getFile()).size;
      } else if (projectFile) {
        existingFileSize = projectFile.size;
      }
    } catch {
      existingFileSize = null;
    }
  }

  const companions: CompanionVideoCandidate[] = [];
  for (let i = 0; i < videos.length; i++) {
    const video = videos[i];
    if (video.hasEmbeddedImages) continue;
    const rawName = Array.isArray(video.filename)
      ? video.filename[0] ?? ""
      : video.filename ?? "";
    const isRemoteUrl = /^https?:\/\//i.test(rawName);
    const basename = getBasename(rawName || `video_${i}.mp4`);
    const ext = getExtension(basename);
    const supported = !Array.isArray(video.filename) && COMPANION_VIDEO_EXTS.has(ext);

    let localPath: string | null = null;
    let browserFile: File | null = null;
    let size: number | null = null;

    if (isTauri && !isRemoteUrl && supported) {
      localPath = await resolveDesktopVideoPath(video);
      if (localPath) {
        try {
          size = await fileSize(localPath);
        } catch {
          size = null;
        }
      }
    } else if (!isTauri && !isRemoteUrl && supported) {
      browserFile = browserVideoFile(video);
      size = browserFile ? browserFile.size : null;
    }

    companions.push({
      videoIndex: i,
      video,
      filename: basename,
      ext,
      supported,
      isRemoteUrl,
      localPath,
      browserFile,
      size,
    });
  }

  let defaultMode: UploadMode;
  if (allEmbedded) {
    defaultMode = "embedded_existing";
  } else if (labels.labeledFrames.length > 0) {
    defaultMode = "package";
  } else if (companions.some((c) => c.supported && (c.localPath || c.browserFile))) {
    defaultMode = "multifile";
  } else {
    defaultMode = "labels_only";
  }

  return {
    allEmbedded,
    hasEmbeddedAny,
    canReuseExistingFile,
    existingFileSize,
    defaultMode,
    defaultName: defaultDatasetName(filename),
    companions,
  };
}

function buildSlpWriteOptions(
  slpVersion?: SlpVersion,
  unlabeledAs?: UnlabeledAs
): Partial<SlpWriteOptions> {
  const opts: Partial<SlpWriteOptions> = {};
  if (slpVersion && slpVersion !== "auto") {
    opts.slpVersion = slpVersion;
    if (slpVersion === "v2" && unlabeledAs) {
      opts.unlabeledAs = unlabeledAs;
    }
  }
  return opts;
}

function makeCancelAwareProgress(
  signal: AbortSignal | undefined,
  onProgress: ((detail: string, percent?: number) => void) | undefined,
  twoPasses: boolean
): (current: number, total: number, message?: string) => boolean {
  return (current, total, message) => {
    if (signal?.aborted) return false;
    const writing = message === "Writing frames";
    const frac = total > 0 ? current / total : 0;
    const pct = !twoPasses ? frac : writing ? 0.9 + 0.1 * frac : 0.9 * frac;
    onProgress?.(
      `${writing ? "Writing frames" : "Embedding frames"} (${current}/${total})`,
      Math.round(pct * 100)
    );
    return true;
  };
}

function ffmpegFrameReader() {
  const deps = createTauriExtractFramesDeps();
  return (video: Video, frames: readonly number[]) =>
    createFfmpegFrameReader(video, frames, deps);
}

/** Build uploadable payload(s) for the chosen mode, with a guaranteed cleanup hook. */
export async function prepareUploadPayloads(
  summary: ProjectUploadSummary,
  opts: PrepareUploadOptions
): Promise<PreparedUpload> {
  const state = useAppStore.getState();
  const {
    labels,
    filename,
    projectPath,
    projectFile,
    projectFileHandle,
    video: currentVideo,
    frameIdx: currentFrameIdx,
  } = state;
  if (!labels) {
    throw new Error("No project is currently loaded.");
  }

  const tempPaths: string[] = [];
  const tempOpfsNames: string[] = [];

  const cleanup = async () => {
    for (const p of tempPaths) {
      await removeFile(p).catch(() => {});
    }
    for (const name of tempOpfsNames) {
      await removeOpfsEntry(name);
    }
  };

  const labelsWithLayout = labels as unknown as { _slpLayout?: unknown };
  const prevLayout = labelsWithLayout._slpLayout;
  const formatOpts = buildSlpWriteOptions(opts.slpVersion, opts.unlabeledAs);

  const stageBytes = async (
    bytes: Uint8Array,
    targetFilename: string,
    role?: string
  ): Promise<UploadSourcePayload> => {
    if (isTauri) {
      const tempPath = await allocateTempPath(targetFilename);
      tempPaths.push(tempPath);
      await (await getPlatform()).writeFile(tempPath, bytes);
      return {
        kind: "path",
        path: tempPath,
        filename: targetFilename,
        size: bytes.byteLength,
        role,
      };
    }
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const blob = new Blob([copy], { type: "application/octet-stream" });
    return {
      kind: "blob",
      blob,
      filename: targetFilename,
      size: blob.size,
      role,
    };
  };

  try {
    if (opts.signal?.aborted) throw new UploadCancelledError();

    // 1. Existing embedded .pkg.slp
    if (opts.mode === "embedded_existing") {
      const targetName = ensureSlpFilename(filename ?? "labels.pkg.slp");
      if (summary.canReuseExistingFile && (!opts.slpVersion || opts.slpVersion === "auto")) {
        if (isTauri && projectPath) {
          const size = await fileSize(projectPath);
          const payload: UploadSourcePayload = {
            kind: "path",
            path: projectPath,
            filename: targetName,
            size,
          };
          return { payloads: [payload], totalBytes: size, cleanup };
        }
        const source = projectFileHandle
          ? await projectFileHandle.getFile()
          : projectFile;
        if (source) {
          const payload: UploadSourcePayload = {
            kind: "blob",
            blob: source,
            filename: targetName,
            size: source.size,
          };
          return { payloads: [payload], totalBytes: source.size, cleanup };
        }
      }

      // Dirty or explicit format conversion of an embedded package
      opts.onProgress?.("Packaging edits…", 0);
      if (isTauri && (await canStreamPackage()) && projectPath) {
        const tempPath = await allocateTempPath(targetName);
        tempPaths.push(tempPath);
        await saveEmbeddedPkgStreaming(labels, tempPath, projectPath, {
          embed: false,
          onProgress: makeCancelAwareProgress(opts.signal, opts.onProgress, false),
          ...formatOpts,
        });
        const size = await fileSize(tempPath);
        return {
          payloads: [{ kind: "path", path: tempPath, filename: targetName, size }],
          totalBytes: size,
          cleanup,
        };
      }

      // Browser OPFS re-save when source File/Handle exists
      const browserSource = projectFileHandle ?? projectFile;
      if (!isTauri && browserSource && isOpfsAvailable()) {
        const sourceFile =
          "getFile" in browserSource ? await browserSource.getFile() : browserSource;
        const structureBytes = await saveSlpStructureToBytes(labels, {
          embed: false,
          ...formatOpts,
        });
        const plan = await buildSerializableEmbedPlan(labels, false, sourceFile.name);
        const opfsName = `sleap-share-upload-${Date.now()}-${Math.random().toString(16).slice(2)}.slp`;
        tempOpfsNames.push(opfsName);

        const writer = new StreamingH5Writer();
        try {
          await writer.openAppendOpfs(
            opfsName,
            sourceFile,
            structureBytes,
            sourceFile.name,
            H5WASM_URL
          );
          if (plan.entries.length > 0) {
            const res = await writer.appendEmbeddedVideos(plan.entries, (done, total) => {
              opts.onProgress?.(
                `Copying embedded images (${done}/${total})`,
                total > 0 ? Math.round((done / total) * 100) : 0
              );
            });
            if (res.success !== true) {
              throw new Error(res.error || "Failed to assemble embedded package");
            }
          }
        } finally {
          await writer.close().catch(() => {});
        }
        const root = await navigator.storage.getDirectory();
        const fh = await root.getFileHandle(opfsName, { create: false });
        const file = await fh.getFile();
        return {
          payloads: [{ kind: "blob", blob: file, filename: targetName, size: file.size }],
          totalBytes: file.size,
          cleanup,
        };
      }

      const bytes = await saveSlpToBytes(labels, { embed: false, ...formatOpts });
      const payload = await stageBytes(bytes, targetName);
      return { payloads: [payload], totalBytes: payload.size, cleanup };
    }

    // 2. Build portable .pkg.slp with embedded frames
    if (opts.mode === "package") {
      const targetName = derivePackageFilename(filename);
      const mode = embedModeForLevel(opts.packageLevel);
      const exportLabels = labelsForLevel(labels, opts.packageLevel);
      const embedVideos = videosToEmbed(exportLabels, opts.packageLevel);

      opts.onProgress?.("Preparing video decoders…", 0);
      await prepareVideosForFrameReads(embedVideos);
      if (opts.signal?.aborted) throw new UploadCancelledError();

      const hasEmbedded = exportLabels.videos.some((v) => v.hasEmbeddedImages);

      if (isTauri && (await canStreamPackage()) && !hasEmbedded) {
        const tempPath = await allocateTempPath(targetName);
        tempPaths.push(tempPath);
        await saveEmbeddedPkgStreaming(exportLabels, tempPath, null, {
          embed: mode,
          onProgress: makeCancelAwareProgress(opts.signal, opts.onProgress, false),
          frameReader: ffmpegFrameReader(),
          image: opts.image,
          ...formatOpts,
        });
        const size = await fileSize(tempPath);
        return {
          payloads: [{ kind: "path", path: tempPath, filename: targetName, size }],
          totalBytes: size,
          cleanup,
        };
      }

      if (!isTauri && isOpfsAvailable() && !hasEmbedded) {
        const baseStructOpts = withImageFormat({ embed: mode }, opts.image);
        const structureBytes = await saveSlpStructureToBytes(exportLabels, {
          ...baseStructOpts,
          ...formatOpts,
        });
        const plan = await buildSerializableEmbedPlan(
          exportLabels,
          mode,
          "",
          withImageFormat({ allowEncode: true }, opts.image)
        );
        const opfsName = `sleap-share-pkg-${Date.now()}-${Math.random().toString(16).slice(2)}.slp`;
        tempOpfsNames.push(opfsName);

        const root = await navigator.storage.getDirectory();
        const fh = await root.getFileHandle(opfsName, { create: true });
        const seed = await fh.createWritable();
        await seed.write(structureBytes as Uint8Array<ArrayBuffer>);
        await seed.close();

        if (plan.encodeEntries.length > 0) {
          const writer = new StreamingH5Writer();
          try {
            await writer.openWriteOpfs(opfsName, structureBytes.byteLength, H5WASM_URL);
            await appendEncodedVideos(writer, exportLabels, plan.encodeEntries, {
              onProgress: makeCancelAwareProgress(opts.signal, opts.onProgress, false),
            });
          } finally {
            await writer.close().catch(() => {});
          }
        }
        const file = await fh.getFile();
        return {
          payloads: [{ kind: "blob", blob: file, filename: targetName, size: file.size }],
          totalBytes: file.size,
          cleanup,
        };
      }

      const writeOpts: SlpWriteOptions = {
        ...withImageFormat(
          {
            embed: mode,
            onProgress: makeCancelAwareProgress(opts.signal, opts.onProgress, true),
          },
          opts.image
        ),
        ...formatOpts,
      };
      const bytes = await saveSlpToBytes(exportLabels, writeOpts);
      const payload = await stageBytes(bytes, targetName);
      return { payloads: [payload], totalBytes: payload.size, cleanup };
    }

    // 3. Labels (.slp) + companion videos OR Labels only (.slp)
    opts.onProgress?.("Capturing preview & serializing labels…", 15);
    await ensureProjectPreviewFrame(labels, {
      currentVideo,
      currentFrameIdx,
    });
    if (opts.signal?.aborted) throw new UploadCancelledError();

    const slpBytes = await saveSlpToBytes(labels, {
      embed: false,
      ...formatOpts,
    });
    const slpName = ensureSlpFilename(filename);
    const slpPayload = await stageBytes(slpBytes, slpName, "labels");

    if (opts.mode === "labels_only") {
      return { payloads: [slpPayload], totalBytes: slpPayload.size, cleanup };
    }

    // Multifile: attach selected companion videos
    const selectedSet = new Set(opts.selectedCompanionIndices ?? []);
    const payloads: UploadSourcePayload[] = [slpPayload];

    for (const c of summary.companions) {
      if (!selectedSet.has(c.videoIndex) || !c.supported) continue;
      if (isTauri && c.localPath) {
        const size = c.size ?? (await fileSize(c.localPath));
        payloads.push({
          kind: "path",
          path: c.localPath,
          filename: c.filename,
          size,
          role: "video",
        });
      } else {
        const file = opts.attachedBrowserFiles?.[c.videoIndex] ?? c.browserFile;
        if (file) {
          payloads.push({
            kind: "blob",
            blob: file,
            filename: c.filename || file.name,
            size: file.size,
            role: "video",
          });
        }
      }
    }

    const totalBytes = payloads.reduce((sum, p) => sum + p.size, 0);
    return { payloads, totalBytes, cleanup };
  } catch (err) {
    await cleanup();
    if (err instanceof ExportCancelled || opts.signal?.aborted) {
      throw new UploadCancelledError();
    }
    throw err;
  } finally {
    labelsWithLayout._slpLayout = prevLayout;
  }
}
