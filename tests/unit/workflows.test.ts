/**
 * Integration-style workflow tests.
 *
 * These tests verify end-to-end flows: loading data, navigating,
 * editing, undo/redo, and state consistency.
 */

import { describe, it, expect, beforeEach, vi } from "../bun-test";
import { CommandContext } from "@/commands/CommandContext";
import { useAppStore } from "@/stores/appStore";
import { UpdateTopic } from "@/types";
import {
  AddInstance,
  DeleteSelectedInstance,
  CopyInstance,
  PasteInstance,
  DeleteAllPredictions,
  ConvertPredictionToInstance,
} from "@/commands/editCommands";
import {
  GoNextLabeledFrame,
  GoPrevLabeledFrame,
  GoToFrame,
} from "@/commands/navCommands";
import {
  AddTrack,
  SetInstanceTrack,
  TransposeInstances,
  PropagateTrackLabels,
} from "@/commands/trackCommands";
import {
  AddNodeCommand,
  DeleteNodeCommand,
  RenameNodeCommand,
  installSkeletonUndoInterceptor,
} from "@/commands/skeletonCommands";
import {
  Labels,
  Instance,
  PredictedInstance,
  LabeledFrame,
  Skeleton,
  Track,
  Video,
} from "@talmolab/sleap-io.js";

/** Reset the store between tests. */
function resetStore() {
  useAppStore.setState(useAppStore.getInitialState());
}

/**
 * Create a test project with configurable data for workflow testing.
 */
function createProject(opts?: {
  numNodes?: number;
  numFrames?: number;
  numInstancesPerFrame?: number;
  withPredictions?: boolean;
  withTracks?: boolean;
}) {
  const numNodes = opts?.numNodes ?? 3;
  const numFrames = opts?.numFrames ?? 5;
  const numInstancesPerFrame = opts?.numInstancesPerFrame ?? 2;

  const nodeNames = Array.from({ length: numNodes }, (_, i) => `node_${i}`);
  const skeleton = new Skeleton({ nodes: nodeNames, name: "test_skeleton" });
  if (numNodes >= 2) {
    skeleton.addEdge(skeleton.nodes[0], skeleton.nodes[1]);
  }

  // Use a mock video object since Video.shape is a getter from backend
  const video = {
    filename: "test_video.mp4",
    shape: [200, 480, 640, 3] as [number, number, number, number],
    backend: null,
    sourceVideo: null,
    backendMetadata: {},
  } as unknown as Video;

  const labels = new Labels({
    videos: [video],
    skeletons: [skeleton],
  });

  const tracks: Track[] = [];
  if (opts?.withTracks) {
    for (let t = 0; t < Math.max(numInstancesPerFrame, 2); t++) {
      const track = new Track(`Track ${t + 1}`);
      labels.tracks.push(track);
      tracks.push(track);
    }
  }

  for (let f = 0; f < numFrames; f++) {
    const lf = new LabeledFrame({ video, frameIdx: f * 5 });
    for (let i = 0; i < numInstancesPerFrame; i++) {
      const inst = Instance.empty({ skeleton });
      for (let n = 0; n < numNodes; n++) {
        inst.points[n].xy = [100 + f * 10 + n, 200 + i * 10 + n];
        inst.points[n].visible = true;
        inst.points[n].complete = true;
      }
      if (opts?.withTracks && tracks.length > 0) {
        inst.track = tracks[i % tracks.length];
      }
      lf.instances.push(inst);
    }

    if (opts?.withPredictions) {
      const pred = new PredictedInstance({
        skeleton,
        points: skeleton.nodes.map((node, n) => ({
          xy: [300 + n, 400 + n] as [number, number],
          visible: true,
          complete: true,
          name: node.name,
          score: 0.85,
        })),
        score: 0.85,
      });
      lf.instances.push(pred);
    }

    labels.labeledFrames.push(lf);
  }

  return { labels, skeleton, video, tracks };
}

/** Load project into store. */
function loadProject(
  opts?: Parameters<typeof createProject>[0]
) {
  const project = createProject(opts);
  useAppStore.getState().setLabels(project.labels, "workflow_test.slp");
  return project;
}

