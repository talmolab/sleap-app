/**
 * Tests for the command system.
 */

import { describe, it, expect, beforeEach, vi } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";
import { UpdateTopic } from "@/types";
import type { Command } from "@/commands/types";
import {
  AddInstance,
  DeleteSelectedInstance,
  CopyInstance,
  PasteInstance,
  DuplicateInstance,
  DeleteFramePredictions,
  DeleteAllPredictions,
  SetPointLocation,
  ConvertPredictionToInstance,
  AddInstancesFromAllPredictions,
  AddInstancesFromAllPredictionsInProject,
  BeginEdit,
  MoveInstance,
  RotateInstance,
} from "@/commands/editCommands";
import {
  GoNextLabeledFrame,
  GoPrevLabeledFrame,
  GoNextSuggestion,
  GoPrevSuggestion,
  GoToFrame,
  GoToLastInteracted,
  GoNextUserFrame,
  GoNextTrackSpawnFrame,
} from "@/commands/navCommands";
import {
  AddTrack,
  SetInstanceTrack,
  TransposeInstances,
  CopyTrack,
  PasteTrack,
  PropagateTrackLabels,
} from "@/commands/trackCommands";
import {
  Labels,
  Instance,
  PredictedInstance,
  LabeledFrame,
  Skeleton,
  Track,
  Video,
} from "@talmolab/sleap-io.js";
import { toast } from "@/lib/notify";

/** Reset the store between tests. */
function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

/** Create a simple test command. */
function testCommand(
  name: string,
  topics: UpdateTopic[],
  executeFn: (ctx: CommandContext) => void
): Command {
  return {
    name,
    topics,
    execute: executeFn,
  };
}

/**
 * Create a minimal project with a skeleton, video, and labeled frames.
 * Returns the labels object plus references to created objects.
 */
function createTestProject(opts?: {
  numNodes?: number;
  numFrames?: number;
  numInstancesPerFrame?: number;
  withPredictions?: boolean;
  withTracks?: boolean;
  withSuggestions?: boolean;
}) {
  const numNodes = opts?.numNodes ?? 3;
  const numFrames = opts?.numFrames ?? 3;
  const numInstancesPerFrame = opts?.numInstancesPerFrame ?? 1;

  const nodeNames = Array.from({ length: numNodes }, (_, i) => `node_${i}`);
  const skeleton = new Skeleton({ nodes: nodeNames, name: "test" });
  if (numNodes >= 2) {
    skeleton.addEdge(skeleton.nodes[0], skeleton.nodes[1]);
  }

  // Real (backend-less) Video with an explicit shape — no file to open.
  // As of sleap-io.js 0.4.0, find()/get*() resolve videos via
  // Video.matchesPath(), so this must be a real instance, not a plain cast.
  const video = new Video({
    filename: "test.mp4",
    backendMetadata: { shape: [100, 480, 640, 3] },
    openBackend: false,
  });

  const labels = new Labels({
    videos: [video],
    skeletons: [skeleton],
  });

  const tracks: Track[] = [];
  if (opts?.withTracks) {
    const t1 = new Track("Track 1");
    const t2 = new Track("Track 2");
    labels.tracks.push(t1, t2);
    tracks.push(t1, t2);
  }

  const labeledFrames: LabeledFrame[] = [];
  for (let f = 0; f < numFrames; f++) {
    const lf = new LabeledFrame({ video, frameIdx: f * 10 });
    for (let i = 0; i < numInstancesPerFrame; i++) {
      const inst = Instance.empty({ skeleton });
      // Set some point coordinates so they aren't all NaN
      for (let n = 0; n < numNodes; n++) {
        inst.points[n].xy = [10 * n + f, 20 * n + i];
        inst.points[n].visible = true;
        inst.points[n].complete = true;
      }
      if (opts?.withTracks && tracks.length > 0) {
        inst.track = tracks[i % tracks.length];
      }
      lf.instances.push(inst);
    }

    // Add predictions if requested
    if (opts?.withPredictions) {
      const pred = new PredictedInstance({
        skeleton,
        points: skeleton.nodes.map((node, n) => ({
          xy: [100 + n, 200 + n] as [number, number],
          visible: true,
          complete: true,
          name: node.name,
          score: 0.95,
        })),
        score: 0.95,
      });
      lf.instances.push(pred);
    }

    labels.labeledFrames.push(lf);
    labeledFrames.push(lf);
  }

  if (opts?.withSuggestions) {
    for (let i = 0; i < 3; i++) {
      labels.suggestions.push({
        video,
        frameIdx: i * 15 + 5,
      } as unknown as import("@/types").SuggestionFrame);
    }
  }

  return { labels, skeleton, video, tracks, labeledFrames };
}

/** Set up the store with a test project and return the project refs. */
function setupProjectInStore(opts?: Parameters<typeof createTestProject>[0]) {
  const project = createTestProject(opts);
  useAppStore.getState().setLabels(project.labels, "test.slp");
  // setLabels selects first video/skeleton automatically
  return project;
}

