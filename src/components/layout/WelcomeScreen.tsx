/**
 * Welcome screen shown when no project is loaded (#132).
 *
 * A compact New/Open panel anchored bottom-center over the background imagery.
 * The whole screen is a drag-drop target for .slp files.
 */

import { useCallback } from "react";
import { useFileIO } from "../../hooks/useFileIO";
import { useAppStore } from "../../stores/appStore";
import { Button } from "@/components/ui/button";
import { Plus, FolderOpen } from "lucide-react";

export function WelcomeScreen() {
  const { openProject, openFromDrop, loading, error } = useFileIO();

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file && file.name.endsWith(".slp")) {
        openFromDrop(file);
      }
    },
    [openFromDrop]
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  return (
    <div
      // Anchor the panel to the bottom (items-end) with padding so it sits in
      // the lower viewport and never clips (>=20px from the edge), #132.
      className="flex-1 flex items-end justify-center relative pb-6"
      style={{
        backgroundImage: `url(${import.meta.env.BASE_URL}background.jpg)`,
        backgroundSize: "cover",
        backgroundPosition: "center",
      }}
      onDrop={handleDrop}
      onDragOver={handleDragOver}
    >
      <div className="relative z-10 flex flex-col items-center gap-2">
        {error && (
          <div className="max-w-sm text-center text-sm text-destructive bg-destructive/10 px-3 py-2 rounded-md border border-destructive/20">
            {error}
          </div>
        )}

        {/* Compact popup: New + Open only */}
        <div className="flex items-center gap-3 rounded-xl border border-border bg-card/95 backdrop-blur-sm px-4 py-3 shadow-lg">
          <Button
            onClick={() => useAppStore.getState().setNewProjectDialogOpen(true)}
            size="lg"
          >
            <Plus className="h-4 w-4" />
            New Project
          </Button>
          <Button
            onClick={openProject}
            disabled={loading}
            variant="outline"
            size="lg"
          >
            <FolderOpen className="h-4 w-4" />
            {loading ? "Loading..." : "Open Project"}
          </Button>
        </div>

        <p className="text-xs text-muted-foreground/80">
          Drag &amp; drop a .slp file anywhere
        </p>
      </div>
    </div>
  );
}
