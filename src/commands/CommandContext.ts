/**
 * CommandContext - central command executor with undo/redo.
 *
 * Mirrors SLEAP's CommandContext pattern: a single entry point for executing
 * commands that mutate the data model and signal which parts of the UI need
 * to update. Includes frame-level undo/redo via instance snapshots.
 */

import {
  Instance,
  LabeledFrame,
  PredictedInstance,
  UserCentroid,
  PredictedCentroid,
} from "@talmolab/sleap-io.js";
import type { Centroid } from "@talmolab/sleap-io.js";
import { useAppStore, type AppState } from "../stores/appStore";
import { UpdateTopic } from "../types";
import type { Skeleton, SuggestionFrame, Track, Video } from "../types";
import type { Command } from "./types";
import { toast } from "@/lib/notify";
import { humanizeCommandName } from "@/lib/humanizeCommand";

/** Record of an executed command for change tracking. */
export interface ChangeRecord {
  commandName: string;
  topics: UpdateTopic[];
  timestamp: number;
}

/** Snapshot of a single frame's state for undo/redo. */
interface SingleFrameData {
  videoRef: Video;
  frameIdx: number;
  instances: Instance[];
  /** First-class centroid annotations on the frame (undoable alongside instances). */
  centroids: Centroid[];
  /** Negative (background) flag, so Mark-Frame-as-Negative is undoable. */
  isNegative: boolean;
}

/** Snapshot of frame state for undo/redo. */
interface UndoSnapshot {
  commandName: string;
  /** Single frame data (for regular commands). */
  frame: SingleFrameData | null;
  /** Multi-frame data (for bulk operations like DeleteAllPredictions). */
  allFrames: SingleFrameData[] | null;
  /** Tracks array snapshot (by reference, order matters). */
  tracks: Track[];
  /** Track names captured by value, so a rename (SetTrackName) is undoable. */
  trackNames: string[];
  /**
   * Project-level collections a bulk op (e.g. `Labels.merge`) can grow but that
   * live outside individual frames. Snapshotted by reference so undo reverts a
   * merge that added a video/skeleton/suggestion — not just its frames+tracks.
   */
  videos: Video[];
  skeletons: Skeleton[];
  suggestions: SuggestionFrame[];
  /** Index of selected instance in the current frame's instances array. */
  selectedIdx: number;
  /** The video that was active when the snapshot was taken. */
  activeVideo: Video | null;
  /** The frame index that was active. */
  activeFrameIdx: number;
}

/** Deep-clone an instance's points. */
function clonePoints(points: Instance["points"]): Instance["points"] {
  return points.map((p) => ({
    xy: [p.xy[0], p.xy[1]] as [number, number],
    visible: p.visible,
    complete: p.complete,
    name: p.name,
    score: p.score,
  }));
}

/** Deep-clone an array of instances (preserving skeleton/track references). */
function cloneInstances(instances: Instance[]): Instance[] {
  return instances.map((inst) => {
    if (inst instanceof PredictedInstance) {
      return new PredictedInstance({
        skeleton: inst.skeleton,
        points: inst.points.map((p) => ({
          xy: [p.xy[0], p.xy[1]] as [number, number],
          visible: p.visible,
          complete: p.complete,
          name: p.name,
          score: p.score ?? 0,
        })),
        track: inst.track,
        score: inst.score,
      });
    }
    return new Instance({
      skeleton: inst.skeleton,
      points: clonePoints(inst.points),
      track: inst.track,
    });
  });
}

/**
 * Deep-clone centroid annotations, preserving concrete type (UserCentroid vs
 * PredictedCentroid).
 *
 * The `.instance` back-link (which pairs a centroid with the pose instance it
 * belongs to, and which the canvas colors centroids by) is remapped BY INDEX
 * onto the matching clone — copying the reference would leave every snapshot
 * pointing at a pre-clone `Instance` that is no longer in the frame, so the
 * link would silently die on the first undo. `sourceInstances` and
 * `clonedInstances` must be the same array before/after `cloneInstances`. A link
 * to an instance that isn't in `sourceInstances` (already deleted) is dropped
 * rather than carried over dangling.
 */