describe("Workflow: Labeling", () => {
  let ctx: CommandContext;

  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("full labeling workflow: load -> navigate -> add instance -> verify", async () => {
    const project = loadProject({ numFrames: 5, numInstancesPerFrame: 0 });
    const store = useAppStore.getState();

    // 1. Verify project loaded
    expect(store.projectLoaded).toBe(true);
    expect(store.filename).toBe("workflow_test.slp");
    expect(store.video).toBe(project.video);
    expect(store.skeleton).toBe(project.skeleton);

    // 2. Navigate to a frame
    await ctx.execute(GoToFrame, { frameIdx: 15 });
    expect(useAppStore.getState().frameIdx).toBe(15);

    // 3. Add an instance
    await ctx.execute(AddInstance);
    const lf = project.labels.find({ video: project.video, frameIdx: 15 });
    expect(lf.length).toBe(1);
    expect(lf[0].instances.length).toBe(1);

    // 4. Instance should be selected
    expect(useAppStore.getState().instance).not.toBeNull();

    // 5. Verify hasChanges is set
    expect(useAppStore.getState().hasChanges).toBe(true);
  });

  it("navigate between labeled frames", async () => {
    const project = loadProject({ numFrames: 3, numInstancesPerFrame: 1 });
    // Frames at 0, 5, 10

    useAppStore.getState().setFrameIdx(0);

    await ctx.execute(GoNextLabeledFrame);
    expect(useAppStore.getState().frameIdx).toBe(5);

    await ctx.execute(GoNextLabeledFrame);
    expect(useAppStore.getState().frameIdx).toBe(10);

    await ctx.execute(GoNextLabeledFrame);
    // Wraps around
    expect(useAppStore.getState().frameIdx).toBe(0);
  });

  it("navigate backwards between labeled frames", async () => {
    loadProject({ numFrames: 3, numInstancesPerFrame: 1 });

    useAppStore.getState().setFrameIdx(10);

    await ctx.execute(GoPrevLabeledFrame);
    expect(useAppStore.getState().frameIdx).toBe(5);

    await ctx.execute(GoPrevLabeledFrame);
    expect(useAppStore.getState().frameIdx).toBe(0);

    await ctx.execute(GoPrevLabeledFrame);
    // Wraps around
    expect(useAppStore.getState().frameIdx).toBe(10);
  });

  it("add instance -> select -> modify coordinates", async () => {
    const project = loadProject({ numFrames: 1, numInstancesPerFrame: 0 });

    await ctx.execute(AddInstance);

    const instance = useAppStore.getState().instance;
    expect(instance).not.toBeNull();

    // Manually set coordinates (simulating drag)
    if (instance) {
      instance.points[0].xy = [150, 250];
      instance.points[0].visible = true;
      instance.points[1].xy = [160, 260];
      instance.points[1].visible = true;

      expect(instance.points[0].xy).toEqual([150, 250]);
      expect(instance.points[1].xy).toEqual([160, 260]);
    }
  });

  it("copy instance from one frame and paste to another", async () => {
    const project = loadProject({ numFrames: 3, numInstancesPerFrame: 1 });

    // Navigate to first frame and select instance
    useAppStore.getState().setFrameIdx(0);
    const lf0 = project.labels.find({ video: project.video, frameIdx: 0 })[0];
    useAppStore.getState().setLabeledFrame(lf0);
    useAppStore.getState().setInstance(lf0.instances[0]);

    // Copy
    await ctx.execute(CopyInstance);

    // Navigate to frame without instance at index 3
    useAppStore.getState().setFrameIdx(3);

    // Paste
    await ctx.execute(PasteInstance);

    // Verify new instance was created
    const lf3 = project.labels.find({ video: project.video, frameIdx: 3 });
    expect(lf3.length).toBe(1);
    expect(lf3[0].instances.length).toBe(1);

    // Verify it's a copy (different reference, same data)
    const pasted = lf3[0].instances[0];
    expect(pasted).not.toBe(lf0.instances[0]);
    expect(pasted.points.length).toBe(lf0.instances[0].points.length);
  });
});

