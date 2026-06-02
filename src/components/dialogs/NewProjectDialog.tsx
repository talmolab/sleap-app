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
import {
  pickVideoFiles,
  addVideoFileToLabels,
  type PickedVideoFile,
} from "../../lib/resolveVideos";
import { SKELETON_TEMPLATES, TEMPLATE_ORDER } from "../../lib/skeletonTemplates";
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
import { toast } from "@/lib/notify";
import { X } from "lucide-react";

/** Sentinel for the "no template, empty skeleton" choice. */
const EMPTY = "empty";

export function NewProjectDialog() {
  const open = useAppStore((s) => s.newProjectDialogOpen);
  const setOpen = useAppStore((s) => s.setNewProjectDialogOpen);

  const [templateId, setTemplateId] = useState<string>(EMPTY);
  const [videos, setVideos] = useState<PickedVideoFile[]>([]);
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

  const handleAddVideos = useCallback(async () => {
    const picked = await pickVideoFiles();
    if (picked.length > 0) setVideos((v) => [...v, ...picked]);
  }, []);

  const removeVideo = useCallback((idx: number) => {
    setVideos((v) => v.filter((_, i) => i !== idx));
  }, []);

  const handleCreate = useCallback(async () => {
    // Creating discards the current project — confirm if there are edits.
    if (useAppStore.getState().hasChanges) {
      const ok = window.confirm(
        "You have unsaved changes. Creating a new project will discard them. Continue?"
      );
      if (!ok) return;
    }

    setCreating(true);
    try {
      // Seed an empty skeleton (a chosen template fills it after setLabels).
      const skeleton = new Skeleton({ nodes: [], name: "skeleton" });
      const labels = new Labels({ skeletons: [skeleton] });

      let addedAny = false;
      for (const pv of videos) {
        const v = await addVideoFileToLabels(labels, pv);
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
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>New Project</DialogTitle>
          <DialogDescription>
            Choose a skeleton and optionally add videos — you can add more later.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
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
            <Button
              variant="subtle"
              size="sm"
              className="self-start"
              onClick={handleAddVideos}
              disabled={creating}
            >
              + Add video(s)…
            </Button>
            {videos.length > 0 && (
              <ul className="mt-1 flex flex-col gap-1">
                {videos.map((v, i) => (
                  <li
                    key={i}
                    className="flex items-center justify-between rounded bg-muted/40 px-2 py-1 text-xs"
                  >
                    <span className="truncate">{v.file.name}</span>
                    <button
                      onClick={() => removeVideo(i)}
                      className="ml-2 shrink-0 text-muted-foreground hover:text-foreground"
                      aria-label={`Remove ${v.file.name}`}
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
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
          <Button onClick={handleCreate} disabled={creating}>
            {creating ? "Creating…" : "Create Project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