function cloneCentroids(
  centroids: Centroid[],
  sourceInstances: Instance[],
  clonedInstances: Instance[],
): Centroid[] {
  return centroids.map((c) => {
    const instIdx = c.instance ? sourceInstances.indexOf(c.instance) : -1;
    const base = {
      x: c.x,
      y: c.y,
      z: c.z,
      track: c.track,
      trackingScore: c.trackingScore,
      instance: instIdx >= 0 ? (clonedInstances[instIdx] ?? null) : null,
      category: c.category,
      name: c.name,
      source: c.source,
    };
    if (c instanceof PredictedCentroid) {
      return new PredictedCentroid({ ...base, score: c.score });
    }
    return new UserCentroid(base);
  });
}

/** Callbacks that can be registered to react to update topics. */
type UpdateListener = (topics: UpdateTopic[]) => void;

const MAX_UNDO_STACK = 100;

export class CommandContext {
  /** Stack of executed commands for change tracking. */
  private changeStack: ChangeRecord[] = [];

  /** Undo stack: snapshots of state before each mutating command. */
  private undoStack: UndoSnapshot[] = [];

  /** Redo stack: snapshots for redoing undone commands. */
  private redoStack: UndoSnapshot[] = [];

  /** Listeners notified when topics are signaled. */
  private listeners: Set<UpdateListener> = new Set();

  /**
   * Take a snapshot of the current frame state. Public so a command using
   * `skipAutoSnapshot` can manage its own single-frame undo (the single-frame
   * analogue of {@link takeAllFramesSnapshot}).
   */
  takeSnapshot(commandName: string): UndoSnapshot {
    const { labels, video, frameIdx, instance } = this.state;
    let frame: SingleFrameData | null = null;
    let selectedIdx = -1;

    if (labels && video) {
      const frames = labels.find({ video, frameIdx });
      if (frames.length > 0) {
        const lf = frames[0];
        const instances = cloneInstances(lf.instances);
        frame = {
          videoRef: video,
          frameIdx,
          instances,
          centroids: cloneCentroids(lf.centroids, lf.instances, instances),
          isNegative: lf.isNegative,
        };
        if (instance) {
          selectedIdx = lf.instances.indexOf(instance);
        }
      }
    }

    return {
      commandName,
      frame,
      allFrames: null,
      tracks: labels ? [...labels.tracks] : [],
      trackNames: labels ? labels.tracks.map((t) => t.name) : [],
      videos: labels ? [...labels.videos] : [],
      skeletons: labels ? [...labels.skeletons] : [],
      suggestions: labels ? [...labels.suggestions] : [],
      selectedIdx,
      activeVideo: video,
      activeFrameIdx: frameIdx,
    };
  }

  /** Take a snapshot of ALL labeled frames (for bulk operations). */
  takeAllFramesSnapshot(commandName: string): UndoSnapshot {
    const { labels, video, frameIdx, instance } = this.state;
    const allFrames: SingleFrameData[] = [];
    let selectedIdx = -1;

    if (labels) {
      for (const lf of labels.labeledFrames) {
        const instances = cloneInstances(lf.instances);
        allFrames.push({
          videoRef: lf.video,
          frameIdx: lf.frameIdx,
          instances,
          centroids: cloneCentroids(lf.centroids, lf.instances, instances),
          isNegative: lf.isNegative,
        });
      }
      if (video && instance) {
        const frames = labels.find({ video, frameIdx });
        if (frames.length > 0) {
          selectedIdx = frames[0].instances.indexOf(instance);
        }
      }
    }

    return {
      commandName,
      frame: null,
      allFrames,
      tracks: labels ? [...labels.tracks] : [],
      trackNames: labels ? labels.tracks.map((t) => t.name) : [],
      videos: labels ? [...labels.videos] : [],
      skeletons: labels ? [...labels.skeletons] : [],
      suggestions: labels ? [...labels.suggestions] : [],
      selectedIdx,
      activeVideo: video,
      activeFrameIdx: frameIdx,
    };
  }