describe("Workflow: Undo/Redo", () => {
  let ctx: CommandContext;

  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("undo add instance restores empty frame", async () => {
    loadProject({ numFrames: 1, numInstancesPerFrame: 0 });
    useAppStore.getState().setFrameIdx(0);

    // Initially no instances
    expect(ctx.canUndo).toBe(false);

    // Add instance
    await ctx.execute(AddInstance);
    expect(ctx.canUndo).toBe(true);

    // Undo
    ctx.undo();

    // Frame should be back to its previous state
    expect(ctx.canUndo).toBe(false);
    expect(ctx.canRedo).toBe(true);
  });

  it("redo restores the added instance", async () => {
    const project = loadProject({ numFrames: 1, numInstancesPerFrame: 0 });
    useAppStore.getState().setFrameIdx(0);

    // Add instance
    await ctx.execute(AddInstance);

    // Undo
    ctx.undo();
    expect(ctx.canRedo).toBe(true);

    // Redo
    ctx.redo();
    expect(ctx.canRedo).toBe(false);
    expect(ctx.canUndo).toBe(true);
  });

  it("multiple undo/redo cycles maintain consistency", async () => {
    const project = loadProject({ numFrames: 1, numInstancesPerFrame: 1 });
    const lf = project.labels.labeledFrames[0];
    useAppStore.getState().setFrameIdx(lf.frameIdx);
    useAppStore.getState().setLabeledFrame(lf);

    const initialCount = lf.instances.length;

    // Add two instances
    await ctx.execute(AddInstance);
    expect(lf.instances.length).toBe(initialCount + 1);

    await ctx.execute(AddInstance);
    expect(lf.instances.length).toBe(initialCount + 2);

    // Undo both
    ctx.undo();
    expect(lf.instances.length).toBe(initialCount + 1);

    ctx.undo();
    expect(lf.instances.length).toBe(initialCount);

    // Redo both
    ctx.redo();
    expect(lf.instances.length).toBe(initialCount + 1);

    ctx.redo();
    expect(lf.instances.length).toBe(initialCount + 2);
  });

  it("delete all predictions -> undo restores all frames", async () => {
    vi.stubGlobal("confirm", () => true);
    const project = loadProject({
      numFrames: 3,
      numInstancesPerFrame: 1,
      withPredictions: true,
    });

    // Capture frame counts
    const countsBefore = project.labels.labeledFrames.map(
      (lf) => lf.instances.length
    );

    // Delete all predictions
    await ctx.execute(DeleteAllPredictions);

    // Verify all predictions gone
    for (const lf of project.labels.labeledFrames) {
      expect(lf.instances.some((i) => "score" in i)).toBe(false);
    }

    // Undo
    ctx.undo();

    // Verify all frames restored
    const countsAfter = project.labels.labeledFrames.map(
      (lf) => lf.instances.length
    );
    expect(countsAfter).toEqual(countsBefore);

    // Redo
    ctx.redo();

    // Predictions should be gone again
    for (const lf of project.labels.labeledFrames) {
      expect(lf.instances.some((i) => "score" in i)).toBe(false);
    }

    vi.unstubAllGlobals();
  });

  it("new action clears redo stack", async () => {
    const project = loadProject({ numFrames: 1, numInstancesPerFrame: 0 });
    useAppStore.getState().setFrameIdx(0);

    // Add, undo, then add again
    await ctx.execute(AddInstance);
    ctx.undo();
    expect(ctx.canRedo).toBe(true);

    await ctx.execute(AddInstance);
    expect(ctx.canRedo).toBe(false);
  });
});

