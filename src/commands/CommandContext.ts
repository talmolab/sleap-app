/**
 * CommandContext - central command executor with undo/redo.
 *
 * Mirrors SLEAP's CommandContext pattern: a single entry point for executing
 * commands that mutate the data model and signal which parts of the UI need
 * to update. Includes frame-level undo/redo via instance snapshots.
 */

import { Instance, LabeledFrame, PredictedInstance } from "@talmolab/sleap-io.js";
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
  /**
   * Bounded multi-frame data for a bulk op that can PROVABLY never touch
   * anything outside this set (e.g. PropagateTrackLabels, which only ever
   * reassigns `.track` on existing instances in one video from the current
   * frame onward — never creating/deleting frames or touching other videos).
   * Unlike `allFrames`, restoring this patches only the listed (video,
   * frameIdx) frames in place instead of wiping and rebuilding every labeled
   * frame in the project. Mutually exclusive with `allFrames`/`frame`.
   */
  scopedFrames: SingleFrameData[] | null;
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
        frame = {
          videoRef: video,
          frameIdx,
          instances: cloneInstances(lf.instances),
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
      scopedFrames: null,
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
        allFrames.push({
          videoRef: lf.video,
          frameIdx: lf.frameIdx,
          instances: cloneInstances(lf.instances),
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
      scopedFrames: null,
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

  /**
   * Take a snapshot of one video's frames strictly after `minFrameIdx` (and,
   * if given, at or before `maxFrameIdx` — e.g. a user-selected seekbar
   * range), plus the matching `LabeledFrame[]` (sorted by frameIdx) for that
   * same range — a single traversal shared by the snapshot AND the caller's
   * own mutation loop, instead of {@link takeAllFramesSnapshot}'s
   * full-project clone plus a separate `labels.find({video})` scan (which,
   * without a `frameIdx`, falls into sleap-io.js's O(total project frames)
   * linear-scan path).
   *
   * Only safe for a bulk op that can PROVABLY never touch any other video or
   * any frame outside `(minFrameIdx, maxFrameIdx]`, and never creates/deletes
   * frames (see {@link UndoSnapshot.scopedFrames} — currently
   * TransposeInstances/PropagateTrackLabels's track-swap propagation).
   */
  takeVideoFramesSnapshotFrom(
    commandName: string,
    video: Video,
    minFrameIdx: number,
    maxFrameIdx?: number,
  ): { snapshot: UndoSnapshot; frames: LabeledFrame[] } {
    const { labels, video: activeVideo, frameIdx: activeFrameIdx, instance } = this.state;
    const scopedFrames: SingleFrameData[] = [];
    const frames: LabeledFrame[] = [];
    let selectedIdx = -1;

    if (labels) {
      for (const lf of labels.labeledFrames) {
        if (lf.video !== video || lf.frameIdx <= minFrameIdx) continue;
        if (maxFrameIdx !== undefined && lf.frameIdx > maxFrameIdx) continue;
        scopedFrames.push({
          videoRef: lf.video,
          frameIdx: lf.frameIdx,
          instances: cloneInstances(lf.instances),
          isNegative: lf.isNegative,
        });
        frames.push(lf);
      }
      frames.sort((a, b) => a.frameIdx - b.frameIdx);

      if (activeVideo && instance) {
        const activeFrames = labels.find({ video: activeVideo, frameIdx: activeFrameIdx });
        if (activeFrames.length > 0) {
          selectedIdx = activeFrames[0].instances.indexOf(instance);
        }
      }
    }

    const snapshot: UndoSnapshot = {
      commandName,
      frame: null,
      allFrames: null,
      scopedFrames,
      tracks: labels ? [...labels.tracks] : [],
      trackNames: labels ? labels.tracks.map((t) => t.name) : [],
      videos: labels ? [...labels.videos] : [],
      skeletons: labels ? [...labels.skeletons] : [],
      suggestions: labels ? [...labels.suggestions] : [],
      selectedIdx,
      activeVideo,
      activeFrameIdx,
    };

    return { snapshot, frames };
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

    // If this is a multi-frame snapshot, take a matching before-snapshot —
    // scoped to the same (video, frame-range) the original snapshot covered
    // when possible, so undo/redo of a scoped op (e.g. PropagateTrackLabels)
    // never pays for a full-project clone/scan.
    let before: UndoSnapshot;
    if (snapshot.allFrames) {
      before = this.takeAllFramesSnapshot(snapshot.commandName);
    } else if (snapshot.scopedFrames) {
      const scopedVideo = snapshot.scopedFrames[0]?.videoRef ?? null;
      const minFrameIdx =
        snapshot.scopedFrames.length > 0
          ? Math.min(...snapshot.scopedFrames.map((f) => f.frameIdx)) - 1
          : -Infinity;
      before = scopedVideo
        ? this.takeVideoFramesSnapshotFrom(snapshot.commandName, scopedVideo, minFrameIdx).snapshot
        : this.takeSnapshot(snapshot.commandName);
    } else {
      before = this.takeSnapshot(snapshot.commandName);
    }

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
    } else if (snapshot.scopedFrames) {
      // Scoped multi-frame restore: patch only the (video, frameIdx) frames
      // this snapshot covers, in place — every frame outside that scope
      // (other videos, or this video's frames at/before the original cutoff)
      // is left untouched, unlike the `allFrames` branch above which wipes
      // and rebuilds every labeled frame in the project. Safe because a
      // scoped snapshot is only ever taken for an op that never creates or
      // deletes frames (see `UndoSnapshot.scopedFrames`), so every entry is
      // guaranteed to already exist.
      for (const frameData of snapshot.scopedFrames) {
        const frames = labels.find({ video: frameData.videoRef, frameIdx: frameData.frameIdx });
        if (frames.length === 0) continue;
        const lf = frames[0];
        lf.instances = cloneInstances(frameData.instances);
        lf.isNegative = frameData.isNegative;
      }

      // Restore view to the active frame (same as the `allFrames` branch).
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

  /** Undo the last mutating command. Returns true if an undo was performed. */
  undo(): boolean {
    const snapshot = this.undoStack.pop();
    if (!snapshot) return false;

    const redoSnapshot = this.restoreSnapshot(snapshot);
    this.redoStack.push(redoSnapshot);
    // restoreSnapshot reverts the data, but the canvas instance overlay repaints
    // only when `overlayVersion` changes (VideoPlayer's draw effect depends on it)
    // — nothing in the undo path bumped it, so instances a merge added to the
    // current frame stayed drawn after undo. Force the overlay to redraw.
    this.state.bumpOverlayVersion();
    this.signalUpdate([
      UpdateTopic.Labels,
      UpdateTopic.Frame,
      UpdateTopic.Instance,
      UpdateTopic.Tracks,
    ]);
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

    const undoSnapshot = this.restoreSnapshot(snapshot);
    this.undoStack.push(undoSnapshot);
    this.state.bumpOverlayVersion();
    this.signalUpdate([
      UpdateTopic.Labels,
      UpdateTopic.Frame,
      UpdateTopic.Instance,
      UpdateTopic.Tracks,
    ]);
    toast.info(`Redid ${humanizeCommandName(snapshot.commandName)}`, {
      id: "undo-redo",
      duration: 1400,
    });
    return true;
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