  /** Push a custom snapshot onto the undo stack. */
  pushUndoSnapshot(snapshot: UndoSnapshot): void {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > MAX_UNDO_STACK) {
      this.undoStack.shift();
    }
    this.redoStack.length = 0;
  }

  /** Restore state from a snapshot. Returns a snapshot of the state being replaced. */
  private restoreSnapshot(snapshot: UndoSnapshot): UndoSnapshot {
    const { labels } = this.state;
    if (!labels) return this.takeSnapshot(snapshot.commandName);

    // If this is a multi-frame snapshot, take a multi-frame before-snapshot
    const before = snapshot.allFrames
      ? this.takeAllFramesSnapshot(snapshot.commandName)
      : this.takeSnapshot(snapshot.commandName);

    // Restore tracks + the project-level collections a merge can grow (videos,
    // skeletons, suggestions), so undoing a merge that added a video/skeleton
    // reverts them instead of leaving an orphan (e.g. status bar stuck on
    // "Video 1 / 2" after undo).
    labels.tracks = [...snapshot.tracks];
    snapshot.tracks.forEach((t, i) => {
      if (i < snapshot.trackNames.length) t.name = snapshot.trackNames[i];
    });
    labels.videos = [...snapshot.videos];
    labels.skeletons = [...snapshot.skeletons];
    labels.suggestions = [...snapshot.suggestions];

    if (snapshot.allFrames) {
      // Multi-frame restore: rebuild all labeled frames
      // First, remove all existing labeled frames
      labels.labeledFrames.length = 0;

      // Restore each frame
      for (const frameData of snapshot.allFrames) {
        const lf = new LabeledFrame({
          video: frameData.videoRef,
          frameIdx: frameData.frameIdx,
        });
        lf.instances = cloneInstances(frameData.instances);
        lf.centroids = cloneCentroids(frameData.centroids, frameData.instances, lf.instances);
        lf.isNegative = frameData.isNegative;
        labels.labeledFrames.push(lf);
      }
      // We rebuilt `labeledFrames` in place (not via io's mutators), so io's
      // internal frame/track indices are stale. They're guarded only by frame
      // COUNT, so when a merge left the count unchanged (e.g. keep_both on an
      // overlapping frame: donor frames all matched existing ones) the guard
      // never fires and `find()` below hands back the pre-undo (merged) frames.
      // Force a rebuild so the view-restore find — and every later find — sees
      // the restored frames.
      labels.reindex();

      // Restore view to the active frame
      if (snapshot.activeVideo) {
        const currentFrames = labels.find({ video: snapshot.activeVideo!, frameIdx: snapshot.activeFrameIdx });
        const currentLf = currentFrames.length > 0 ? currentFrames[0] : null;
        this.state.setLabeledFrame(currentLf);

        if (
          currentLf &&
          snapshot.selectedIdx >= 0 &&
          snapshot.selectedIdx < currentLf.instances.length
        ) {
          this.state.setInstance(currentLf.instances[snapshot.selectedIdx]);
        } else {
          this.state.setInstance(null);
        }
      }
    } else if (snapshot.frame) {
      const video = snapshot.frame.videoRef;

      // Find the labeled frame
      const frames = labels.find({ video, frameIdx: snapshot.frame!.frameIdx });

      if (frames.length > 0) {
        // Restore instances on existing frame
        const lf = frames[0];
        lf.instances = cloneInstances(snapshot.frame.instances);
        lf.centroids = cloneCentroids(
          snapshot.frame.centroids,
          snapshot.frame.instances,
          lf.instances,
        );
        lf.isNegative = snapshot.frame.isNegative;
        this.state.setLabeledFrame(lf);

        // Restore selection
        if (
          snapshot.selectedIdx >= 0 &&
          snapshot.selectedIdx < lf.instances.length
        ) {
          this.state.setInstance(lf.instances[snapshot.selectedIdx]);
        } else {
          this.state.setInstance(null);
        }
      } else {
        // Frame was deleted, re-create it
        const lf = new LabeledFrame({
          video,
          frameIdx: snapshot.frame.frameIdx,
        });
        lf.instances = cloneInstances(snapshot.frame.instances);
        lf.centroids = cloneCentroids(
          snapshot.frame.centroids,
          snapshot.frame.instances,
          lf.instances,
        );
        lf.isNegative = snapshot.frame.isNegative;
        labels.labeledFrames.push(lf);
        this.state.setLabeledFrame(lf);
        this.state.setInstance(null);
      }
    } else {
      // Null frame snapshot = no LabeledFrame should exist
      const video = snapshot.activeVideo;
      if (video) {
        const frames = labels.find({ video, frameIdx: snapshot.activeFrameIdx });
        if (frames.length > 0) {
          const idx = labels.labeledFrames.indexOf(frames[0]);
          if (idx !== -1) labels.labeledFrames.splice(idx, 1);
        }
      }
      this.state.setLabeledFrame(null);
      this.state.setInstance(null);
    }

    // The single-frame branches above also mutate `labeledFrames` directly
    // (re-creating a deleted frame, or splicing one out) or swap a frame's
    // `instances`, any of which can desync io's count-guarded indices. Rebuild
    // once more so subsequent finds/track lookups are correct. (Idempotent with
    // the multi-frame branch's reindex — it just nulls the caches.)
    labels.reindex();

    this.state.markChanged();
    return before;
  }

  /** Check if a command mutates data (has update topics). */
  private isMutating(command: Command): boolean {
    return command.topics.length > 0;
  }

  /** Execute a command, track the change, and signal updates. */
  async execute(
    command: Command,
    params?: Record<string, unknown>
  ): Promise<void> {
    // Snapshot before mutating commands for undo
    // (commands with skipAutoSnapshot handle their own snapshots)
    if (this.isMutating(command) && !command.skipAutoSnapshot) {
      const snapshot = this.takeSnapshot(command.name);
      this.undoStack.push(snapshot);
      if (this.undoStack.length > MAX_UNDO_STACK) {
        this.undoStack.shift();
      }
      // Clear redo stack on new action
      this.redoStack.length = 0;
    }

    await command.execute(this, params);

    // Track the change
    this.changeStack.push({
      commandName: command.name,
      topics: command.topics,
      timestamp: Date.now(),
    });

    // Signal which topics changed
    if (command.topics.length > 0) {
      this.signalUpdate(command.topics);
    }
  }

  /**
   * Navigate the view to a snapshot's frame. Undo/redo restore a frame BY its
   * own (video, frameIdx), not the active one, so in guided sweeps the active
   * frame can differ from the frame being restored — leaving the image showing
   * one frame and the overlay another, and making the redo before-snapshot
   * capture the wrong frame. Navigating first keeps image + overlay consistent
   * and lets redo round-trip. A no-op when already on that frame.
   */
  private navigateToSnapshotFrame(snapshot: UndoSnapshot): void {
    const video = snapshot.allFrames ? snapshot.activeVideo : snapshot.frame?.videoRef;
    const frameIdx = snapshot.allFrames ? snapshot.activeFrameIdx : snapshot.frame?.frameIdx;
    if (!video || frameIdx == null) return;
    if (video !== this.state.video) this.state.setVideo(video);
    this.state.setFrameIdx(frameIdx);
  }

  /**
   * Land the correction cursor on the queue item the snapshot belongs to (its
   * frame + selected instance), so after an undo/redo the cursor, view, and bar
   * all point at the item whose data just changed. Uses the snapshot's STORED
   * selectedIdx (captured when the command ran), not live state. No-op outside
   * correct mode or when the item isn't in the queue.
   */
  private correctResyncFromSnapshot(snapshot: UndoSnapshot): void {
    const video = snapshot.allFrames ? snapshot.activeVideo : snapshot.frame?.videoRef;
    const frameIdx = snapshot.allFrames ? snapshot.activeFrameIdx : snapshot.frame?.frameIdx;
    if (!video || frameIdx == null || snapshot.selectedIdx < 0) return;
    this.state.correctSyncToFrame(video, frameIdx, snapshot.selectedIdx);
  }

  /** Undo the last mutating command. Returns true if an undo was performed. */
  undo(): boolean {
    const snapshot = this.undoStack.pop();
    if (!snapshot) return false;

    // In a correction sweep, Accept advances the view to the NEXT item's frame
    // before this command's frame is restored. Navigate back to the edited frame
    // first so the restore (and its redo before-snapshot) act on the right frame
    // and the overlay never mismatches the image.
    if (useAppStore.getState().labelingMode === "correct") {
      this.navigateToSnapshotFrame(snapshot);
    }

    const redoSnapshot = this.restoreSnapshot(snapshot);
    this.redoStack.push(redoSnapshot);
    this.afterUndoRedo();
    // In a Phase-2 keypoint pass, each placement advanced the cursor outside the
    // undo snapshot, so restoring the point data alone would leave the cursor
    // ahead of the (now un-placed) node. Step it back in lockstep — 1 undo = 1
    // placement in this guided mode. A no-op at the sweep start is harmless.
    const s = useAppStore.getState();
    if (s.labelingMode === "keypointPass") {
      s.passStepBack();
    } else if (s.labelingMode === "correct") {
      // Land the cursor back on the item whose data just reverted (works whether
      // it was an Accept that advanced the cursor or a drag/right-click that
      // didn't) so the view, cursor, and bar stay in agreement.
      this.correctResyncFromSnapshot(snapshot);
    }
    // Undo/redo are otherwise silent (only the status bar changes) — surface a
    // short, self-replacing toast naming the action so ⌘Z has visible feedback.
    toast.info(`Undid ${humanizeCommandName(snapshot.commandName)}`, {
      id: "undo-redo",
      duration: 1400,
    });
    return true;
  }

  /** Redo the last undone command. Returns true if a redo was performed. */
  redo(): boolean {
    const snapshot = this.redoStack.pop();
    if (!snapshot) return false;

    if (useAppStore.getState().labelingMode === "correct") {
      this.navigateToSnapshotFrame(snapshot);
    }

    const undoSnapshot = this.restoreSnapshot(snapshot);
    this.undoStack.push(undoSnapshot);
    this.afterUndoRedo();
    // Mirror undo(): re-advance the cursor when redoing a placement/acceptance.
    const s = useAppStore.getState();
    if (s.labelingMode === "keypointPass") {
      s.passAdvance();
    } else if (s.labelingMode === "correct") {
      this.correctResyncFromSnapshot(snapshot);
    }
    toast.info(`Redid ${humanizeCommandName(snapshot.commandName)}`, {
      id: "undo-redo",
      duration: 1400,
    });
    return true;
  }

  /**
   * After an undo/redo: force a canvas redraw (restoreSnapshot mutates the
   * frame's instances in place, so the LabeledFrame reference may not change)
   * and notify listeners so undo/redo-aware UI (e.g. the Edit menu's enabled
   * state) refreshes — neither happens automatically otherwise.
   */
  private afterUndoRedo(): void {
    this.state.bumpOverlayVersion?.();
    // Include Labels so project-level listeners (seekbar marks, panels) also
    // recompute — e.g. undoing a merge or a Mark-Frame-as-Negative toggle.
    this.signalUpdate([
      UpdateTopic.Labels,
      UpdateTopic.Frame,
      UpdateTopic.Instance,
      UpdateTopic.Tracks,
    ]);
  }

  /** Check if undo is available. */
  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** Check if redo is available. */
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Get the name of the command that would be undone. */
  get undoCommandName(): string | null {
    return this.undoStack.length > 0
      ? this.undoStack[this.undoStack.length - 1].commandName
      : null;
  }

  /** Get the name of the command that would be redone. */
  get redoCommandName(): string | null {
    return this.redoStack.length > 0
      ? this.redoStack[this.redoStack.length - 1].commandName
      : null;
  }

  /** Notify listeners that specific topics have changed. */
  signalUpdate(topics: UpdateTopic[]): void {
    for (const listener of this.listeners) {
      listener(topics);
    }
  }

  /** Register a listener for update signals. */
  onUpdate(listener: UpdateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Get the full change history. */
  getChangeStack(): ReadonlyArray<ChangeRecord> {
    return this.changeStack;
  }

  /** Direct access to the Zustand store's getState for reading. */
  get state(): AppState {
    return useAppStore.getState();
  }

  /** Direct access to the Zustand store's setState for writing. */
  setState(
    partial:
      | Partial<AppState>
      | ((state: AppState) => Partial<AppState>)
  ): void {
    useAppStore.setState(partial as Parameters<typeof useAppStore.setState>[0]);
  }
}

/** Singleton command context for the application. */
export const commandContext = new CommandContext();
