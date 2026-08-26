/**
 * "Add video from URL" dialog (Phase 0 of cloud-media support). Streams a video
 * from a public or presigned http(s) URL via io's createVideoBackend (lazy HTTP
 * Range) and appends it to the current project. The URL is stored as the video's
 * canonical filename, so the reference is portable and re-streams on reload.
 *
 * Opened from the File menu (store flag `addVideoUrlDialogOpen`); mounted once in
 * AppShell. Standalone for now — intended to also feed the Videos-panel dropzone
 * (#319) once that lands.
 */

import { useState } from "react";
import { useAppStore } from "@/stores/appStore";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { addVideoUrlToLabels, isSupportedVideoUrl } from "@/lib/resolveVideos";
import { toast } from "@/lib/notify";

export function AddVideoUrlDialog() {
  const open = useAppStore((s) => s.addVideoUrlDialogOpen);
  const setOpen = useAppStore((s) => s.setAddVideoUrlDialogOpen);
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);

  const trimmed = url.trim();
  const valid = isSupportedVideoUrl(trimmed);

  const close = () => {
    setUrl("");
    setOpen(false);
  };

  const handleAdd = async () => {
    const labels = useAppStore.getState().labels;
    if (!labels || !valid || adding) return;
    setAdding(true);
    try {
      const video = await addVideoUrlToLabels(labels, trimmed);
      if (!video) return; // unsupported / failed to open — already toasted
      labels.reindex();
      const s = useAppStore.getState();
      s.markChanged();
      s.bumpOverlayVersion();
      s.setVideo(video);
      s.setFrameIdx(0);
      toast.success("Added video from URL");
      close();
    } finally {
      setAdding(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o && !adding) close();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add video from URL</DialogTitle>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void handleAdd();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <label className="text-muted-foreground text-sm">
              Stream a video from a public or presigned http(s) URL. The link is
              stored in the project and re-streamed on reload.
            </label>
            <Input
              autoFocus
              value={url}
              placeholder="https://…/clip.mp4"
              onChange={(e) => setUrl(e.target.value)}
              spellCheck={false}
            />
          </div>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={close}
              disabled={adding}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!valid || adding}>
              {adding ? "Adding…" : "Add video"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