describe("CommandContext", () => {
  let ctx: CommandContext;

  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("starts with no undo/redo available", () => {
    expect(ctx.canUndo).toBe(false);
    expect(ctx.canRedo).toBe(false);
    expect(ctx.undoCommandName).toBeNull();
    expect(ctx.redoCommandName).toBeNull();
  });

  it("executes a command", async () => {
    let executed = false;
    const cmd = testCommand("TestCmd", [], () => {
      executed = true;
    });
    await ctx.execute(cmd);
    expect(executed).toBe(true);
  });

  it("tracks command execution in change stack", async () => {
    const cmd = testCommand("TestCmd", [], () => {});
    await ctx.execute(cmd);

    const stack = ctx.getChangeStack();
    expect(stack.length).toBe(1);
    expect(stack[0].commandName).toBe("TestCmd");
  });

  it("signals update topics to listeners", async () => {
    const receivedTopics: UpdateTopic[][] = [];
    ctx.onUpdate((topics) => receivedTopics.push(topics));

    const cmd = testCommand(
      "MutatingCmd",
      [UpdateTopic.Frame, UpdateTopic.Instance],
      () => {}
    );
    await ctx.execute(cmd);

    expect(receivedTopics.length).toBe(1);
    expect(receivedTopics[0]).toEqual([
      UpdateTopic.Frame,
      UpdateTopic.Instance,
    ]);
  });

  it("does not signal topics for non-mutating commands", async () => {
    const receivedTopics: UpdateTopic[][] = [];
    ctx.onUpdate((topics) => receivedTopics.push(topics));

    const cmd = testCommand("ReadOnly", [], () => {});
    await ctx.execute(cmd);

    expect(receivedTopics.length).toBe(0);
  });

  it("allows unregistering listeners", async () => {
    const receivedTopics: UpdateTopic[][] = [];
    const unsubscribe = ctx.onUpdate((topics) => receivedTopics.push(topics));
    unsubscribe();

    const cmd = testCommand("MutatingCmd", [UpdateTopic.Frame], () => {});
    await ctx.execute(cmd);

    expect(receivedTopics.length).toBe(0);
  });

  it("provides access to store state", () => {
    expect(ctx.state).toBe(useAppStore.getState());
  });

  describe("undo/redo", () => {
    it("enables undo after executing a mutating command", async () => {
      const cmd = testCommand("MutatingCmd", [UpdateTopic.Frame], () => {});
      await ctx.execute(cmd);

      expect(ctx.canUndo).toBe(true);
      expect(ctx.undoCommandName).toBe("MutatingCmd");
    });

    it("does not enable undo after non-mutating commands", async () => {
      const cmd = testCommand("ReadOnly", [], () => {});
      await ctx.execute(cmd);

      expect(ctx.canUndo).toBe(false);
    });

    it("undo returns false when nothing to undo", () => {
      expect(ctx.undo()).toBe(false);
    });

    it("redo returns false when nothing to redo", () => {
      expect(ctx.redo()).toBe(false);
    });

    it("clears redo stack on new mutating command", async () => {
      // Execute a command, undo it, then execute a new one
      const cmd1 = testCommand("Cmd1", [UpdateTopic.Frame], () => {});
      const cmd2 = testCommand("Cmd2", [UpdateTopic.Frame], () => {});

      await ctx.execute(cmd1);
      ctx.undo();
      expect(ctx.canRedo).toBe(true);

      await ctx.execute(cmd2);
      expect(ctx.canRedo).toBe(false);
    });
  });

  describe("command names", () => {
    it("tracks undo command name", async () => {
      const cmd = testCommand("ImportantAction", [UpdateTopic.Frame], () => {});
      await ctx.execute(cmd);

      expect(ctx.undoCommandName).toBe("ImportantAction");
    });

    it("tracks redo command name after undo", async () => {
      const cmd = testCommand("ImportantAction", [UpdateTopic.Frame], () => {});
      await ctx.execute(cmd);
      ctx.undo();

      expect(ctx.redoCommandName).toBe("ImportantAction");
    });
  });

  describe("multi-frame undo", () => {
    it("takeAllFramesSnapshot captures all labeled frames", () => {
      setupProjectInStore({ numFrames: 3, withPredictions: true });
      const snapshot = ctx.takeAllFramesSnapshot("TestBulk");

      expect(snapshot.commandName).toBe("TestBulk");
      expect(snapshot.allFrames).not.toBeNull();
      expect(snapshot.allFrames!.length).toBe(3);
      // Each frame should have its instances cloned
      for (let i = 0; i < 3; i++) {
        expect(snapshot.allFrames![i].instances.length).toBeGreaterThan(0);
      }
    });

    it("pushUndoSnapshot adds to undo stack and clears redo", async () => {
      setupProjectInStore();

      // First add something to redo stack
      const cmd = testCommand("Cmd1", [UpdateTopic.Frame], () => {});
      await ctx.execute(cmd);
      ctx.undo();
      expect(ctx.canRedo).toBe(true);

      // Now push custom snapshot
      const snapshot = ctx.takeAllFramesSnapshot("BulkOp");
      ctx.pushUndoSnapshot(snapshot);

      expect(ctx.canUndo).toBe(true);
      expect(ctx.canRedo).toBe(false); // redo cleared
      expect(ctx.undoCommandName).toBe("BulkOp");
    });

    it("skipAutoSnapshot prevents automatic single-frame snapshot", async () => {
      setupProjectInStore({ numFrames: 2 });

      const skipCmd: Command = {
        name: "SkipSnapshotCmd",
        topics: [UpdateTopic.Frame],
        skipAutoSnapshot: true,
        execute(_ctx) {
          // Command manages its own snapshot
          const snapshot = _ctx.takeAllFramesSnapshot("SkipSnapshotCmd");
          _ctx.pushUndoSnapshot(snapshot);
        },
      };

      await ctx.execute(skipCmd);
      expect(ctx.canUndo).toBe(true);
      expect(ctx.undoCommandName).toBe("SkipSnapshotCmd");
    });
  });
});

