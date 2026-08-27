/**
 * New Project dialog (#138).
 *
 * A light guided flow launched from File > New Project (and Cmd+N): pick a
 * skeleton template (or start empty) and optionally add one or more videos,
 * then "Create Project" lands you in the editor ready to label. Save As is a
 * separate step (File > Save As). Reuses the existing skeleton-template command
 * and the standalone-video pickers (#138 PR-A), so it adds little new logic.
 */

import { useState, useCallback } from "react";
import { Labels, Skeleton } from "@talmolab/sleap-io.js";
import { useAppStore } from "../../stores/appStore";
import { commandContext } from "../../commands/CommandContext";
import { LoadSkeletonTemplateCommand } from "../../commands/skeletonCommands";
import { addVideoFileToLabels } from "../../lib/resolveVideos";
import {
  VideoImportList,
  toVideoImportEntries,
  type VideoImportEntry,
} from "./VideoImportList";
import { SKELETON_TEMPLATES, TEMPLATE_ORDER } from "../../lib/skeletonTemplates";
import { SAMPLE_VIDEO_URL } from "../../lib/tutorial/steps";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { VideoDropzone } from "@/components/common/VideoDropzone";
import { toast } from "@/lib/notify";
import { confirmDiscardUnsavedWork } from "@/lib/unsavedGuard";

/** Sentinel for the "no template, empty skeleton" choice. */
const EMPTY = "empty";

export function NewProjectDialog() {
  const open = useAppStore((s) => s.newProjectDialogOpen);
  const setOpen = useAppStore((s) => s.setNewProjectDialogOpen);
  const tutorialActive = useAppStore((s) => s.tutorialActive);

  const [templateId, setTemplateId] = useState<string>(EMPTY);
  const [videos, setVideos] = useState<VideoImportEntry[]>([]);
  const [creating, setCreating] = useState(false);

  const reset = useCallback(() => {
    setTemplateId(EMPTY);
    setVideos([]);
    setCreating(false);
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) reset();
      setOpen(next);
    },
    [reset, setOpen]
  );

  const removeVideo = useCallback((idx: number) => {
    setVideos((v) => v.filter((_, i) => i !== idx));
  }, []);

  const handleCreate = useCallback(async () => {
    // Creating discards the current project — confirm if there is unsaved work
    // (in-memory edits OR a not-yet-exported OPFS working copy).
    if (!confirmDiscardUnsavedWork("Creating a new project")) return;

    setCreating(true);
    try {
      // Seed an empty skeleton (a chosen template fills it after setLabels).
      const skeleton = new Skeleton({ nodes: [], name: "skeleton" });
      const labels = new Labels({ skeletons: [skeleton] });

      let addedAny = false;
      for (const pv of videos) {
        const v = await addVideoFileToLabels(labels, pv, pv.grayscale);
        if (v) addedAny = true;
      }
      if (addedAny) labels.reindex();

      // Land in the editor (auto-selects the skeleton + first video, frame 0).
      useAppStore.getState().setLabels(labels, undefined);

      // Apply the chosen template into the seeded skeleton (also marks changed).
      if (templateId !== EMPTY) {
        commandContext.execute(LoadSkeletonTemplateCommand, { templateId });
      }
      // A from-scratch project with content is unsaved work; prompt to save it.
      if (templateId !== EMPTY || addedAny) {
        useAppStore.getState().markChanged();
      }

      setOpen(false);
      reset();
      toast.success("New project created", {
        description: addedAny
          ? `${videos.length} video${videos.length > 1 ? "s" : ""} added. Save As to write a .slp.`
          : "Add videos and label, then Save As to write a .slp.",
      });
    } finally {
      setCreating(false);
    }
  }, [templateId, videos, setOpen, reset]);

  const selectedTemplate =
    templateId !== EMPTY ? SKELETON_TEMPLATES[templateId] : null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-[420px]"
        onInteractOutside={(e) => {
          // The tutorial coachmark (TutorialOverlay) renders outside this
          // dialog's Radix portal, so clicking its download link or dragging
          // its title bar otherwise reads as an outside interaction and closes
          // the dialog out from under the tutorial's add-video steps.
          if ((e.target as HTMLElement | null)?.closest("[data-tutorial-overlay]")) {
            e.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>New Project</DialogTitle>
          <DialogDescription>
            Choose a skeleton and optionally add videos — you can add more later.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 flex-col gap-4 py-2">
          {/* Skeleton template */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">Skeleton</label>
            <Select value={templateId} onValueChange={setTemplateId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={EMPTY}>Empty — define later</SelectItem>
                {TEMPLATE_ORDER.map((id) => (
                  <SelectItem key={id} value={id}>
                    {SKELETON_TEMPLATES[id].name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedTemplate && (
              <p className="text-xs text-muted-foreground">
                {selectedTemplate.nodes.length} nodes,{" "}
                {selectedTemplate.edges.length} edges
              </p>
            )}
          </div>

          {/* Videos (optional) */}
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">
              Videos{" "}
              <span className="font-normal text-muted-foreground">
                (optional)
              </span>
            </label>
            {!tutorialActive && (
              <a
                href={SAMPLE_VIDEO_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="self-start text-xs text-muted-foreground underline hover:text-foreground"
              >
                No video handy? Download a sample
              </a>
            )}
            <VideoDropzone
              onFiles={(picked) =>
                setVideos((v) => [...v, ...toVideoImportEntries(picked)])
              }
              data-tutorial="new-project-add-video-button"
            />
            <VideoImportList
              videos={videos}
              onChange={setVideos}
              onRemove={removeVideo}
              disabled={creating}
              data-tutorial="new-project-video-list"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={creating}
          >
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={creating}
            data-tutorial="new-project-create-button"
          >
            {creating ? "Creating…" : "Create Project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