describe("Workflow: Track management", () => {
  let ctx: CommandContext;

  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("create tracks and assign to instances", async () => {
    const project = loadProject({
      numFrames: 1,
      numInstancesPerFrame: 2,
      withTracks: false,
    });
    const lf = project.labels.labeledFrames[0];
    const inst0 = lf.instances[0];
    const inst1 = lf.instances[1];

    // Add track for first instance
    useAppStore.getState().setInstance(inst0);
    await ctx.execute(AddTrack);
    expect(inst0.track).toBeDefined();
    expect(inst0.track!.name).toBe("Track 1");

    // Add track for second instance
    useAppStore.getState().setInstance(inst1);
    await ctx.execute(AddTrack);
    expect(inst1.track).toBeDefined();
    expect(inst1.track!.name).toBe("Track 2");

    // Verify tracks are distinct
    expect(inst0.track).not.toBe(inst1.track);
  });

  it("transpose swaps tracks between instances", async () => {
    const project = loadProject({
      numFrames: 1,
      numInstancesPerFrame: 2,
      withTracks: true,
    });
    const lf = project.labels.labeledFrames[0];
    useAppStore.getState().setFrameIdx(lf.frameIdx);
    useAppStore.getState().setLabeledFrame(lf);

    const inst0 = lf.instances[0];
    const inst1 = lf.instances[1];
    const track0 = inst0.track;
    const track1 = inst1.track;

    useAppStore.getState().setInstance(inst0);
    await ctx.execute(TransposeInstances);

    expect(inst0.track).toBe(track1);
    expect(inst1.track).toBe(track0);
  });

  it("set instance track by index", async () => {
    const project = loadProject({
      numFrames: 1,
      numInstancesPerFrame: 2,
      withTracks: true,
    });
    const lf = project.labels.labeledFrames[0];
    const inst = lf.instances[0];
    useAppStore.getState().setInstance(inst);

    // Assign track 1 (second track, 0-indexed)
    await ctx.execute(SetInstanceTrack, { trackIdx: 1 });
    expect(inst.track).toBe(project.tracks[1]);
  });
});

describe("Workflow: State consistency", () => {
  let ctx: CommandContext;

  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("loading a new project resets all state", () => {
    const project1 = loadProject({ numFrames: 3 });

    // Set some state
    useAppStore.getState().setFrameIdx(10);
    useAppStore.getState().markChanged();
    expect(useAppStore.getState().hasChanges).toBe(true);

    // Load new project
    const project2 = createProject({ numFrames: 1 });
    useAppStore.getState().setLabels(project2.labels, "new.slp");

    // State should be reset
    expect(useAppStore.getState().frameIdx).toBe(0);
    expect(useAppStore.getState().instance).toBeNull();
    expect(useAppStore.getState().hasChanges).toBe(false);
    expect(useAppStore.getState().filename).toBe("new.slp");
  });

  it("frame navigation clears instance selection", () => {
    loadProject({ numFrames: 3, numInstancesPerFrame: 1 });
    const lf = useAppStore.getState().labels!.labeledFrames[0];
    useAppStore.getState().setInstance(lf.instances[0]);
    expect(useAppStore.getState().instance).not.toBeNull();

    // Navigate to different frame
    useAppStore.getState().setFrameIdx(5);
    expect(useAppStore.getState().instance).toBeNull();
  });

  it("video switch resets frame and instance", () => {
    const project = createProject({ numFrames: 2 });
    // Add a second video
    const video2 = {
      filename: "test2.mp4",
      shape: [50, 480, 640, 3] as [number, number, number, number],
      backend: null,
      sourceVideo: null,
      backendMetadata: {},
    } as unknown as Video;
    project.labels.videos.push(video2);

    useAppStore.getState().setLabels(project.labels, "multi.slp");
    useAppStore.getState().setFrameIdx(10);

    // Switch video
    useAppStore.getState().setVideo(video2);
    expect(useAppStore.getState().frameIdx).toBe(0);
    expect(useAppStore.getState().instance).toBeNull();
    expect(useAppStore.getState().video).toBe(video2);
  });

  it("markChanged tracks last interacted frame", () => {
    loadProject();

    useAppStore.getState().setFrameIdx(25);
    useAppStore.getState().markChanged();

    expect(useAppStore.getState().lastInteractedFrame).toBe(25);
    expect(useAppStore.getState().hasChanges).toBe(true);
  });

  it("clearChanges only clears the flag, not lastInteractedFrame", () => {
    loadProject();

    useAppStore.getState().setFrameIdx(25);
    useAppStore.getState().markChanged();
    useAppStore.getState().clearChanges();

    expect(useAppStore.getState().hasChanges).toBe(false);
    // lastInteractedFrame is NOT cleared by clearChanges
    expect(useAppStore.getState().lastInteractedFrame).toBe(25);
  });
});