describe("Edit commands", () => {
  let ctx: CommandContext;

  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  describe("AddInstance", () => {
    it("adds an instance to the current frame", async () => {
      const project = setupProjectInStore({ numFrames: 1, numInstancesPerFrame: 0 });
      useAppStore.getState().setFrameIdx(0);

      await ctx.execute(AddInstance);

      const lf = project.labels.find({ video: project.video, frameIdx: 0 });
      expect(lf.length).toBe(1);
      expect(lf[0].instances.length).toBe(1);
    });

    it("creates a labeled frame when none exists", async () => {
      const project = setupProjectInStore({ numFrames: 0 });
      // Navigate to a frame with no labeled frame
      useAppStore.getState().setFrameIdx(50);

      await ctx.execute(AddInstance);

      const lf = project.labels.find({ video: project.video, frameIdx: 50 });
      expect(lf.length).toBe(1);
      expect(lf[0].instances.length).toBe(1);
    });

    it("selects the newly added instance", async () => {
      setupProjectInStore({ numFrames: 0 });
      useAppStore.getState().setFrameIdx(5);

      await ctx.execute(AddInstance);

      expect(useAppStore.getState().instance).not.toBeNull();
    });

    it("does nothing without labels", async () => {
      // No project loaded
      expect(() => ctx.execute(AddInstance)).not.toThrow();
    });

    it("does not add a null instance when the skeleton has no nodes", async () => {
      // A fresh project seeds an empty skeleton (nodes: []). PyQt SLEAP blocks
      // creating an instance until at least one node exists; so must we.
      const project = setupProjectInStore({
        numFrames: 1,
        numNodes: 0,
        numInstancesPerFrame: 0,
      });
      useAppStore.getState().setFrameIdx(0);
      const infoSpy = vi.spyOn(toast, "info");

      await ctx.execute(AddInstance);

      const found = project.labels.find({ video: project.video, frameIdx: 0 });
      const count = found.length > 0 ? found[0].instances.length : 0;
      expect(count).toBe(0);
      expect(useAppStore.getState().instance).toBeNull();
      expect(infoSpy).toHaveBeenCalled();
      infoSpy.mockRestore();
    });

    it("still adds an instance when the skeleton has nodes", async () => {
      const project = setupProjectInStore({
        numFrames: 1,
        numNodes: 2,
        numInstancesPerFrame: 0,
      });
      useAppStore.getState().setFrameIdx(0);

      await ctx.execute(AddInstance);

      const found = project.labels.find({ video: project.video, frameIdx: 0 });
      expect(found.length).toBe(1);
      expect(found[0].instances.length).toBe(1);
    });

    it("seeds a new instance from the captured skeleton template layout", async () => {
      const project = setupProjectInStore({
        numFrames: 1,
        numNodes: 3,
        numInstancesPerFrame: 0,
      });
      useAppStore.getState().setFrameIdx(0);
      // Simulate the builder having captured a drawn layout (IMAGE space).
      // Default init method is "best"; with no existing instances the offset is
      // a no-op, so on this uncropped video (image==source) the new instance
      // lands exactly on the drawn layout instead of the scrambled circle.
      useAppStore.setState({
        skeletonTemplateLayout: [
          { x: 11, y: 22 },
          { x: 33, y: 44 },
          { x: 55, y: 66 },
        ],
      });

      await ctx.execute(AddInstance);

      const found = project.labels.find({ video: project.video, frameIdx: 0 });
      const inst = found[0].instances[0];
      expect(inst.points[0].xy).toEqual([11, 22]);
      expect(inst.points[1].xy).toEqual([33, 44]);
      expect(inst.points[2].xy).toEqual([55, 66]);
    });
  });

  describe("DeleteSelectedInstance", () => {
    it("removes the selected instance", async () => {
      const project = setupProjectInStore({ numFrames: 1, numInstancesPerFrame: 2 });
      const lf = project.labeledFrames[0];
      useAppStore.getState().setFrameIdx(lf.frameIdx);
      useAppStore.getState().setLabeledFrame(lf);
      useAppStore.getState().setInstance(lf.instances[0]);

      await ctx.execute(DeleteSelectedInstance);

      expect(lf.instances.length).toBe(1);
      expect(useAppStore.getState().instance).toBeNull();
    });

    it("does nothing when no instance selected", async () => {
      setupProjectInStore({ numFrames: 1, numInstancesPerFrame: 2 });
      // instance is null by default
      await ctx.execute(DeleteSelectedInstance);
      // Should not throw
    });
  });

  describe("CopyInstance / PasteInstance", () => {
    it("copies and pastes an instance to clipboard", async () => {
      const project = setupProjectInStore({ numFrames: 1, numInstancesPerFrame: 1 });
      const lf = project.labeledFrames[0];
      useAppStore.getState().setFrameIdx(lf.frameIdx);
      useAppStore.getState().setLabeledFrame(lf);
      useAppStore.getState().setInstance(lf.instances[0]);

      await ctx.execute(CopyInstance);

      expect(useAppStore.getState().clipboardInstance).not.toBeNull();
    });

    it("pastes creates a new instance on the current frame", async () => {
      const project = setupProjectInStore({ numFrames: 2, numInstancesPerFrame: 1 });
      const lf = project.labeledFrames[0];
      useAppStore.getState().setFrameIdx(lf.frameIdx);
      useAppStore.getState().setLabeledFrame(lf);
      useAppStore.getState().setInstance(lf.instances[0]);

      await ctx.execute(CopyInstance);

      // Navigate to second frame and paste
      const lf2 = project.labeledFrames[1];
      useAppStore.getState().setFrameIdx(lf2.frameIdx);
      useAppStore.getState().setLabeledFrame(lf2);

      const beforeCount = lf2.instances.length;
      await ctx.execute(PasteInstance);

      expect(lf2.instances.length).toBe(beforeCount + 1);
    });

    it("does not paste a null instance when the skeleton has no nodes", async () => {
      const project = setupProjectInStore({
        numFrames: 1,
        numNodes: 0,
        numInstancesPerFrame: 0,
      });
      const lf = project.labeledFrames[0];
      useAppStore.getState().setFrameIdx(lf.frameIdx);
      useAppStore.getState().setLabeledFrame(lf);
      // Seed the clipboard with a node-less instance.
      useAppStore.setState({
        clipboardInstance: Instance.empty({ skeleton: project.skeleton }),
      });

      const beforeCount = lf.instances.length;
      await ctx.execute(PasteInstance);

      expect(lf.instances.length).toBe(beforeCount);
    });
  });

  describe("DuplicateInstance", () => {
    it("adds a clone of the given instance to the current frame and selects it", async () => {
      const project = setupProjectInStore({ numFrames: 1, numInstancesPerFrame: 1 });
      const lf = project.labeledFrames[0];
      useAppStore.getState().setFrameIdx(lf.frameIdx);
      useAppStore.getState().setLabeledFrame(lf);
      const source = lf.instances[0];

      const beforeCount = lf.instances.length;
      await ctx.execute(DuplicateInstance, { instance: source });

      expect(lf.instances.length).toBe(beforeCount + 1);
      const clone = lf.instances[lf.instances.length - 1];
      expect(clone).not.toBe(source);
      expect(clone.points.map((p) => p.xy)).toEqual(source.points.map((p) => p.xy));
      expect(useAppStore.getState().instance).toBe(clone);
    });

    it("does nothing without a source instance param", async () => {
      const project = setupProjectInStore({ numFrames: 1, numInstancesPerFrame: 1 });
      const lf = project.labeledFrames[0];
      useAppStore.getState().setFrameIdx(lf.frameIdx);
      useAppStore.getState().setLabeledFrame(lf);

      const beforeCount = lf.instances.length;
      await ctx.execute(DuplicateInstance);

      expect(lf.instances.length).toBe(beforeCount);
    });
  });

  describe("SetPointLocation", () => {
    it("updates point coordinates", async () => {
      const project = setupProjectInStore({ numFrames: 1, numInstancesPerFrame: 1 });
      const lf = project.labeledFrames[0];
      const inst = lf.instances[0];
      useAppStore.getState().setFrameIdx(lf.frameIdx);
      useAppStore.getState().setInstance(inst);

      await ctx.execute(SetPointLocation, { nodeIdx: 0, x: 99, y: 88 });

      expect(inst.points[0].xy[0]).toBe(99);
      expect(inst.points[0].xy[1]).toBe(88);
      expect(inst.points[0].visible).toBe(true);
    });

    it("does nothing for invalid nodeIdx", async () => {
      const project = setupProjectInStore({ numFrames: 1, numInstancesPerFrame: 1 });
      const lf = project.labeledFrames[0];
      const inst = lf.instances[0];
      useAppStore.getState().setInstance(inst);

      const origXY: [number, number] = [...inst.points[0].xy];
      await ctx.execute(SetPointLocation, { nodeIdx: -1, x: 99, y: 88 });
      expect(inst.points[0].xy).toEqual(origXY);

      await ctx.execute(SetPointLocation, { nodeIdx: 100, x: 99, y: 88 });
      expect(inst.points[0].xy).toEqual(origXY);
    });

    it("does nothing without params", async () => {
      setupProjectInStore({ numFrames: 1, numInstancesPerFrame: 1 });
      expect(() => ctx.execute(SetPointLocation)).not.toThrow();
    });
  });

  describe("DeleteFramePredictions", () => {
    it("removes predicted instances from current frame", async () => {
      const project = setupProjectInStore({
        numFrames: 1,
        numInstancesPerFrame: 1,
        withPredictions: true,
      });
      const lf = project.labeledFrames[0];
      useAppStore.getState().setFrameIdx(lf.frameIdx);
      useAppStore.getState().setLabeledFrame(lf);

      const totalBefore = lf.instances.length;
      const userBefore = lf.instances.filter((i) => !("score" in i)).length;

      await ctx.execute(DeleteFramePredictions);

      expect(lf.instances.length).toBe(userBefore);
      expect(lf.instances.length).toBeLessThan(totalBefore);
    });

    it("keeps user instances intact", async () => {
      const project = setupProjectInStore({
        numFrames: 1,
        numInstancesPerFrame: 2,
        withPredictions: true,
      });
      const lf = project.labeledFrames[0];
      useAppStore.getState().setFrameIdx(lf.frameIdx);
      useAppStore.getState().setLabeledFrame(lf);

      await ctx.execute(DeleteFramePredictions);

      // All remaining instances should be user instances
      for (const inst of lf.instances) {
        expect(inst instanceof PredictedInstance).toBe(false);
      }
      expect(lf.instances.length).toBe(2);
    });
  });

  describe("DeleteAllPredictions", () => {
    it("clears all predictions across all frames", async () => {
      vi.stubGlobal("confirm", () => true);
      const project = setupProjectInStore({
        numFrames: 3,
        numInstancesPerFrame: 1,
        withPredictions: true,
      });

      // Each frame has 1 user + 1 predicted = 2 instances
      for (const lf of project.labels.labeledFrames) {
        expect(lf.instances.length).toBe(2);
      }

      await ctx.execute(DeleteAllPredictions);

      // All predictions should be gone
      for (const lf of project.labels.labeledFrames) {
        for (const inst of lf.instances) {
          expect(inst instanceof PredictedInstance).toBe(false);
        }
      }
      vi.unstubAllGlobals();
    });

    it("does not push undo if nothing was removed", async () => {
      setupProjectInStore({
        numFrames: 2,
        numInstancesPerFrame: 1,
        withPredictions: false,
      });

      await ctx.execute(DeleteAllPredictions);
      expect(ctx.canUndo).toBe(false);
    });

    it("undo restores all frames after DeleteAllPredictions", async () => {
      vi.stubGlobal("confirm", () => true);
      const project = setupProjectInStore({
        numFrames: 3,
        numInstancesPerFrame: 1,
        withPredictions: true,
      });

      // Count instances before
      const countsBefore = project.labels.labeledFrames.map(
        (lf) => lf.instances.length
      );

      await ctx.execute(DeleteAllPredictions);

      // Verify predictions removed
      for (const lf of project.labels.labeledFrames) {
        expect(lf.instances.some((i) => "score" in i)).toBe(false);
      }

      // Undo
      const undone = ctx.undo();
      expect(undone).toBe(true);

      // All frames should be restored with their predictions
      const countsAfter = project.labels.labeledFrames.map(
        (lf) => lf.instances.length
      );
      expect(countsAfter).toEqual(countsBefore);

      // Verify predictions are back
      for (const lf of project.labels.labeledFrames) {
        expect(lf.instances.some((i) => "score" in i)).toBe(true);
      }
      vi.unstubAllGlobals();
    });

    it("removes empty labeled frames", async () => {
      // Create a project where some frames have ONLY predictions
      const project = setupProjectInStore({
        numFrames: 2,
        numInstancesPerFrame: 0,
        withPredictions: true,
      });

      // All frames have only predictions
      const beforeLength = project.labels.labeledFrames.length;
      expect(beforeLength).toBe(2);

      await ctx.execute(DeleteAllPredictions);

      // Frames with no remaining instances should be removed
      expect(project.labels.labeledFrames.length).toBe(0);
    });
  });
});

