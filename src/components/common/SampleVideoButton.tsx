/**
 * "Use sample video" button for the New Project dialog — replaces the old
 * "No video handy? Download a sample" link (which pointed at a Google Drive
 * URL meant for a human click, not `fetch()`). Clicking it downloads the
 * pinned `mice.mp4` ({@link SAMPLE_VIDEO}) via {@link loadSampleVideo} and
 * hands the caller a {@link PickedVideoFile} — the same shape the dropzone
 * and file picker already produce — so the dialog just appends it to its
 * video list like any other pick.
 *
 * Shown unconditionally, including while the tutorial is running: the
 * tutorial's add-video step now targets this button directly instead of a
 * separate download link.
 *
 * States:
 * - Idle: an outline button with a Download icon, "Use sample video", and a
 *   muted "N MB" hint (the file name shows in the video list once staged;
 *   naming it here too overflowed the 420px dialog).
 * - Loading: the label becomes "Downloading… NN%" (driven by
 *   `loadSampleVideo`'s `onProgress`), with a small cancel (×) button next to
 *   it that aborts the in-flight download via `AbortController`. Unmounting
 *   while a download is in flight also aborts it. An abort is silent — no
 *   error toast, `onLoaded` is not called — since the user asked for it.
 * - Error (download failed for a reason other than our own abort): an error
 *   toast with a "Download" action that opens the pinned URL directly
 *   (manual fallback), then back to idle.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SAMPLE_VIDEO, loadSampleVideo } from "@/lib/sampleVideo";
import type { PickedVideoFile } from "@/lib/resolveVideos";
import { isTauri } from "@/platform";
import { toast } from "@/lib/notify";

const SAMPLE_VIDEO_SIZE_LABEL = `${Math.round(SAMPLE_VIDEO.bytes / 1_000_000)} MB`;

export interface SampleVideoButtonProps {
  /** Called with the staged video once the download (or cache hit) resolves. */
  onLoaded: (picked: PickedVideoFile) => void;
  disabled?: boolean;
  /** Forwarded to the main button so the tutorial overlay can target it. */
  "data-tutorial"?: string;
}

export function SampleVideoButton({
  onLoaded,
  disabled,
  ...rest
}: SampleVideoButtonProps) {
  // 0..1 while downloading; null while idle.
  const [progress, setProgress] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Abort an in-flight download if the button goes away (dialog closed,
  // reset, etc.) — never leave a dangling fetch updating unmounted state.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const handleClick = useCallback(async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setProgress(0);
    try {
      const picked = await loadSampleVideo({
        isTauri,
        signal: controller.signal,
        onProgress: (fraction) => setProgress(fraction),
      });
      if (controller.signal.aborted) return;
      onLoaded(picked);
    } catch (err) {
      // A user-initiated cancel also rejects the in-flight fetch — don't
      // surface that as an error.
      if (controller.signal.aborted) return;
      // The toast is deliberately generic; keep the real cause in the
      // console (and so the diagnostics session log).
      console.error("[sample-video] load failed:", err);
      toast.error("Couldn't download the sample video", {
        description: "Check your connection, or download it manually.",
        action: {
          label: "Download",
          onClick: () => window.open(SAMPLE_VIDEO.url, "_blank", "noopener"),
        },
      });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setProgress(null);
    }
  }, [onLoaded]);

  const handleCancel = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    abortRef.current?.abort();
  }, []);

  if (progress !== null) {
    return (
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" disabled {...rest}>
          {`Downloading… ${Math.round(progress * 100)}%`}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={handleCancel}
          aria-label="Cancel sample video download"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleClick}
      disabled={disabled}
      {...rest}
    >
      <Download className="h-3.5 w-3.5" />
      Use sample video
      <span className="font-normal text-muted-foreground">
        {SAMPLE_VIDEO_SIZE_LABEL}
      </span>
    </Button>
  );
}