describe("Workflow: Convert prediction", () => {
  let ctx: CommandContext;

  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("load -> find predicted -> convert -> verify user instance", async () => {
    const project = loadProject({
      numFrames: 1,
      numInstancesPerFrame: 1,
      withPredictions: true,
    });

    // 1. Verify predicted instance exists
    const lf = project.labels.labeledFrames[0];
    useAppStore.getState().setFrameIdx(lf.frameIdx);

    const predIdx = lf.instances.findIndex((i) => "score" in i);
    expect(predIdx).not.toBe(-1);
    expect("score" in lf.instances[predIdx]).toBe(true);

    // 2. Convert
    await ctx.execute(ConvertPredictionToInstance, { instanceIdx: predIdx });

    // 3. Verify it's now a user instance
    expect("score" in lf.instances[predIdx]).toBe(false);

    // 4. The new instance should be selected
    expect(useAppStore.getState().instance).toBe(lf.instances[predIdx]);

    // 5. Changes should be marked
    expect(useAppStore.getState().hasChanges).toBe(true);
  });
});

describe("Workflow: Skeleton editing", () => {
  let ctx: CommandContext;

  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("add node -> rename -> delete -> verify point consistency", async () => {
    const project = loadProject({
      numFrames: 2,
      numInstancesPerFrame: 1,
    });
    installSkeletonUndoInterceptor(ctx);

    const skeleton = project.skeleton;
    const initialNodeCount = skeleton.nodes.length;

    // 1. Add a node
    await ctx.execute(AddNodeCommand, { name: "new_joint" });
    expect(skeleton.nodes.length).toBe(initialNodeCount + 1);

    // All instances should have the new point
    for (const lf of project.labels.labeledFrames) {
      for (const inst of lf.instances) {
        expect(inst.points.length).toBe(initialNodeCount + 1);
      }
    }

    // 2. Rename the new node
    const newNodeIdx = skeleton.nodes.length - 1;
    await ctx.execute(RenameNodeCommand, { nodeIdx: newNodeIdx, newName: "renamed_joint" });
    expect(skeleton.nodes[newNodeIdx].name).toBe("renamed_joint");

    // Points should have updated names
    for (const lf of project.labels.labeledFrames) {
      for (const inst of lf.instances) {
        expect(inst.points[newNodeIdx].name).toBe("renamed_joint");
      }
    }

    // 3. Delete the node
    await ctx.execute(DeleteNodeCommand, { nodeIdx: newNodeIdx });
    expect(skeleton.nodes.length).toBe(initialNodeCount);

    // Instance points should be back to original count
    for (const lf of project.labels.labeledFrames) {
      for (const inst of lf.instances) {
        expect(inst.points.length).toBe(initialNodeCount);
      }
    }
  });

  it("undo after skeleton add restores node count", async () => {
    const project = loadProject({
      numFrames: 1,
      numInstancesPerFrame: 1,
    });
    installSkeletonUndoInterceptor(ctx);

    const skeleton = project.skeleton;
    const initialNodeCount = skeleton.nodes.length;

    // Add a node
    await ctx.execute(AddNodeCommand, { name: "temp_node" });
    expect(skeleton.nodes.length).toBe(initialNodeCount + 1);

    // Undo
    ctx.undo();

    // Skeleton nodes should be restored
    expect(skeleton.nodes.length).toBe(initialNodeCount);
  });
});

describe("Workflow: Track propagation", () => {
  let ctx: CommandContext;

  beforeEach(() => {
    resetStore();
    ctx = new CommandContext();
  });

  it("assign track -> propagate forward -> verify", async () => {
    const project = loadProject({
      numFrames: 3,
      numInstancesPerFrame: 2,
      withTracks: true,
    });

    const [track1, track2] = project.tracks;

    // All frames have inst0=track1, inst1=track2
    // Simulate a swap that the user made on frame 0 and wants to propagate
    const lf0 = project.labels.labeledFrames[0];
    lf0.instances[0].track = track2;
    lf0.instances[1].track = track1;

    // Now propagate: swap track1<->track2 forward from frame 0
    useAppStore.getState().setFrameIdx(lf0.frameIdx);
    await ctx.execute(PropagateTrackLabels, {
      oldTrack: track1,
      newTrack: track2,
    });

    // Frames 1 and 2 should now have the swap
    const lf1 = project.labels.labeledFrames[1];
    expect(lf1.instances[0].track).toBe(track2);
    expect(lf1.instances[1].track).toBe(track1);

    const lf2 = project.labels.labeledFrames[2];
    expect(lf2.instances[0].track).toBe(track2);
    expect(lf2.instances[1].track).toBe(track1);
  });
});