describe("Navigation commands", () => {
  let ctx: CommandContext;

  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  describe("GoToFrame", () => {
    it("navigates to specified frame", async () => {
      setupProjectInStore();

      await ctx.execute(GoToFrame, { frameIdx: 42 });
      expect(useAppStore.getState().frameIdx).toBe(42);
    });

    it("does nothing with invalid params", async () => {
      setupProjectInStore();
      useAppStore.getState().setFrameIdx(10);

      await ctx.execute(GoToFrame, { frameIdx: "not a number" });
      expect(useAppStore.getState().frameIdx).toBe(10);
    });

    it("does nothing with no params", async () => {
      setupProjectInStore();
      useAppStore.getState().setFrameIdx(10);

      await ctx.execute(GoToFrame);
      expect(useAppStore.getState().frameIdx).toBe(10);
    });

    it("clamps to video bounds", async () => {
      setupProjectInStore();
      // video has 100 frames (shape[0] = 100), max index = 99
      await ctx.execute(GoToFrame, { frameIdx: 200 });
      expect(useAppStore.getState().frameIdx).toBe(99);
    });
  });

  describe("GoNextLabeledFrame", () => {
    it("navigates to next labeled frame", async () => {
      setupProjectInStore({ numFrames: 3 });
      // Frames at indices 0, 10, 20
      useAppStore.getState().setFrameIdx(0);

      await ctx.execute(GoNextLabeledFrame);
      expect(useAppStore.getState().frameIdx).toBe(10);
    });

    it("wraps around to first labeled frame", async () => {
      setupProjectInStore({ numFrames: 3 });
      // Frames at indices 0, 10, 20
      useAppStore.getState().setFrameIdx(20);

      await ctx.execute(GoNextLabeledFrame);
      expect(useAppStore.getState().frameIdx).toBe(0);
    });

    it("does nothing without labels", async () => {
      // No project loaded
      await ctx.execute(GoNextLabeledFrame);
      expect(useAppStore.getState().frameIdx).toBe(0);
    });

    it("includes empty LabeledFrames (PyQt parity — they are still labeled frames)", async () => {
      // Frames with instances at 0, 10, 20; an empty (no-instance) frame at 5.
      // PyQt's GoNextLabeledFrame has no instance filter, so empty LabeledFrames
      // (e.g. pkg.slp leftovers) remain navigable; skipping image-less frames is
      // the separate imaged-navigation mode's job.
      const project = setupProjectInStore({ numFrames: 3, numInstancesPerFrame: 1 });
      project.labels.labeledFrames.push(
        new LabeledFrame({ video: project.video, frameIdx: 5 })
      );
      useAppStore.getState().setFrameIdx(0);

      await ctx.execute(GoNextLabeledFrame);

      expect(useAppStore.getState().frameIdx).toBe(5);
    });
  });

  describe("GoPrevLabeledFrame", () => {
    it("navigates to previous labeled frame", async () => {
      setupProjectInStore({ numFrames: 3 });
      // Frames at indices 0, 10, 20
      useAppStore.getState().setFrameIdx(20);

      await ctx.execute(GoPrevLabeledFrame);
      expect(useAppStore.getState().frameIdx).toBe(10);
    });

    it("wraps around to last labeled frame", async () => {
      setupProjectInStore({ numFrames: 3 });
      useAppStore.getState().setFrameIdx(0);

      await ctx.execute(GoPrevLabeledFrame);
      expect(useAppStore.getState().frameIdx).toBe(20);
    });
  });

  describe("GoNextSuggestion", () => {
    it("navigates to next suggestion frame", async () => {
      setupProjectInStore({ withSuggestions: true });
      // Suggestions at indices 5, 20, 35
      useAppStore.getState().setFrameIdx(0);

      await ctx.execute(GoNextSuggestion);
      expect(useAppStore.getState().frameIdx).toBe(5);
    });

    it("wraps to first suggestion", async () => {
      setupProjectInStore({ withSuggestions: true });
      useAppStore.getState().setFrameIdx(40);

      await ctx.execute(GoNextSuggestion);
      expect(useAppStore.getState().frameIdx).toBe(5);
    });

    it("does nothing with no suggestions", async () => {
      setupProjectInStore({ withSuggestions: false });
      useAppStore.getState().setFrameIdx(5);

      await ctx.execute(GoNextSuggestion);
      expect(useAppStore.getState().frameIdx).toBe(5);
    });

    it("crosses into the next video once the current video's suggestions run out (#326)", async () => {
      const skeleton = new Skeleton({ nodes: ["a"], name: "test" });
      const videoA = new Video({
        filename: "a.mp4",
        backendMetadata: { shape: [100, 480, 640, 3] },
        openBackend: false,
      });
      const videoB = new Video({
        filename: "b.mp4",
        backendMetadata: { shape: [100, 480, 640, 3] },
        openBackend: false,
      });
      const labels = new Labels({ videos: [videoA, videoB], skeletons: [skeleton] });
      labels.suggestions.push(
        { video: videoA, frameIdx: 80 } as unknown as import("@/types").SuggestionFrame,
        { video: videoB, frameIdx: 10 } as unknown as import("@/types").SuggestionFrame
      );
      useAppStore.getState().setLabels(labels, "test.slp");
      useAppStore.getState().setVideo(videoA);
      useAppStore.getState().setFrameIdx(80); // videoA's last (only) suggestion

      await ctx.execute(GoNextSuggestion);
      expect(useAppStore.getState().video).toBe(videoB);
      expect(useAppStore.getState().frameIdx).toBe(10);
    });
  });

  describe("GoPrevSuggestion", () => {
    it("navigates to previous suggestion frame", async () => {
      setupProjectInStore({ withSuggestions: true });
      // Suggestions at indices 5, 20, 35
      useAppStore.getState().setFrameIdx(35);

      await ctx.execute(GoPrevSuggestion);
      expect(useAppStore.getState().frameIdx).toBe(20);
    });

    it("wraps to last suggestion", async () => {
      setupProjectInStore({ withSuggestions: true });
      useAppStore.getState().setFrameIdx(2);

      await ctx.execute(GoPrevSuggestion);
      expect(useAppStore.getState().frameIdx).toBe(35);
    });

    it("crosses into the previous video once the current video's suggestions run out (#326)", async () => {
      const skeleton = new Skeleton({ nodes: ["a"], name: "test" });
      const videoA = new Video({
        filename: "a.mp4",
        backendMetadata: { shape: [100, 480, 640, 3] },
        openBackend: false,
      });
      const videoB = new Video({
        filename: "b.mp4",
        backendMetadata: { shape: [100, 480, 640, 3] },
        openBackend: false,
      });
      const labels = new Labels({ videos: [videoA, videoB], skeletons: [skeleton] });
      labels.suggestions.push(
        { video: videoA, frameIdx: 80 } as unknown as import("@/types").SuggestionFrame,
        { video: videoB, frameIdx: 10 } as unknown as import("@/types").SuggestionFrame
      );
      useAppStore.getState().setLabels(labels, "test.slp");
      useAppStore.getState().setVideo(videoB);
      useAppStore.getState().setFrameIdx(10); // videoB's first (only) suggestion

      await ctx.execute(GoPrevSuggestion);
      expect(useAppStore.getState().video).toBe(videoA);
      expect(useAppStore.getState().frameIdx).toBe(80);
    });
  });

  describe("GoToLastInteracted", () => {
    it("navigates to last interacted frame", async () => {
      setupProjectInStore();
      useAppStore.getState().setFrameIdx(42);
      useAppStore.getState().markChanged();

      // Now navigate away
      useAppStore.getState().setFrameIdx(0);

      await ctx.execute(GoToLastInteracted);
      expect(useAppStore.getState().frameIdx).toBe(42);
    });

    it("does nothing when no interacted frame", async () => {
      setupProjectInStore();
      useAppStore.getState().setFrameIdx(5);

      await ctx.execute(GoToLastInteracted);
      // lastInteractedFrame is null, so frameIdx stays
      expect(useAppStore.getState().frameIdx).toBe(5);
    });
  });

  describe("GoNextUserFrame", () => {
    it("navigates to next frame with user instances", async () => {
      setupProjectInStore({
        numFrames: 3,
        numInstancesPerFrame: 1,
        withPredictions: true,
      });
      // All frames have user instances at indices 0, 10, 20
      useAppStore.getState().setFrameIdx(0);

      await ctx.execute(GoNextUserFrame);
      expect(useAppStore.getState().frameIdx).toBe(10);
    });

    it("wraps to first user frame", async () => {
      setupProjectInStore({
        numFrames: 3,
        numInstancesPerFrame: 1,
      });
      useAppStore.getState().setFrameIdx(20);

      await ctx.execute(GoNextUserFrame);
      expect(useAppStore.getState().frameIdx).toBe(0);
    });
  });
});

