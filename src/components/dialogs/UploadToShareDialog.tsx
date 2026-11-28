/**
 * "Upload to SLEAP Share…" dialog (`File ▸ Upload to SLEAP Share…`).
 *
 * Supports anonymous & GitHub-authenticated uploads, all 3 upload modes
 * (embedded `.pkg.slp`, `.slp` + companion videos, labels-only `.slp`),
 * private visibility, superuser permanent storage, optional notes / GitHub
 * issue linking, cancellable preparation + upload progress, and a copyable
 * success screen.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CloudUpload,
  Copy,
  ExternalLink,
  Film,
  Lock,
  Paperclip,
  X,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Progress } from "@/components/ui/progress";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppStore } from "@/stores/appStore";
import { useSleapShareStore } from "@/stores/sleapShareStore";
import { openExternal } from "@/lib/menu/menuActions";
import { toast } from "@/lib/notify";
import {
  frameCountForLevel,
  type ExportPackageLevel,
} from "@/commands/exportPackageCommands";
import { inspectProjectFormat } from "@/lib/slpFormatStatus";
import {
  PackageImageFormatFields,
  usePackageImageChoice,
} from "./PackageImageFormatFields";
import {
  DEFAULT_SLP_FORMAT_CHOICE,
  SlpFormatFields,
  type SlpFormatExportChoice,
} from "./SlpFormatFields";
import { SleapShareAccountCard } from "./SleapShareAccountCard";
import { formatBytes, getSleapShareBaseUrl } from "@/lib/sleapShare/config";
import {
  inspectProjectForUpload,
  prepareUploadPayloads,
  type ProjectUploadSummary,
  type UploadMode,
} from "@/lib/sleapShare/prepareUpload";
import {
  ANON_MAX_UPLOAD_BYTES,
  AUTH_MAX_UPLOAD_BYTES,
  UploadCancelledError,
  uploadToSleapShare,
  type UploadResult,
} from "@/lib/sleapShare/uploadClient";

const GITHUB_REPOS = [
  "talmolab/sleap",
  "talmolab/sleap-app",
  "talmolab/sleap-nn",
  "talmolab/sleap-io",
  "talmolab/sleap-rtc",
  "talmolab/sleap-share",
] as const;

type DialogStage = "configure" | "uploading" | "success";

export function UploadToShareDialog() {
  const open = useSleapShareStore((s) => s.uploadToShareDialogOpen);
  const setOpen = useSleapShareStore((s) => s.setUploadToShareDialogOpen);
  const credentials = useSleapShareStore((s) => s.credentials);
  const profile = useSleapShareStore((s) => s.profile);

  const labels = useAppStore((s) => s.labels);
  const editSeq = useAppStore((s) => s.editSeq);

  const [stage, setStage] = useState<DialogStage>("configure");
  const [summary, setSummary] = useState<ProjectUploadSummary | null>(null);
  const [inspecting, setInspecting] = useState(false);

  // Configuration state
  const [mode, setMode] = useState<UploadMode>("package");
  const [packageLevel, setPackageLevel] = useState<ExportPackageLevel>("training");
  const image = usePackageImageChoice(open);
  const [slpFormat, setSlpFormat] = useState<SlpFormatExportChoice>(
    DEFAULT_SLP_FORMAT_CHOICE
  );
  const [selectedCompanions, setSelectedCompanions] = useState<number[]>([]);
  const [attachedFiles, setAttachedFiles] = useState<Record<number, File>>({});

  const [name, setName] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [permanent, setPermanent] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [notes, setNotes] = useState("");
  const [linkGitHub, setLinkGitHub] = useState(false);
  const [githubRepo, setGithubRepo] = useState<string>("talmolab/sleap-app");
  const [githubType, setGithubType] = useState<"issue" | "pr" | "discussion">("issue");
  const [githubNumber, setGithubNumber] = useState("");

  // Upload progress & result state
  const [progressPct, setProgressPct] = useState(0);
  const [progressDetail, setProgressDetail] = useState("");
  const [progressBytes, setProgressBytes] = useState<{
    loaded: number;
    total: number;
  } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [copied, setCopied] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const attachingVideoIdxRef = useRef<number | null>(null);

  const formatStatus = useMemo(
    () => (open ? inspectProjectFormat(labels) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [open, labels, editSeq]
  );

  // Inspect project whenever the dialog opens
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setStage("configure");
    setUploadError(null);
    setResult(null);
    setCopied(false);
    setSlpFormat(DEFAULT_SLP_FORMAT_CHOICE);
    setAttachedFiles({});
    setInspecting(true);

    inspectProjectForUpload()
      .then((res) => {
        if (!alive) return;
        setSummary(res);
        if (res) {
          setMode(res.defaultMode);
          setName(res.defaultName);
          const readyIds = res.companions
            .filter((c) => c.supported && (c.localPath || c.browserFile))
            .map((c) => c.videoIndex);
          setSelectedCompanions(readyIds);
        }
      })
      .finally(() => {
        if (alive) setInspecting(false);
      });

    return () => {
      alive = false;
    };
  }, [open]);

  // Clear auth-only flags if user signs out inside the dialog
  useEffect(() => {
    if (!credentials) {
      setIsPrivate(false);
      setPermanent(false);
    }
  }, [credentials]);

  useEffect(() => {
    if (!profile?.isSuperuser) {
      setPermanent(false);
    }
  }, [profile?.isSuperuser]);

  const maxUploadBytes = credentials ? AUTH_MAX_UPLOAD_BYTES : ANON_MAX_UPLOAD_BYTES;

  const knownUploadBytes = useMemo(() => {
    if (!summary) return null;
    if (mode === "embedded_existing") {
      return summary.existingFileSize;
    }
    if (mode === "multifile") {
      let total = 0;
      for (const c of summary.companions) {
        if (!selectedCompanions.includes(c.videoIndex) || !c.supported) continue;
        const attached = attachedFiles[c.videoIndex];
        const sz = attached ? attached.size : c.size;
        if (sz != null) total += sz;
      }
      return total > 0 ? total : null;
    }
    return null;
  }, [summary, mode, selectedCompanions, attachedFiles]);

  const exceedsSingleLimit =
    knownUploadBytes != null && knownUploadBytes > maxUploadBytes;

  const exceedsQuota =
    !!profile &&
    !profile.quota.unlimited &&
    knownUploadBytes != null &&
    profile.quota.usedBytes + knownUploadBytes > profile.quota.limitBytes;

  const selectedMultifileReadyCount = useMemo(() => {
    if (!summary) return 0;
    return summary.companions.filter(
      (c) =>
        selectedCompanions.includes(c.videoIndex) &&
        c.supported &&
        !!(c.localPath || c.browserFile || attachedFiles[c.videoIndex])
    ).length;
  }, [summary, selectedCompanions, attachedFiles]);

  const canSubmit = useMemo(() => {
    if (!summary || inspecting || !labels) return false;
    if (mode === "package" && !image.valid) return false;
    if (mode === "multifile" && selectedMultifileReadyCount === 0) return false;
    if (
      slpFormat.slpVersion === "v2" &&
      slpFormat.unlabeledAs === "error" &&
      (formatStatus?.summary.unlabeledPoints ?? 0) > 0
    ) {
      return false;
    }
    if (exceedsSingleLimit || exceedsQuota) return false;
    return true;
  }, [
    summary,
    inspecting,
    labels,
    mode,
    image.valid,
    selectedMultifileReadyCount,
    slpFormat,
    formatStatus,
    exceedsSingleLimit,
    exceedsQuota,
  ]);

  const toggleCompanion = useCallback((idx: number, checked: boolean) => {
    setSelectedCompanions((prev) =>
      checked ? (prev.includes(idx) ? prev : [...prev, idx]) : prev.filter((i) => i !== idx)
    );
  }, []);

  const handleAttachBrowserVideo = useCallback((videoIdx: number) => {
    attachingVideoIdxRef.current = videoIdx;
    fileInputRef.current?.click();
  }, []);

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      const idx = attachingVideoIdxRef.current;
      e.target.value = "";
      if (!file || idx == null) return;
      setAttachedFiles((prev) => ({ ...prev, [idx]: file }));
      setSelectedCompanions((prev) => (prev.includes(idx) ? prev : [...prev, idx]));
    },
    []
  );

  const handleStartUpload = useCallback(async () => {
    if (!summary || !canSubmit) return;
    if (mode === "package") image.remember();

    const controller = new AbortController();
    abortRef.current = controller;
    setUploadError(null);
    setStage("uploading");
    setProgressPct(0);
    setProgressBytes(null);
    setProgressDetail("Preparing files…");

    let cleanup: (() => Promise<void>) | undefined;
    try {
      const prepared = await prepareUploadPayloads(summary, {
        mode,
        packageLevel,
        image: mode === "package" ? image.choice : undefined,
        slpVersion: slpFormat.slpVersion,
        unlabeledAs: slpFormat.unlabeledAs,
        selectedCompanionIndices: selectedCompanions,
        attachedBrowserFiles: attachedFiles,
        signal: controller.signal,
        onProgress: (detail, pct) => {
          setProgressDetail(detail);
          if (pct !== undefined) {
            // Preparation occupies 0–35% when embedding frames, else brief
            setProgressPct(Math.round(pct * (mode === "package" ? 0.35 : 0.15)));
          }
        },
      });
      cleanup = prepared.cleanup;

      if (prepared.totalBytes > maxUploadBytes) {
        throw new Error(
          credentials
            ? `Prepared upload (${formatBytes(prepared.totalBytes)}) exceeds the ${formatBytes(maxUploadBytes)} per-upload limit.`
            : `Prepared upload (${formatBytes(prepared.totalBytes)}) exceeds the 100 MB anonymous limit. Sign in with GitHub for up to 5 GB.`
        );
      }

      const parsedNum = Number(githubNumber.trim());
      const uploaded = await uploadToSleapShare(
        prepared.payloads,
        {
          name: name.trim() || undefined,
          notes: notes.trim() || undefined,
          isPrivate: credentials ? isPrivate : false,
          permanent: profile?.isSuperuser ? permanent : false,
          isSupport: linkGitHub,
          githubRepo: linkGitHub ? githubRepo : undefined,
          githubType: linkGitHub ? githubType : undefined,
          githubNumber:
            linkGitHub && Number.isInteger(parsedNum) && parsedNum > 0
              ? parsedNum
              : undefined,
        },
        {
          baseUrl: getSleapShareBaseUrl(),
          token: credentials?.token,
          signal: controller.signal,
          onProgress: (prog) => {
            setProgressDetail(prog.detail ?? "Uploading…");
            setProgressBytes({
              loaded: prog.loadedBytes,
              total: prog.totalBytes,
            });
            const prepFloor = mode === "package" ? 35 : 15;
            if (prog.stage === "completing") {
              setProgressPct(97);
            } else if (prog.totalBytes > 0) {
              const frac = prog.loadedBytes / prog.totalBytes;
              setProgressPct(Math.round(prepFloor + frac * (95 - prepFloor)));
            }
          },
        }
      );

      setProgressPct(100);
      setResult(uploaded);
      setStage("success");
      // Refresh user quota in background if signed in
      if (credentials) {
        void useSleapShareStore.getState().hydrateAuth(true);
      }
    } catch (err) {
      if (err instanceof UploadCancelledError || controller.signal.aborted) {
        setStage("configure");
        toast.info("Upload cancelled");
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setUploadError(msg);
        setStage("configure");
      }
    } finally {
      abortRef.current = null;
      if (cleanup) {
        await cleanup().catch(() => {});
      }
    }
  }, [
    summary,
    canSubmit,
    mode,
    image,
    packageLevel,
    slpFormat,
    selectedCompanions,
    attachedFiles,
    maxUploadBytes,
    credentials,
    name,
    notes,
    isPrivate,
    profile?.isSuperuser,
    permanent,
    linkGitHub,
    githubRepo,
    githubType,
    githubNumber,
  ]);

  const handleCancelUpload = useCallback(() => {
    abortRef.current?.abort();
    setProgressDetail("Cancelling…");
  }, []);

  const handleCopyLink = useCallback(async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.shareUrl);
      setCopied(true);
      toast.success("Copied SLEAP Share link");
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.info("Copy link", { description: result.shareUrl });
    }
  }, [result]);

  if (!labels) return null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (stage === "uploading") return; // require explicit Cancel while uploading
        setOpen(next);
      }}
    >
      <DialogContent className="sm:max-w-[540px] max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CloudUpload className="h-4 w-4 text-primary" />
            Upload to SLEAP Share
          </DialogTitle>
        </DialogHeader>

        {/* Hidden browser file picker for attaching local companion video files */}
        <input
          ref={fileInputRef}
          type="file"
          accept=".mp4,.avi,.mov,.mkv,.webm,.h5,.hdf5"
          className="hidden"
          onChange={handleFileInputChange}
        />

        {stage === "uploading" && (
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-foreground truncate pr-2">
                  {progressDetail || "Uploading…"}
                </span>
                <span className="font-mono text-muted-foreground shrink-0">
                  {progressPct}%
                </span>
              </div>
              <Progress value={progressPct} className="h-2" />
              {progressBytes && progressBytes.total > 0 && (
                <div className="text-xs text-muted-foreground">
                  {formatBytes(progressBytes.loaded)} / {formatBytes(progressBytes.total)}
                </div>
              )}
            </div>
            <div className="flex justify-end">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleCancelUpload}
              >
                <X className="h-3.5 w-3.5" />
                Cancel upload
              </Button>
            </div>
          </div>
        )}

        {stage === "success" && result && (
          <div className="space-y-4 py-2">
            <div className="flex items-center gap-2.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
              <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" />
              <div className="min-w-0">
                <div className="text-sm font-medium text-foreground">
                  Uploaded to SLEAP Share
                </div>
                <div className="text-xs text-muted-foreground">
                  Anyone with access can view it in the browser or open it directly in SLEAP.
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={result.shareUrl}
                className="font-mono text-xs select-all"
                onFocus={(e) => e.currentTarget.select()}
                data-testid="upload-share-result-url"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void handleCopyLink()}
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {copied ? "Copied" : "Copy Link"}
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <Badge variant={result.isPrivate ? "secondary" : "outline"} className="gap-1">
                {result.isPrivate && <Lock className="h-2.5 w-2.5" />}
                {result.isPrivate ? "Private" : "Unlisted"}
              </Badge>
              <Badge variant="outline">
                {result.permanent
                  ? "Permanent"
                  : result.expiresAt
                    ? `Expires ${new Date(result.expiresAt).toLocaleDateString()}`
                    : credentials
                      ? "30-day retention"
                      : "7-day retention"}
              </Badge>
              <Badge variant="outline">{formatBytes(result.fileSize)}</Badge>
              {result.memberCount && result.memberCount > 1 && (
                <Badge variant="outline">{result.memberCount} files</Badge>
              )}
            </div>

            <div className="flex justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void openExternal(result.shareUrl)}
              >
                Open on SLEAP Share
                <ExternalLink className="h-3.5 w-3.5" />
              </Button>
              <Button type="button" size="sm" onClick={() => setOpen(false)}>
                Done
              </Button>
            </div>
          </div>
        )}

        {stage === "configure" && (
          <div className="space-y-4">
            <SleapShareAccountCard />

            {uploadError && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{uploadError}</span>
              </div>
            )}

            {/* What to upload */}
            {summary && (
              <div className="space-y-2.5">
                <div className="text-xs font-medium text-foreground">What to upload</div>

                {summary.allEmbedded ? (
                  <div className="rounded-md border border-border bg-muted/25 p-3 text-xs space-y-1">
                    <div className="font-medium text-foreground">
                      Embedded labels package (<code>.pkg.slp</code>)
                    </div>
                    <div className="text-muted-foreground">
                      {summary.canReuseExistingFile
                        ? `Uploading existing package directly (${
                            summary.existingFileSize != null
                              ? formatBytes(summary.existingFileSize)
                              : "size pending"
                          }).`
                        : "Your unsaved edits will be packaged into a temporary .pkg.slp for upload without modifying the local file."}
                    </div>
                  </div>
                ) : (
                  <RadioGroup
                    value={mode}
                    onValueChange={(v) => setMode(v as UploadMode)}
                    className="space-y-2"
                  >
                    {/* Option 1: Portable .pkg.slp */}
                    <div className="rounded-md border border-border p-3 space-y-2.5">
                      <label
                        htmlFor="upload-mode-package"
                        className="flex items-start gap-2.5 cursor-pointer"
                      >
                        <RadioGroupItem
                          value="package"
                          id="upload-mode-package"
                          className="mt-0.5"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 text-xs font-medium text-foreground">
                            Labels package (.pkg.slp)
                            <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                              Recommended
                            </span>
                          </div>
                          <div className="text-[11px] text-muted-foreground">
                            Self-contained file with embedded labeled frames — plays anywhere without uploading full videos.
                          </div>
                        </div>
                      </label>

                      {mode === "package" && (
                        <div className="space-y-3 pl-6 pt-1 border-t border-border/60">
                          <div className="space-y-1.5">
                            <div className="text-xs font-medium">Frames to embed</div>
                            <RadioGroup
                              value={packageLevel}
                              onValueChange={(v) =>
                                setPackageLevel(v as ExportPackageLevel)
                              }
                              className="space-y-1"
                            >
                              {(
                                [
                                  ["user", "User labeled frames"],
                                  ["training", "User labeled + suggested frames"],
                                  ["full", "All labeled + predicted frames"],
                                ] as const
                              ).map(([lvl, title]) => {
                                const cnt = frameCountForLevel(labels, lvl);
                                return (
                                  <label
                                    key={lvl}
                                    htmlFor={`upload-pkg-lvl-${lvl}`}
                                    className="flex items-center justify-between gap-2 text-xs cursor-pointer"
                                  >
                                    <span className="flex items-center gap-2">
                                      <RadioGroupItem
                                        value={lvl}
                                        id={`upload-pkg-lvl-${lvl}`}
                                      />
                                      <span>{title}</span>
                                    </span>
                                    <span className="text-[11px] text-muted-foreground">
                                      {cnt.toLocaleString()} frame{cnt === 1 ? "" : "s"}
                                    </span>
                                  </label>
                                );
                              })}
                            </RadioGroup>
                          </div>

                          <PackageImageFormatFields
                            value={image.choice}
                            onChange={image.setChoice}
                            idPrefix="upload-pkg"
                          />
                        </div>
                      )}
                    </div>

                    {/* Option 2: Labels + companion videos */}
                    {summary.companions.length > 0 && (
                      <div className="rounded-md border border-border p-3 space-y-2.5">
                        <label
                          htmlFor="upload-mode-multifile"
                          className="flex items-start gap-2.5 cursor-pointer"
                        >
                          <RadioGroupItem
                            value="multifile"
                            id="upload-mode-multifile"
                            className="mt-0.5"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-medium text-foreground">
                              Labels (.slp) + companion video(s)
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              Upload the full video(s) alongside your labels for full-length scrubbing &amp; playback on SLEAP Share.
                            </div>
                          </div>
                        </label>

                        {mode === "multifile" && (
                          <div className="space-y-1.5 pl-6 pt-1 border-t border-border/60">
                            {summary.companions.map((c) => {
                              const attached = attachedFiles[c.videoIndex];
                              const ready =
                                c.supported &&
                                !!(c.localPath || c.browserFile || attached);
                              const sz = attached ? attached.size : c.size;
                              const checked =
                                ready && selectedCompanions.includes(c.videoIndex);

                              return (
                                <div
                                  key={c.videoIndex}
                                  className="flex items-center justify-between gap-2 text-xs py-0.5"
                                >
                                  <label className="flex items-center gap-2 min-w-0 cursor-pointer">
                                    <Checkbox
                                      checked={checked}
                                      disabled={!ready}
                                      onCheckedChange={(v) =>
                                        toggleCompanion(c.videoIndex, v === true)
                                      }
                                    />
                                    <Film className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                    <span className="truncate">{c.filename}</span>
                                  </label>
                                  <div className="flex items-center gap-1.5 shrink-0">
                                    {sz != null && (
                                      <span className="text-[11px] text-muted-foreground">
                                        {formatBytes(sz)}
                                      </span>
                                    )}
                                    {!c.supported ? (
                                      <Badge variant="outline" className="text-[10px]">
                                        Unsupported (.{c.ext || "?"})
                                      </Badge>
                                    ) : c.isRemoteUrl ? (
                                      <Badge variant="outline" className="text-[10px]">
                                        Remote URL
                                      </Badge>
                                    ) : !ready ? (
                                      <Button
                                        type="button"
                                        variant="outline"
                                        size="xs"
                                        onClick={() =>
                                          handleAttachBrowserVideo(c.videoIndex)
                                        }
                                      >
                                        <Paperclip className="h-3 w-3" />
                                        Attach file…
                                      </Button>
                                    ) : null}
                                  </div>
                                </div>
                              );
                            })}
                            {selectedMultifileReadyCount === 0 && (
                              <p className="text-[11px] text-amber-400">
                                Select or attach at least one supported video, or choose Labels package / Labels only.
                              </p>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Option 3: Labels only */}
                    <label
                      htmlFor="upload-mode-labels"
                      className="flex items-start gap-2.5 rounded-md border border-border p-3 cursor-pointer hover:bg-accent/30"
                    >
                      <RadioGroupItem
                        value="labels_only"
                        id="upload-mode-labels"
                        className="mt-0.5"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium text-foreground">
                          Labels only (.slp)
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          Smallest upload (poses, skeletons &amp; metadata only; no video frames).
                        </div>
                      </div>
                    </label>
                  </RadioGroup>
                )}

                {(!summary.allEmbedded || !summary.canReuseExistingFile) && (
                  <SlpFormatFields
                    value={slpFormat}
                    onChange={setSlpFormat}
                    summary={formatStatus?.summary ?? null}
                    effectiveAutoVersion={
                      formatStatus?.willWriteFormat3 ? "v3" : "v2"
                    }
                    idPrefix="upload-slp"
                    collapsible
                  />
                )}
              </div>
            )}

            {/* Dataset Details */}
            <div className="space-y-3">
              <div className="space-y-1.5">
                <label
                  htmlFor="upload-share-name"
                  className="text-xs font-medium text-foreground"
                >
                  Dataset name (optional)
                </label>
                <Input
                  id="upload-share-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My experiment labels"
                  maxLength={120}
                  className="h-8 text-xs"
                />
              </div>

              <div className="space-y-1.5">
                <div className="text-xs font-medium text-foreground">Visibility</div>
                <RadioGroup
                  value={isPrivate ? "private" : "unlisted"}
                  onValueChange={(v) => setIsPrivate(v === "private")}
                  className="grid grid-cols-2 gap-2"
                >
                  <label
                    htmlFor="upload-vis-unlisted"
                    className="flex items-start gap-2 rounded-md border border-border p-2.5 text-xs cursor-pointer hover:bg-accent/40"
                  >
                    <RadioGroupItem
                      value="unlisted"
                      id="upload-vis-unlisted"
                      className="mt-0.5"
                    />
                    <div>
                      <div className="font-medium text-foreground">Unlisted</div>
                      <div className="text-[11px] text-muted-foreground">
                        Anyone with the link
                      </div>
                    </div>
                  </label>
                  <label
                    htmlFor="upload-vis-private"
                    className={`flex items-start gap-2 rounded-md border border-border p-2.5 text-xs ${
                      credentials
                        ? "cursor-pointer hover:bg-accent/40"
                        : "opacity-55 cursor-not-allowed"
                    }`}
                  >
                    <RadioGroupItem
                      value="private"
                      id="upload-vis-private"
                      disabled={!credentials}
                      className="mt-0.5"
                    />
                    <div>
                      <div className="flex items-center gap-1 font-medium text-foreground">
                        <Lock className="h-3 w-3" />
                        Private
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {credentials
                          ? "Only you & share links"
                          : "Sign in to enable"}
                      </div>
                    </div>
                  </label>
                </RadioGroup>
              </div>

              {profile?.isSuperuser && (
                <label className="flex items-center gap-2 text-xs cursor-pointer">
                  <Checkbox
                    checked={permanent}
                    onCheckedChange={(v) => setPermanent(v === true)}
                  />
                  <span>Permanent storage (never expires)</span>
                </label>
              )}

              {/* Collapsible Notes & GitHub Issue */}
              <div className="rounded-md border border-border/70">
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-xs hover:bg-accent/50 transition-colors"
                >
                  <span className="flex items-center gap-1.5 font-medium text-foreground">
                    {showAdvanced ? (
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                    Notes &amp; GitHub issue (optional)
                  </span>
                  {(notes.trim() || linkGitHub) && (
                    <span className="text-[11px] text-primary">Configured</span>
                  )}
                </button>
                {showAdvanced && (
                  <div className="space-y-3 border-t border-border/70 px-3 py-2.5 text-xs">
                    <div className="space-y-1">
                      <label htmlFor="upload-share-notes" className="font-medium">
                        Notes
                      </label>
                      <textarea
                        id="upload-share-notes"
                        rows={2}
                        value={notes}
                        onChange={(e) => setNotes(e.target.value)}
                        placeholder="Describe this dataset or bug report…"
                        className="w-full rounded-md border border-input bg-transparent px-2.5 py-1.5 text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      />
                    </div>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <Checkbox
                        checked={linkGitHub}
                        onCheckedChange={(v) => setLinkGitHub(v === true)}
                      />
                      <span>Link to a SLEAP GitHub issue, PR, or discussion</span>
                    </label>
                    {linkGitHub && (
                      <div className="grid grid-cols-12 gap-2">
                        <div className="col-span-6">
                          <Select value={githubRepo} onValueChange={setGithubRepo}>
                            <SelectTrigger className="h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {GITHUB_REPOS.map((repo) => (
                                <SelectItem key={repo} value={repo}>
                                  {repo}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="col-span-3">
                          <Select
                            value={githubType}
                            onValueChange={(v) =>
                              setGithubType(v as "issue" | "pr" | "discussion")
                            }
                          >
                            <SelectTrigger className="h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="issue">Issue</SelectItem>
                              <SelectItem value="pr">PR</SelectItem>
                              <SelectItem value="discussion">Discussion</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="col-span-3">
                          <Input
                            type="number"
                            min={1}
                            placeholder="#123"
                            value={githubNumber}
                            onChange={(e) => setGithubNumber(e.target.value)}
                            className="h-8 text-xs"
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Preflight limit warnings */}
            {exceedsSingleLimit && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Selected upload ({formatBytes(knownUploadBytes!)}) exceeds the{" "}
                  {formatBytes(maxUploadBytes)} limit
                  {!credentials
                    ? " for anonymous uploads. Sign in with GitHub above for up to 5 GB."
                    : "."}
                </span>
              </div>
            )}
            {!exceedsSingleLimit && exceedsQuota && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2.5 text-xs text-destructive">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  Uploading {formatBytes(knownUploadBytes!)} would exceed your{" "}
                  {formatBytes(profile!.quota.limitBytes)} storage quota.
                </span>
              </div>
            )}

            <div className="flex items-center justify-between gap-2 pt-1">
              <div className="text-[11px] text-muted-foreground">
                {knownUploadBytes != null
                  ? `Estimated size: ${formatBytes(knownUploadBytes)} · Limit ${formatBytes(maxUploadBytes)}`
                  : `Limit: ${formatBytes(maxUploadBytes)}`}
              </div>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={!canSubmit}
                  onClick={() => void handleStartUpload()}
                >
                  <CloudUpload className="h-3.5 w-3.5" />
                  Upload to SLEAP Share
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
