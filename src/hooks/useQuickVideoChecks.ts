/**
 * Run the frame check's quick tier on every open video, whenever its backend
 * opens or changes (add, project load + first view, relocate, proxy swap). It
 * only reads what the reader already knows (frame times), so it costs nothing
 * noticeable. A warning is toasted once per video, with a button that opens
 * the Check Frames dialog.
 */
import { useEffect } from "react";
import { useAppStore } from "@/stores/appStore";
import { useVideoCheckStore } from "@/stores/videoCheckStore";
import { quickCheckVideo } from "@/lib/videoCheckRuntime";
import { videoBasename } from "@/lib/videoFilter";
import { toast } from "@/lib/notify";
import type { Video } from "@/types";

/** Videos already warned about this session (a re-check doesn't toast again). */
const warned = new WeakSet<Video>();

export function useQuickVideoChecks(): void {
  const labels = useAppStore((s) => s.labels);
  const current = useAppStore((s) => s.video);
  const videoRevision = useAppStore((s) => s.videoRevision);
  const backendSwapNonce = useAppStore((s) => s.backendSwapNonce);
  const overlayVersion = useAppStore((s) => s.overlayVersion);

  useEffect(() => {
    if (!labels) return;
    let cancelled = false;
    void (async () => {
      for (const video of labels.videos) {
        const backend = video.backend;
        if (!backend && !video.hasEmbeddedImages) continue;
        const { results, setQuick, openDialog } = useVideoCheckStore.getState();
        const entry = results.get(video);
        if (entry?.quick && entry.quickBackend === backend) continue;
        const quick = await quickCheckVideo(video);
        if (cancelled) return;
        if (!quick) continue;
        setQuick(video, backend, quick);
        if (quick.status === "warn" && !warned.has(video)) {
          warned.add(video);
          const first = quick.findings.find((f) => f.severity === "warn");
          toast.warning(`${videoBasename(video.filename)} may not show every frame correctly`, {
            description: first?.message,
            duration: 15_000,
            action: { label: "Check frames", onClick: () => openDialog(video) },
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [labels, current, videoRevision, backendSwapNonce, overlayVersion]);
}