describe("Track commands", () => {
  let ctx: CommandContext;

  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  describe("AddTrack", () => {
    it("creates a new track and assigns to selected instance", async () => {
      const project = setupProjectInStore({ numFrames: 1, numInstancesPerFrame: 1 });
      const inst = project.labeledFrames[0].instances[0];
      useAppStore.getState().setInstance(inst);

      await ctx.execute(AddTrack);

      expect(project.labels.tracks.length).toBe(1);
      expect(inst.track).toBe(project.labels.tracks[0]);
      expect(inst.track!.name).toBe("Track 1");
    });

    it("increments track number", async () => {
      const project = setupProjectInStore({
        numFrames: 1,
        numInstancesPerFrame: 2,
        withTracks: true,
      });
      // Already has Track 1 and Track 2
      const inst = project.labeledFrames[0].instances[0];
      useAppStore.getState().setInstance(inst);

      await ctx.execute(AddTrack);

      expect(project.labels.tracks.length).toBe(3);
      expect(project.labels.tracks[2].name).toBe("Track 3");
    });

    it("does nothing without selected instance", async () => {
      const project = setupProjectInStore({ numFrames: 1, numInstancesPerFrame: 1 });
      // No instance selected

      await ctx.execute(AddTrack);
      expect(project.labels.tracks.length).toBe(0);
    });
  });

  describe("SetInstanceTrack", () => {
    it("assigns an existing track to selected instance", async () => {
      const project = setupProjectInStore({
        numFrames: 1,
        numInstancesPerFrame: 2,
        withTracks: true,
      });
      const inst = project.labeledFrames[0].instances[0];
      useAppStore.getState().setInstance(inst);

      await ctx.execute(SetInstanceTrack, { trackIdx: 1 });

      expect(inst.track).toBe(project.tracks[1]);
    });

    it("does nothing for out-of-bounds trackIdx", async () => {
      const project = setupProjectInStore({
        numFrames: 1,
        numInstancesPerFrame: 1,
        withTracks: true,
      });
      const inst = project.labeledFrames[0].instances[0];
      const origTrack = inst.track;
      useAppStore.getState().setInstance(inst);

      await ctx.execute(SetInstanceTrack, { trackIdx: 99 });
      expect(inst.track).toBe(origTrack);

      await ctx.execute(SetInstanceTrack, { trackIdx: -1 });
      expect(inst.track).toBe(origTrack);
    });
  });

  describe("TransposeInstances", () => {
    it("swaps tracks between two instances", async () => {
      const project = setupProjectInStore({
        numFrames: 1,
        numInstancesPerFrame: 2,
        withTracks: true,
      });
      const lf = project.labeledFrames[0];
      const inst0 = lf.instances[0];
      const inst1 = lf.instances[1];
      useAppStore.getState().setFrameIdx(lf.frameIdx);
      useAppStore.getState().setLabeledFrame(lf);
      useAppStore.getState().setInstance(inst0);

      const track0Before = inst0.track;
      const track1Before = inst1.track;

      await ctx.execute(TransposeInstances);

      expect(inst0.track).toBe(track1Before);
      expect(inst1.track).toBe(track0Before);
    });

    it("does nothing with only one instance", async () => {
      const project = setupProjectInStore({
        numFrames: 1,
        numInstancesPerFrame: 1,
        withTracks: true,
      });
      const lf = project.labeledFrames[0];
      const inst = lf.instances[0];
      useAppStore.getState().setFrameIdx(lf.frameIdx);
      useAppStore.getState().setLabeledFrame(lf);
      useAppStore.getState().setInstance(inst);

      const trackBefore = inst.track;
      await ctx.execute(TransposeInstances);
      expect(inst.track).toBe(trackBefore);
    });
  });

  describe("CopyTrack / PasteTrack", () => {
    it("copies and pastes track between instances", async () => {
      const project = setupProjectInStore({
        numFrames: 1,
        numInstancesPerFrame: 2,
        withTracks: true,
      });
      const lf = project.labeledFrames[0];
      const inst0 = lf.instances[0];
      const inst1 = lf.instances[1];

      // Copy track from inst0
      useAppStore.getState().setInstance(inst0);
      await ctx.execute(CopyTrack);

      expect(useAppStore.getState().clipboardTrack).toBe(inst0.track ?? null);

      // Paste onto inst1
      useAppStore.getState().setInstance(inst1);
      await ctx.execute(PasteTrack);

      expect(inst1.track).toBe(inst0.track);
    });

    it("CopyTrack does nothing when instance has no track", async () => {
      const project = setupProjectInStore({
        numFrames: 1,
        numInstancesPerFrame: 1,
        withTracks: false,
      });
      const inst = project.labeledFrames[0].instances[0];
      useAppStore.getState().setInstance(inst);

      await ctx.execute(CopyTrack);
      expect(useAppStore.getState().clipboardTrack).toBeNull();
    });

    it("PasteTrack does nothing without clipboard", async () => {
      const project = setupProjectInStore({
        numFrames: 1,
        numInstancesPerFrame: 1,
        withTracks: true,
      });
      const inst = project.labeledFrames[0].instances[0];
      useAppStore.getState().setInstance(inst);

      const origTrack = inst.track;
      await ctx.execute(PasteTrack);
      expect(inst.track).toBe(origTrack);
    });
  });

  describe("PropagateTrackLabels", () => {
    it("propagates track assignment forward from current frame", async () => {
      const project = setupProjectInStore({
        numFrames: 3,
        numInstancesPerFrame: 2,
        withTracks: true,
      });
      const [track1, track2] = project.tracks;
      // Frame 0: inst0=track1, inst1=track2
      // Frame 10: inst0=track1, inst1=track2
      // Frame 20: inst0=track1, inst1=track2

      // Current frame is 0 — propagate swap forward
      useAppStore.getState().setFrameIdx(0);

      await ctx.execute(PropagateTrackLabels, {
        oldTrack: track1,
        newTrack: track2,
      });

      // Frame 10 and 20 should have tracks swapped
      // (bidirectional: track1->track2, track2->track1)
      const lf1 = project.labeledFrames[1]; // frameIdx=10
      expect(lf1.instances[0].track).toBe(track2);
      expect(lf1.instances[1].track).toBe(track1);

      const lf2 = project.labeledFrames[2]; // frameIdx=20
      expect(lf2.instances[0].track).toBe(track2);
      expect(lf2.instances[1].track).toBe(track1);
    });

    it("does not change the current frame", async () => {
      const project = setupProjectInStore({
        numFrames: 3,
        numInstancesPerFrame: 2,
        withTracks: true,
      });
      const [track1, track2] = project.tracks;
      const lf0 = project.labeledFrames[0];

      useAppStore.getState().setFrameIdx(0);

      const inst0TrackBefore = lf0.instances[0].track;
      const inst1TrackBefore = lf0.instances[1].track;

      await ctx.execute(PropagateTrackLabels, {
        oldTrack: track1,
        newTrack: track2,
      });

      // Frame 0 should NOT be changed
      expect(lf0.instances[0].track).toBe(inst0TrackBefore);
      expect(lf0.instances[1].track).toBe(inst1TrackBefore);
    });

    it("does nothing without params", async () => {
      setupProjectInStore({
        numFrames: 2,
        numInstancesPerFrame: 1,
        withTracks: true,
      });

      expect(() => ctx.execute(PropagateTrackLabels)).not.toThrow();
    });
  });
});

