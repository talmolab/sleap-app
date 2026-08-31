import { useCallback, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { cn } from "@/lib/utils";
import { toast } from "@/lib/notify";
import {
  pickVideoFiles,
  pickedFromFiles,
  type PickedVideoFile,
} from "@/lib/resolveVideos";
import { useTauriFileDrop } from "@/hooks/useTauriFileDrop";

/**
 * Dashed, clickable box for adding videos: drag video files onto it (browser
 * HTML5 drop + Tauri desktop drop via {@link useTauriFileDrop}) OR click to open
 * the native file picker. Emits the supported videos as {@link PickedVideoFile}[]
 * via `onFiles`; non-video files (e.g. a dropped `.slp`) are ignored. The host
 * decides what to do with them (stage in the Import Videos dialog, add to the New
 * Project list, …).
 */
export function VideoDropzone({
  onFiles,
  label = "Drag videos here, or click to browse",
  className,
  ...rest
}: {
  onFiles: (files: PickedVideoFile[]) => void;
  label?: string;
  className?: string;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onFiles">) {
  const ref = useRef<HTMLButtonElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const emit = useCallback(
    (picked: PickedVideoFile[]) => {
      if (picked.length) onFiles(picked);
    },
    [onFiles],
  );

  useTauriFileDrop(ref, emit, setDragOver);

  const openPicker = useCallback(async () => {
    try {
      emit(await pickVideoFiles());
    } catch (err) {
      toast.error("Failed to add video", {
        description: err instanceof Error ? err.message : String(err),
      });
    }
  }, [emit]);

  return (
    <button
      ref={ref}
      type="button"
      onClick={openPicker}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const picked = pickedFromFiles(Array.from(e.dataTransfer.files));
        if (picked.length) emit(picked);
        else if (e.dataTransfer.files.length)
          toast("Only video files can be added here");
      }}
      className={cn(
        "flex w-full items-center justify-center gap-2 rounded-md border border-dashed px-3 py-3 text-xs transition-colors",
        dragOver
          ? "border-primary bg-primary/5 text-foreground"
          : "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground",
        className,
      )}
      {...rest}
    >
      <Upload className="h-3.5 w-3.5 shrink-0" />
      {label}
    </button>
  );
}
