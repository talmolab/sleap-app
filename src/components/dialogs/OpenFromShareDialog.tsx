/**
 * "Open from SLEAP Share / URL…" dialog.
 *
 * Lets users open any dataset from `slp.sh` (by shortcode, share URL, or member
 * URL), browse their own SLEAP Share uploads when signed in, or paste any direct
 * http(s) `.slp` URL — with live metadata preview, LabelsSet split picking, and
 * automatic companion-video streaming.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Cloud,
  Film,
  Link2,
  Loader2,
  Lock,
  RefreshCw,
  Search,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { SleapShareAccountCard } from "./SleapShareAccountCard";
import { useSleapShareStore } from "@/stores/sleapShareStore";
import {
  formatBytes,
  getSleapShareBaseUrl,
  parseShareInput,
} from "@/lib/sleapShare/config";
import {
  fetchSleapShareUserFiles,
  type SleapShareUserFile,
} from "@/lib/sleapShare/auth";
import {
  fetchShareMembers,
  fetchShareMetadata,
  type ShareDatasetMember,
  type ShareDatasetMembersResponse,
  type ShareDatasetMetadata,
} from "@/lib/sleapShare/openFromShare";
import { loadProjectFromUrl } from "@/lib/loadProject";

function isSlpMember(m: ShareDatasetMember): boolean {
  const lower = (m.filename || m.url || "").toLowerCase();
  return lower.endsWith(".slp") || lower.endsWith(".pkg");
}

function isVideoMember(m: ShareDatasetMember): boolean {
  return (
    !m.isPrimary &&
    (/^video\//i.test(m.contentType || "") ||
      /\.(mp4|mov|avi|mkv|webm|m4v|ogg|ogv|ts)$/i.test(m.filename || m.url || ""))
  );
}

function formatDate(ts: number): string {
  try {
    return new Date(ts).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

export function OpenFromShareDialog() {
  const open = useSleapShareStore((s) => s.openFromShareDialogOpen);
  const setOpen = useSleapShareStore((s) => s.setOpenFromShareDialogOpen);
  const credentials = useSleapShareStore((s) => s.credentials);

  const [tab, setTab] = useState<"url" | "uploads">("url");
  const [input, setInput] = useState("");
  const [opening, setOpening] = useState(false);

  // Live resolution state for SLEAP Share inputs
  const [resolving, setResolving] = useState(false);
  const [meta, setMeta] = useState<ShareDatasetMetadata | null>(null);
  const [membersResp, setMembersResp] = useState<ShareDatasetMembersResponse | null>(null);
  const [resolveNotFound, setResolveNotFound] = useState(false);
  const [selectedSlpUrl, setSelectedSlpUrl] = useState<string | null>(null);

  // "My Uploads" tab state
  const [files, setFiles] = useState<SleapShareUserFile[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const parsed = useMemo(
    () => parseShareInput(input, getSleapShareBaseUrl()),
    [input]
  );

  // Reset transient fields when dialog opens
  useEffect(() => {
    if (!open) return;
    setOpening(false);
    setResolveNotFound(false);
  }, [open]);

  // Debounced preview lookup for SLEAP Share links/shortcodes
  useEffect(() => {
    if (!open || !parsed || parsed.kind !== "share") {
      setMeta(null);
      setMembersResp(null);
      setResolveNotFound(false);
      setResolving(false);
      setSelectedSlpUrl(null);
      return;
    }

    let cancelled = false;
    setResolving(true);
    setResolveNotFound(false);

    const timer = setTimeout(async () => {
      const token = credentials?.token;
      const [m, mem] = await Promise.all([
        fetchShareMetadata(parsed.origin, parsed.shortcode, token),
        fetchShareMembers(parsed.origin, parsed.shortcode, token),
      ]);
      if (cancelled) return;
      setResolving(false);
      setMeta(m);
      setMembersResp(mem);
      if (!m && !mem) {
        setResolveNotFound(true);
        setSelectedSlpUrl(parsed.slpUrl);
        return;
      }
      const slpMembers = (mem?.members ?? []).filter(isSlpMember);
      const exact = slpMembers.find(
        (entry) =>
          entry.filename.toLowerCase() === parsed.member.toLowerCase()
      );
      if (exact) {
        setSelectedSlpUrl(new URL(exact.url, parsed.origin).href);
      } else if (slpMembers.length > 0) {
        const primary = slpMembers.find((entry) => entry.isPrimary) ?? slpMembers[0];
        setSelectedSlpUrl(new URL(primary.url, parsed.origin).href);
      } else {
        setSelectedSlpUrl(parsed.slpUrl);
      }
    }, 300);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, parsed, credentials?.token]);

  const loadMyUploads = useCallback(async () => {
    if (!credentials) {
      setFiles([]);
      setFilesError(null);
      return;
    }
    setFilesLoading(true);
    setFilesError(null);
    try {
      const list = await fetchSleapShareUserFiles(
        credentials.token,
        credentials.baseUrl
      );
      setFiles(list);
    } catch (err) {
      setFilesError(err instanceof Error ? err.message : "Failed to load uploads");
    } finally {
      setFilesLoading(false);
    }
  }, [credentials]);

  useEffect(() => {
    if (open && tab === "uploads" && credentials) {
      void loadMyUploads();
    }
  }, [open, tab, credentials, loadMyUploads]);

  const slpMembers = useMemo(
    () => (membersResp?.members ?? []).filter(isSlpMember),
    [membersResp]
  );
  const companionVideoCount = useMemo(
    () => (membersResp?.members ?? []).filter(isVideoMember).length,
    [membersResp]
  );

  const filteredFiles = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return files;
    return files.filter(
      (f) =>
        f.shortcode.toLowerCase().includes(q) ||
        f.filename.toLowerCase().includes(q) ||
        (f.name && f.name.toLowerCase().includes(q))
    );
  }, [files, searchQuery]);

  const handleOpenUrl = useCallback(
    async (targetUrl: string, displayName?: string) => {
      if (opening) return;
      setOpening(true);
      setOpen(false);
      try {
        await loadProjectFromUrl(targetUrl, {
          displayName,
          token: credentials?.token,
        });
      } finally {
        setOpening(false);
      }
    },
    [opening, setOpen, credentials?.token]
  );

  const handleSubmitUrl = useCallback(() => {
    if (!parsed) return;
    const url =
      parsed.kind === "share" ? selectedSlpUrl || parsed.slpUrl : parsed.slpUrl;
    const displayName =
      parsed.kind === "share"
        ? meta?.name || meta?.originalFilename || undefined
        : undefined;
    void handleOpenUrl(url, displayName);
  }, [parsed, selectedSlpUrl, meta, handleOpenUrl]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!opening) setOpen(next);
      }}
    >
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Cloud className="h-4 w-4 text-primary" />
            Open from SLEAP Share / URL
          </DialogTitle>
        </DialogHeader>

        <SleapShareAccountCard
          signedOutHint="Sign in with GitHub to browse your uploads or open private datasets."
          onSignedIn={() => {
            if (tab === "uploads") void loadMyUploads();
          }}
          disabled={opening}
        />

        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as "url" | "uploads")}
          className="w-full"
        >
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="url">Link or Shortcode</TabsTrigger>
            <TabsTrigger value="uploads">
              My Uploads{credentials && files.length > 0 ? ` (${files.length})` : ""}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="url" className="mt-3 space-y-3">
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                handleSubmitUrl();
              }}
            >
              <div className="space-y-1.5">
                <label
                  htmlFor="open-share-input"
                  className="text-xs font-medium text-foreground"
                >
                  SLEAP Share link, shortcode, or direct .slp URL
                </label>
                <Input
                  id="open-share-input"
                  autoFocus
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="slp.sh/abc123, abc123, or https://…/labels.pkg.slp"
                  spellCheck={false}
                />
              </div>

              {resolving && (
                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Resolving dataset metadata…
                </div>
              )}

              {!resolving && parsed?.kind === "share" && meta && (
                <div className="space-y-2 rounded-md border border-border bg-muted/25 p-3 text-xs">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium text-foreground truncate">
                        {meta.name || meta.originalFilename}
                      </div>
                      <div className="text-muted-foreground">
                        {formatBytes(meta.fileSize)}
                        {meta.metadata ? (
                          <>
                            {" · "}
                            {meta.metadata.labeledFramesCount.toLocaleString()} labeled frame
                            {meta.metadata.labeledFramesCount === 1 ? "" : "s"}
                            {" · "}
                            {meta.metadata.videosCount} video
                            {meta.metadata.videosCount === 1 ? "" : "s"}
                          </>
                        ) : null}
                      </div>
                    </div>
                    <Badge variant={meta.isPrivate ? "secondary" : "outline"} className="shrink-0 gap-1 text-[10px]">
                      {meta.isPrivate && <Lock className="h-2.5 w-2.5" />}
                      {meta.isPrivate ? "Private" : "Unlisted"}
                    </Badge>
                  </div>

                  {companionVideoCount > 0 && (
                    <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Film className="h-3 w-3 text-primary" />
                      Streams with {companionVideoCount} companion video
                      {companionVideoCount === 1 ? "" : "s"}
                    </div>
                  )}

                  {slpMembers.length > 1 && (
                    <div className="space-y-1.5 pt-1 border-t border-border/60">
                      <div className="text-[11px] font-medium text-foreground">
                        Select split / .slp file to open
                      </div>
                      <RadioGroup
                        value={selectedSlpUrl ?? ""}
                        onValueChange={setSelectedSlpUrl}
                        className="space-y-1"
                      >
                        {slpMembers.map((m) => {
                          const fullUrl = new URL(m.url, parsed.origin).href;
                          return (
                            <label
                              key={m.filename}
                              className="flex items-center justify-between gap-2 rounded px-1.5 py-1 hover:bg-accent/50 cursor-pointer"
                            >
                              <span className="flex items-center gap-2 min-w-0">
                                <RadioGroupItem value={fullUrl} />
                                <span className="truncate font-medium">{m.filename}</span>
                              </span>
                              <span className="text-[11px] text-muted-foreground shrink-0">
                                {formatBytes(m.fileSize)}
                                {m.labeledFramesCount != null
                                  ? ` · ${m.labeledFramesCount} frames`
                                  : ""}
                              </span>
                            </label>
                          );
                        })}
                      </RadioGroup>
                    </div>
                  )}
                </div>
              )}

              {!resolving && parsed?.kind === "share" && resolveNotFound && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                  Dataset not found or private.{" "}
                  {!credentials
                    ? "Sign in with GitHub above if this is one of your private datasets."
                    : "Double-check the shortcode or make sure you have access."}
                </div>
              )}

              {parsed?.kind === "url" && (
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Link2 className="h-3.5 w-3.5 shrink-0" />
                  Direct .slp URL — will stream lazily via HTTP Range requests.
                </div>
              )}

              <div className="flex justify-end gap-2 pt-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setOpen(false)}
                  disabled={opening}
                >
                  Cancel
                </Button>
                <Button type="submit" size="sm" disabled={!parsed || opening}>
                  {opening ? "Opening…" : "Open"}
                </Button>
              </div>
            </form>
          </TabsContent>

          <TabsContent value="uploads" className="mt-3 space-y-3">
            {!credentials ? (
              <div className="rounded-md border border-dashed border-border py-8 text-center text-xs text-muted-foreground">
                Sign in with GitHub above to browse and open your SLEAP Share uploads.
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <div className="relative flex-1">
                    <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      placeholder="Filter by name, filename, or shortcode…"
                      className="h-8 pl-8 text-xs"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void loadMyUploads()}
                    disabled={filesLoading}
                    aria-label="Refresh uploads"
                  >
                    <RefreshCw
                      className={`h-3.5 w-3.5 ${filesLoading ? "animate-spin" : ""}`}
                    />
                  </Button>
                </div>

                {filesError && (
                  <p className="text-xs text-destructive">{filesError}</p>
                )}

                <ScrollArea className="h-56 rounded-md border border-border">
                  {filesLoading && files.length === 0 ? (
                    <div className="flex h-48 items-center justify-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading your uploads…
                    </div>
                  ) : filteredFiles.length === 0 ? (
                    <div className="flex h-48 items-center justify-center text-xs text-muted-foreground">
                      {files.length === 0
                        ? "You haven't uploaded any datasets to SLEAP Share yet."
                        : "No uploads match your search."}
                    </div>
                  ) : (
                    <div className="divide-y divide-border">
                      {filteredFiles.map((f) => (
                        <div
                          key={f.shortcode}
                          className="flex items-center justify-between gap-2 px-3 py-2 hover:bg-accent/40 transition-colors"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 text-xs font-medium text-foreground">
                              <span className="truncate">
                                {f.name || f.filename}
                              </span>
                              {f.isPrivate && (
                                <Lock
                                  className="h-3 w-3 shrink-0 text-amber-400"
                                  aria-label="Private"
                                />
                              )}
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              <code>{f.shortcode}</code>
                              {" · "}
                              {formatBytes(f.fileSize)}
                              {" · "}
                              {formatDate(f.createdAt)}
                            </div>
                          </div>
                          <Button
                            type="button"
                            size="xs"
                            variant="outline"
                            onClick={() =>
                              void handleOpenUrl(f.dataUrl, f.name || f.filename)
                            }
                            disabled={opening}
                          >
                            Open
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </ScrollArea>

                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setOpen(false)}
                  >
                    Close
                  </Button>
                </div>
              </>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