describe("Edit commands (new)", () => {
  let ctx: CommandContext;

  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  describe("ConvertPredictionToInstance", () => {
    it("converts a predicted instance to a user instance", async () => {
      const project = setupProjectInStore({
        numFrames: 1,
        numInstancesPerFrame: 0,
        withPredictions: true,
      });
      const lf = project.labeledFrames[0];
      useAppStore.getState().setFrameIdx(lf.frameIdx);

      // The predicted instance is at index 0 (no user instances)
      expect("score" in lf.instances[0]).toBe(true);

      await ctx.execute(ConvertPredictionToInstance, { instanceIdx: 0 });

      // Should be replaced with a user instance
      expect("score" in lf.instances[0]).toBe(false);
    });

    it("preserves point data from prediction", async () => {
      const project = setupProjectInStore({
        numFrames: 1,
        numInstancesPerFrame: 0,
        withPredictions: true,
      });
      const lf = project.labeledFrames[0];
      useAppStore.getState().setFrameIdx(lf.frameIdx);

      const predPoints = lf.instances[0].points.map((p) => [...p.xy]);

      await ctx.execute(ConvertPredictionToInstance, { instanceIdx: 0 });

      const userInst = lf.instances[0];
      for (let i = 0; i < predPoints.length; i++) {
        expect(userInst.points[i].xy[0]).toBe(predPoints[i][0]);
        expect(userInst.points[i].xy[1]).toBe(predPoints[i][1]);
      }
    });

    it("selects the new user instance", async () => {
      const project = setupProjectInStore({
        numFrames: 1,
        numInstancesPerFrame: 0,
        withPredictions: true,
      });
      const lf = project.labeledFrames[0];
      useAppStore.getState().setFrameIdx(lf.frameIdx);

      await ctx.execute(ConvertPredictionToInstance, { instanceIdx: 0 });

      const selected = useAppStore.getState().instance;
      expect(selected).not.toBeNull();
      expect(selected).toBe(lf.instances[0]);
    });

    it("does nothing for non-predicted instance", async () => {
      const project = setupProjectInStore({
        numFrames: 1,
        numInstancesPerFrame: 1,
        withPredictions: false,
      });
      const lf = project.labeledFrames[0];
      useAppStore.getState().setFrameIdx(lf.frameIdx);

      const before = lf.instances[0];
      await ctx.execute(ConvertPredictionToInstance, { instanceIdx: 0 });

      // Should still be the same instance (no conversion)
      expect(lf.instances[0]).toBe(before);
    });

    it("does nothing without instanceIdx", async () => {
      setupProjectInStore({ numFrames: 1, numInstancesPerFrame: 0, withPredictions: true });
      expect(() => ctx.execute(ConvertPredictionToInstance)).not.toThrow();
    });

    it("carries the fromPredicted provenance link", async () => {
      const project = setupProjectInStore({
        numFrames: 1,
        numInstancesPerFrame: 0,
        withPredictions: true,
      });
      const lf = project.labeledFrames[0];
      useAppStore.getState().setFrameIdx(lf.frameIdx);
      const pred = lf.instances[0];

      await ctx.execute(ConvertPredictionToInstance, { instanceIdx: 0 });

      const userInst = lf.instances[0] as Instance;
      expect(userInst.fromPredicted).toBe(pred as PredictedInstance);
    });
  });

  describe("AddInstancesFromAllPredictions", () => {
    /** Frame with 1 user instance + 2 predicted instances. */
    function frameWithTwoPredictions() {
      const project = setupProjectInStore({
        numFrames: 1,
        numInstancesPerFrame: 1,
        withPredictions: true, // adds 1 predicted
      });
      const lf = project.labeledFrames[0];
      // Add a second predicted instance so we exercise "accept ALL".
      lf.instances.push(
        new PredictedInstance({
          skeleton: project.skeleton,
          points: project.skeleton.nodes.map((node, n) => ({
            xy: [300 + n, 400 + n] as [number, number],
            visible: true,
            complete: true,
            name: node.name,
            score: 0.9,
          })),
          score: 0.9,
        }),
      );
      useAppStore.getState().setFrameIdx(lf.frameIdx);
      return { project, lf };
    }

    it("replaces every predicted instance in place, leaving user instances", async () => {
      const { lf } = frameWithTwoPredictions();
      const userBefore = lf.instances.find(
        (i) => !(i instanceof PredictedInstance),
      );
      expect(lf.instances.length).toBe(3);

      await ctx.execute(AddInstancesFromAllPredictions);

      // Same count (replace-in-place, not append) and no predictions remain.
      expect(lf.instances.length).toBe(3);
      expect(lf.instances.some((i) => i instanceof PredictedInstance)).toBe(
        false,
      );
      // The pre-existing user instance is untouched (same reference).
      expect(lf.instances).toContain(userBefore!);
    });

    it("preserves fromPredicted provenance on the converted instances", async () => {
      const { lf } = frameWithTwoPredictions();
      const predsBefore = lf.instances.filter(
        (i) => i instanceof PredictedInstance,
      ) as PredictedInstance[];

      await ctx.execute(AddInstancesFromAllPredictions);

      const converted = lf.instances.filter(
        (i) => (i as Instance).fromPredicted != null,
      ) as Instance[];
      expect(converted.length).toBe(2);
      for (const inst of converted) {
        expect(predsBefore).toContain(inst.fromPredicted as PredictedInstance);
      }
    });

    it("selects a converted user instance and marks changes", async () => {
      const { lf } = frameWithTwoPredictions();

      await ctx.execute(AddInstancesFromAllPredictions);

      const selected = useAppStore.getState().instance;
      expect(selected).not.toBeNull();
      expect(selected instanceof PredictedInstance).toBe(false);
      expect(lf.instances).toContain(selected!);
      expect(useAppStore.getState().hasChanges).toBe(true);
    });

    it("is undoable — restores the predictions", async () => {
      const { lf } = frameWithTwoPredictions();

      await ctx.execute(AddInstancesFromAllPredictions);
      expect(lf.instances.some((i) => i instanceof PredictedInstance)).toBe(
        false,
      );

      expect(ctx.undo()).toBe(true);

      const restored = useAppStore
        .getState()
        .labels!.find({ video: useAppStore.getState().video!, frameIdx: lf.frameIdx })[0];
      expect(
        restored.instances.filter((i) => i instanceof PredictedInstance).length,
      ).toBe(2);
    });

    it("no-ops (no undo entry) when the frame has no predictions", async () => {
      const project = setupProjectInStore({
        numFrames: 1,
        numInstancesPerFrame: 1,
        withPredictions: false,
      });
      const lf = project.labeledFrames[0];
      useAppStore.getState().setFrameIdx(lf.frameIdx);
      const before = [...lf.instances];

      await ctx.execute(AddInstancesFromAllPredictions);

      expect(lf.instances).toEqual(before);
      // skipAutoSnapshot + early return ⇒ nothing pushed onto the undo stack.
      expect(ctx.canUndo).toBe(false);
    });
  });

  describe("AddInstancesFromAllPredictionsInProject", () => {
    it("replaces every predicted instance across all frames, leaving user instances", async () => {
      const project = setupProjectInStore({
        numFrames: 3,
        numInstancesPerFrame: 1,
        withPredictions: true,
      });

      await ctx.execute(AddInstancesFromAllPredictionsInProject);

      for (const lf of project.labeledFrames) {
        expect(lf.instances.length).toBe(2); // 1 user + 1 accepted prediction
        expect(
          lf.instances.some((i) => i instanceof PredictedInstance),
        ).toBe(false);
      }
    });

    it("preserves fromPredicted provenance on the converted instances", async () => {
      const project = setupProjectInStore({
        numFrames: 3,
        numInstancesPerFrame: 1,
        withPredictions: true,
      });
      const predsBefore = project.labeledFrames.map(
        (lf) =>
          lf.instances.find(
            (i) => i instanceof PredictedInstance,
          ) as PredictedInstance,
      );

      await ctx.execute(AddInstancesFromAllPredictionsInProject);

      project.labeledFrames.forEach((lf, i) => {
        const converted = lf.instances.find(
          (inst) => (inst as Instance).fromPredicted === predsBefore[i],
        );
        expect(converted).toBeDefined();
      });
    });

    it("marks changes and is undoable across all frames", async () => {
      const project = setupProjectInStore({
        numFrames: 3,
        numInstancesPerFrame: 1,
        withPredictions: true,
      });

      await ctx.execute(AddInstancesFromAllPredictionsInProject);
      expect(useAppStore.getState().hasChanges).toBe(true);
      for (const lf of project.labeledFrames) {
        expect(
          lf.instances.some((i) => i instanceof PredictedInstance),
        ).toBe(false);
      }

      expect(ctx.undo()).toBe(true);

      const labels = useAppStore.getState().labels!;
      for (const lf of project.labeledFrames) {
        const restored = labels.find({
          video: project.video,
          frameIdx: lf.frameIdx,
        })[0];
        expect(
          restored.instances.filter((i) => i instanceof PredictedInstance)
            .length,
        ).toBe(1);
      }
    });

    it("no-ops when the project has no predictions", async () => {
      const project = setupProjectInStore({
        numFrames: 3,
        numInstancesPerFrame: 1,
        withPredictions: false,
      });
      const before = project.labeledFrames.map((lf) => [...lf.instances]);

      await ctx.execute(AddInstancesFromAllPredictionsInProject);

      project.labeledFrames.forEach((lf, i) => {
        expect(lf.instances).toEqual(before[i]);
      });
      expect(ctx.canUndo).toBe(false);
    });
  });

  describe("MoveInstance", () => {
    it("translates all visible points by dx/dy", async () => {
      const project = setupProjectInStore({
        numFrames: 1,
        numInstancesPerFrame: 1,
      });
      const inst = project.labeledFrames[0].instances[0];
      useAppStore.getState().setInstance(inst);

      const origPoints = inst.points.map((p) => [...p.xy]);

      await ctx.execute(MoveInstance, { dx: 5, dy: -3 });

      for (let i = 0; i < inst.points.length; i++) {
        if (!isNaN(origPoints[i][0])) {
          expect(inst.points[i].xy[0]).toBe(origPoints[i][0] + 5);
          expect(inst.points[i].xy[1]).toBe(origPoints[i][1] - 3);
        }
      }
    });

    it("skips NaN points", async () => {
      const project = setupProjectInStore({
        numFrames: 1,
        numInstancesPerFrame: 1,
      });
      const inst = project.labeledFrames[0].instances[0];
      // Make one point NaN
      inst.points[0].xy = [NaN, NaN];
      useAppStore.getState().setInstance(inst);

      await ctx.execute(MoveInstance, { dx: 10, dy: 10 });

      // NaN point should stay NaN
      expect(isNaN(inst.points[0].xy[0])).toBe(true);
      expect(isNaN(inst.points[0].xy[1])).toBe(true);

      // Other points should be moved
      expect(inst.points[1].xy[0]).not.toBeNaN();
    });

    it("does nothing without params", async () => {
      const project = setupProjectInStore({ numFrames: 1, numInstancesPerFrame: 1 });
      const inst = project.labeledFrames[0].instances[0];
      useAppStore.getState().setInstance(inst);

      const origXY: [number, number] = [...inst.points[0].xy];
      await ctx.execute(MoveInstance);
      expect(inst.points[0].xy).toEqual(origXY);
    });

    it("does nothing without selected instance", async () => {
      setupProjectInStore({ numFrames: 1, numInstancesPerFrame: 1 });
      expect(() => ctx.execute(MoveInstance, { dx: 5, dy: 5 })).not.toThrow();
    });
  });

  describe("RotateInstance", () => {
    it("rotates points around centroid", async () => {
      const project = setupProjectInStore({
        numFrames: 1,
        numInstancesPerFrame: 1,
        numNodes: 2,
      });
      const inst = project.labeledFrames[0].instances[0];
      // Set known coordinates
      inst.points[0].xy = [0, 0];
      inst.points[1].xy = [10, 0];
      useAppStore.getState().setInstance(inst);

      // Rotate by pi/2 (90 degrees)
      await ctx.execute(RotateInstance, { angle: Math.PI / 2 });

      // After 90 degree rotation around centroid (5, 0):
      // Point (0, 0) -> (5, -5)
      // Point (10, 0) -> (5, 5)
      expect(inst.points[0].xy[0]).toBeCloseTo(5, 5);
      expect(inst.points[0].xy[1]).toBeCloseTo(-5, 5);
      expect(inst.points[1].xy[0]).toBeCloseTo(5, 5);
      expect(inst.points[1].xy[1]).toBeCloseTo(5, 5);
    });

    it("does nothing for predicted instances", async () => {
      const project = setupProjectInStore({
        numFrames: 1,
        numInstancesPerFrame: 0,
        withPredictions: true,
      });
      const pred = project.labeledFrames[0].instances[0];
      useAppStore.getState().setInstance(pred);

      const origXY = pred.points.map((p) => [...p.xy]);
      await ctx.execute(RotateInstance, { angle: Math.PI / 4 });

      for (let i = 0; i < pred.points.length; i++) {
        expect(pred.points[i].xy[0]).toBe(origXY[i][0]);
        expect(pred.points[i].xy[1]).toBe(origXY[i][1]);
      }
    });

    it("does nothing without angle param", async () => {
      const project = setupProjectInStore({ numFrames: 1, numInstancesPerFrame: 1 });
      const inst = project.labeledFrames[0].instances[0];
      useAppStore.getState().setInstance(inst);

      const origXY: [number, number] = [...inst.points[0].xy];
      await ctx.execute(RotateInstance);
      expect(inst.points[0].xy).toEqual(origXY);
    });
  });

  describe("BeginEdit", () => {
    it("is a no-op that creates an undo snapshot", async () => {
      setupProjectInStore({ numFrames: 1, numInstancesPerFrame: 1 });
      useAppStore.getState().setFrameIdx(0);

      expect(ctx.canUndo).toBe(false);

      await ctx.execute(BeginEdit);

      expect(ctx.canUndo).toBe(true);
      expect(ctx.undoCommandName).toBe("BeginEdit");
    });
  });
});

describe("Navigation commands (new)", () => {
  let ctx: CommandContext;

  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  describe("GoNextTrackSpawnFrame", () => {
    it("navigates to next track spawn frame", async () => {
      const project = setupProjectInStore({
        numFrames: 3,
        numInstancesPerFrame: 1,
        withTracks: true,
      });
      // Track 1 appears on all frames (0, 10, 20)
      // Spawn frame for Track 1 is 0
      useAppStore.getState().setFrameIdx(0);

      // First track spawns at 0, second track also at 0
      // No spawn frame after 0 that isn't at 0
      // Let's make a scenario where tracks spawn at different frames
      // Track 2 only on frame 10
      const track3 = new Track("Track 3");
      project.labels.tracks.push(track3);
      const lf2 = project.labeledFrames[2]; // frameIdx 20
      lf2.instances[0].track = track3;

      useAppStore.getState().setFrameIdx(0);
      await ctx.execute(GoNextTrackSpawnFrame);

      // Track 1 spawns at 0, Track 2 spawns at 0, Track 3 spawns at 20
      // From frame 0, next spawn after 0 is 20
      expect(useAppStore.getState().frameIdx).toBe(20);
    });

    it("wraps around to first spawn frame", async () => {
      setupProjectInStore({
        numFrames: 3,
        numInstancesPerFrame: 1,
        withTracks: true,
      });
      // All tracks spawn at frame 0
      useAppStore.getState().setFrameIdx(50);

      await ctx.execute(GoNextTrackSpawnFrame);

      // Should wrap to first spawn frame (0)
      expect(useAppStore.getState().frameIdx).toBe(0);
    });

    it("does nothing without tracks", async () => {
      setupProjectInStore({
        numFrames: 3,
        numInstancesPerFrame: 1,
        withTracks: false,
      });
      useAppStore.getState().setFrameIdx(5);

      await ctx.execute(GoNextTrackSpawnFrame);
      expect(useAppStore.getState().frameIdx).toBe(5);
    });

    it("does nothing without labels", async () => {
      // No project loaded
      useAppStore.setState({ frameIdx: 5 });

      await ctx.execute(GoNextTrackSpawnFrame);
      expect(useAppStore.getState().frameIdx).toBe(5);
    });
  });
});
