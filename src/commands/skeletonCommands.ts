/**
 * Skeleton editing commands with undo/redo support.
 *
 * Each command snapshots the skeleton state (nodes, edges) and all instance
 * points before mutation so that undo restores the full skeleton + instance
 * data consistently.
 */

import { Node, Edge, Instance, Skeleton } from "@talmolab/sleap-io.js";
import { UpdateTopic } from "../types";
import type { Command } from "./types";
import type { CommandContext } from "./CommandContext";
import {
  SKELETON_TEMPLATES,
  type SkeletonTemplate,
} from "../lib/skeletonTemplates";
import { remapInstancePoints } from "../lib/skeletonIO";

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

/** Snapshot of skeleton + all instance points for undo. */
interface SkeletonSnapshot {
  /** The skeleton the command edited (nodes/edges are restored onto it). */
  skeleton: Skeleton | null;
  nodes: Node[];
  edges: Edge[];
  /** For each labeled frame, the points arrays for every instance. */
  instancePoints: {
    instance: Instance;
    /** The skeleton this instance belonged to at snapshot time. */
    skeleton: Skeleton;
    points: Instance["points"];
  }[];
}

/** Deep-clone a single point. */
function clonePoint(p: Instance["points"][0]): Instance["points"][0] {
  return {
    xy: [p.xy[0], p.xy[1]] as [number, number],
    visible: p.visible,
    complete: p.complete,
    // Preserve the per-point prediction score so it survives a skeleton-edit
    // undo/redo round-trip (predicted instances carry it; user points leave it
    // undefined). Without this, undoing a skeleton edit silently dropped scores.
    score: p.score,
    name: p.name,
  };
}

/** Take a snapshot of the current skeleton and all instance points. */
function takeSkeletonSnapshot(ctx: CommandContext): SkeletonSnapshot {
  const { labels, skeleton } = ctx.state;
  // Deep-clone the Node/Edge objects, not just the arrays. RenameNode mutates
  // a Node's `.name` IN PLACE, so a shallow `[...skeleton.nodes]` would share
  // that Node object with the live skeleton — the rename would corrupt the
  // "before" snapshot too, and undo couldn't restore the old name. Clone nodes
  // and rebuild edges against the clones so the snapshot is a true point-in-time
  // copy for structural AND in-place edits alike.
  const nodeClones = skeleton ? skeleton.nodes.map((n) => new Node(n.name)) : [];
  const nodeIndex = new Map<Node, number>();
  skeleton?.nodes.forEach((n, i) => nodeIndex.set(n, i));
  const cloneEndpoint = (n: Node): Node => {
    const i = nodeIndex.get(n);
    return i !== undefined ? nodeClones[i] : new Node(n.name);
  };
  const nodes = nodeClones;
  const edges = skeleton
    ? skeleton.edges.map((e) => new Edge(cloneEndpoint(e.source), cloneEndpoint(e.destination)))
    : [];

  const instancePoints: SkeletonSnapshot["instancePoints"] = [];
  if (labels) {
    for (const lf of labels.labeledFrames) {
      for (const inst of lf.instances) {
        instancePoints.push({
          instance: inst,
          skeleton: inst.skeleton,
          points: inst.points.map(clonePoint),
        });
      }
    }
  }

  return { skeleton: skeleton ?? null, nodes, edges, instancePoints };
}

/** Restore skeleton state from a snapshot. */
function restoreSkeletonSnapshot(
  ctx: CommandContext,
  snapshot: SkeletonSnapshot
) {
  const { labels } = ctx.state;
  const skeleton = snapshot.skeleton ?? ctx.state.skeleton;
  if (!skeleton) return;

  skeleton.nodes = snapshot.nodes;
  skeleton.edges = snapshot.edges;
  skeleton.rebuildCache(skeleton.nodes);

  // Restore instance points AND each instance's CAPTURED skeleton reference —
  // never the edited skeleton blindly, or a multi-skeleton project would have
  // instances of another skeleton reassigned to the edited one by an undo. The
  // snapshot's `instancePoints` is captured in
  // `labeledFrames` → `instances` iteration order; we re-walk the CURRENT live
  // instances in that same order and assign positionally. This matters because
  // the frame-level undo (run just before this, via the interceptor) replaces
  // `labels.labeledFrames` with fresh clones — the original `entry.instance`
  // refs are detached, so writing to them would leave the live clones holding
  // stale (post-mutation) points inconsistent with the restored skeleton.
  let restoredPositionally = false;
  if (labels) {
    const liveInstances: Instance[] = [];
    for (const lf of labels.labeledFrames) {
      for (const inst of lf.instances) liveInstances.push(inst);
    }
    if (liveInstances.length === snapshot.instancePoints.length) {
      for (let i = 0; i < liveInstances.length; i++) {
        liveInstances[i].points = snapshot.instancePoints[i].points.map(
          clonePoint
        );
        liveInstances[i].skeleton = snapshot.instancePoints[i].skeleton;
      }
      restoredPositionally = true;
    }
  }

  // Fallback: assign onto the captured instance refs (legacy behavior) when the
  // live layout doesn't line up positionally.
  if (!restoredPositionally) {
    for (const entry of snapshot.instancePoints) {
      entry.instance.points = entry.points.map(clonePoint);
      entry.instance.skeleton = entry.skeleton;
    }
  }

  ctx.state.markChanged();
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Add a node to the skeleton.
 *
 * Also adds a corresponding NaN point to every instance OF THIS skeleton so
 * that point arrays stay aligned with the skeleton node list. Instances of
 * other skeletons in a multi-skeleton project are untouched.
 *
 * Params: { name: string }
 */
export const AddNodeCommand: Command = {
  name: "AddNode",
  topics: [UpdateTopic.Skeleton, UpdateTopic.Frame],
  skipAutoSnapshot: true,
  execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const { labels, skeleton } = ctx.state;
    if (!skeleton) return;

    const name = params?.name as string | undefined;
    if (!name?.trim()) return;

    // Snapshot before mutation
    const before = takeSkeletonSnapshot(ctx);

    // Add the node
    const newNode = new Node(name.trim());
    skeleton.nodes.push(newNode);
    skeleton.rebuildCache(skeleton.nodes);

    // Add a NaN point to every instance of this skeleton
    if (labels) {
      for (const lf of labels.labeledFrames) {
        for (const inst of lf.instances) {
          if (inst.skeleton !== skeleton) continue;
          // Reassign, don't push: since sleap-io.js 0.5.x `inst.points` is a
          // columnar-backed snapshot array, so an in-place `.push()` is dropped.
          // Element writes go through proxies, but structural changes must set
          // `inst.points` to a fresh array.
          inst.points = [
            ...inst.points.map(clonePoint),
            {
              xy: [NaN, NaN] as [number, number],
              visible: false,
              complete: false,
              name: newNode.name,
            },
          ];
        }
      }
    }

    // Store before snapshot for manual undo
    const afterSnapshot = takeSkeletonSnapshot(ctx);
    storeSkeletonUndo(ctx, "AddNode", before, afterSnapshot);

    ctx.state.markChanged();
    // Node count changed: refresh skeleton-dependent UI (e.g. the Add Instance
    // affordances, which are gated on the skeleton having at least one node).
    ctx.state.bumpOverlayVersion();
  },
};

/**
 * Delete a node from the skeleton.
 *
 * Removes the node, any edges referencing it, and the corresponding point
 * from every instance of this skeleton.
 *
 * Params: { nodeIdx: number }
 */
export const DeleteNodeCommand: Command = {
  name: "DeleteNode",
  topics: [UpdateTopic.Skeleton, UpdateTopic.Frame],
  skipAutoSnapshot: true,
  execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const { labels, skeleton } = ctx.state;
    if (!skeleton) return;

    const nodeIdx = params?.nodeIdx as number | undefined;
    if (nodeIdx === undefined || nodeIdx < 0 || nodeIdx >= skeleton.nodes.length)
      return;

    const before = takeSkeletonSnapshot(ctx);

    const node = skeleton.nodes[nodeIdx];

    // Remove edges referencing this node
    skeleton.edges = skeleton.edges.filter(
      (e) => e.source !== node && e.destination !== node
    );

    // Remove the node
    skeleton.nodes.splice(nodeIdx, 1);
    skeleton.rebuildCache(skeleton.nodes);

    // Remove corresponding point from every instance of this skeleton
    if (labels) {
      for (const lf of labels.labeledFrames) {
        for (const inst of lf.instances) {
          if (inst.skeleton !== skeleton) continue;
          if (nodeIdx < inst.points.length) {
            // Reassign, don't splice in place: `inst.points` is a columnar
            // snapshot array since sleap-io.js 0.5.x (see AddNode).
            const kept = inst.points.map(clonePoint);
            kept.splice(nodeIdx, 1);
            inst.points = kept;
          }
        }
      }
    }

    const afterSnapshot = takeSkeletonSnapshot(ctx);
    storeSkeletonUndo(ctx, "DeleteNode", before, afterSnapshot);

    ctx.state.markChanged();
    // Node count changed: refresh skeleton-dependent UI (see AddNode).
    ctx.state.bumpOverlayVersion();
  },
};

/**
 * Add an edge between two nodes.
 *
 * Params: { srcName: string, dstName: string }
 */
export const AddEdgeCommand: Command = {
  name: "AddEdge",
  topics: [UpdateTopic.Skeleton],
  skipAutoSnapshot: true,
  execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const { skeleton } = ctx.state;
    if (!skeleton) return;

    const srcName = params?.srcName as string | undefined;
    const dstName = params?.dstName as string | undefined;
    if (!srcName || !dstName) return;

    const src = skeleton.nodes.find((n) => n.name === srcName);
    const dst = skeleton.nodes.find((n) => n.name === dstName);
    if (!src || !dst) return;

    const before = takeSkeletonSnapshot(ctx);

    skeleton.edges.push(new Edge(src, dst));

    const afterSnapshot = takeSkeletonSnapshot(ctx);
    storeSkeletonUndo(ctx, "AddEdge", before, afterSnapshot);

    ctx.state.markChanged();
  },
};

/**
 * Delete an edge from the skeleton.
 *
 * Params: { edgeIdx: number }
 */
export const DeleteEdgeCommand: Command = {
  name: "DeleteEdge",
  topics: [UpdateTopic.Skeleton],
  skipAutoSnapshot: true,
  execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const { skeleton } = ctx.state;
    if (!skeleton) return;

    const edgeIdx = params?.edgeIdx as number | undefined;
    if (edgeIdx === undefined || edgeIdx < 0 || edgeIdx >= skeleton.edges.length)
      return;

    const before = takeSkeletonSnapshot(ctx);

    skeleton.edges.splice(edgeIdx, 1);

    const afterSnapshot = takeSkeletonSnapshot(ctx);
    storeSkeletonUndo(ctx, "DeleteEdge", before, afterSnapshot);

    ctx.state.markChanged();
  },
};

/**
 * Rename a node in the skeleton.
 *
 * Also updates the name in the point arrays of this skeleton's instances.
 *
 * Params: { nodeIdx: number, newName: string }
 */
export const RenameNodeCommand: Command = {
  name: "RenameNode",
  topics: [UpdateTopic.Skeleton],
  skipAutoSnapshot: true,
  execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const { labels, skeleton } = ctx.state;
    if (!skeleton) return;

    const nodeIdx = params?.nodeIdx as number | undefined;
    const newName = params?.newName as string | undefined;
    if (
      nodeIdx === undefined ||
      nodeIdx < 0 ||
      nodeIdx >= skeleton.nodes.length
    )
      return;
    if (!newName?.trim()) return;

    const before = takeSkeletonSnapshot(ctx);

    const node = skeleton.nodes[nodeIdx];
    node.name = newName.trim();
    skeleton.rebuildCache(skeleton.nodes);

    // Update point names in all instances of this skeleton
    if (labels) {
      for (const lf of labels.labeledFrames) {
        for (const inst of lf.instances) {
          if (inst.skeleton !== skeleton) continue;
          if (nodeIdx < inst.points.length) {
            inst.points[nodeIdx].name = newName.trim();
          }
        }
      }
    }

    const afterSnapshot = takeSkeletonSnapshot(ctx);
    storeSkeletonUndo(ctx, "RenameNode", before, afterSnapshot);

    ctx.state.markChanged();
  },
};

/**
 * Load a skeleton template, replacing the current skeleton.
 *
 * Params: { templateId: string }
 */
export const LoadSkeletonTemplateCommand: Command = {
  name: "LoadSkeletonTemplate",
  topics: [UpdateTopic.Skeleton, UpdateTopic.Frame],
  skipAutoSnapshot: true,
  execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const { labels, skeleton } = ctx.state;
    if (!skeleton || !labels) return;

    const templateId = params?.templateId as string | undefined;
    if (!templateId) return;

    const template = SKELETON_TEMPLATES[templateId];
    if (!template) return;

    const before = takeSkeletonSnapshot(ctx);

    applyTemplate(skeleton, template, labels);

    const afterSnapshot = takeSkeletonSnapshot(ctx);
    storeSkeletonUndo(ctx, "LoadSkeletonTemplate", before, afterSnapshot);

    ctx.state.markChanged();
    // Node count changed: refresh skeleton-dependent UI (see AddNode).
    ctx.state.bumpOverlayVersion();
  },
};

/**
 * Import a parsed skeleton onto the project's single skeleton **in place**,
 * preserving instance points by node name (or by an explicit rename `linkMap`).
 *
 * Port of PyQt SLEAP `OpenSkeleton.do_action` (Cases 1 + 2): the existing
 * skeleton OBJECT is rebuilt (nodes/edges/symmetries replaced) — it is NOT
 * appended/replaced in `labels.skeletons`, so every reference stays valid and
 * the #99 multi-skeleton footgun is avoided. Each instance's points are remapped
 * via {@link remapInstancePoints}: matched/linked nodes keep their xy, brand-new
 * nodes get NaN points, and dropped nodes' points are discarded.
 *
 * Params:
 *   - `newSkeleton: Skeleton`  — the parsed skeleton to import.
 *   - `linkMap?: Map<string,string>` — newName → oldName explicit links (rename).
 */
export const OpenSkeletonCommand: Command = {
  name: "OpenSkeleton",
  topics: [UpdateTopic.Skeleton, UpdateTopic.Frame],
  skipAutoSnapshot: true,
  execute(ctx: CommandContext, params?: Record<string, unknown>) {
    const { labels, skeleton } = ctx.state;
    if (!skeleton || !labels) return;

    const newSkeleton = params?.newSkeleton as Skeleton | undefined;
    if (!newSkeleton) return;
    const linkMap =
      (params?.linkMap as Map<string, string> | undefined) ?? new Map();

    const before = takeSkeletonSnapshot(ctx);

    // Source nodes for the point remap (the pre-import layout).
    const oldNodes = [...skeleton.nodes];

    // Rebuild the skeleton in place: keep the SAME object so labels.skeletons[0]
    // stays valid (no append/replace).
    const newNodes = newSkeleton.nodes.map((n) => new Node(n.name));
    skeleton.nodes = newNodes;

    const byName = (nodes: Node[], name: string): Node => {
      const found = nodes.find((n) => n.name === name);
      // Imported edges always reference imported nodes by name, so this is
      // defined in practice; fall back to a fresh Node to stay total.
      return found ?? new Node(name);
    };

    skeleton.edges = newSkeleton.edges.map(
      (e) =>
        new Edge(
          byName(newNodes, e.source.name),
          byName(newNodes, e.destination.name),
        ),
    );

    // Rebuild the name/index cache before recreating symmetries by name —
    // addSymmetry() resolves node names against this cache.
    skeleton.rebuildCache(skeleton.nodes);

    // Symmetries (best-effort): recreate by name on the existing skeleton.
    // Templates have none, so this is usually a no-op. Mirrors the PyQt
    // `try_and_skip_if_error` pattern — never let a bad symmetry abort the import.
    skeleton.symmetries = [];
    for (const [leftName, rightName] of newSkeleton.symmetryNames) {
      try {
        skeleton.addSymmetry(leftName, rightName);
      } catch {
        // skip a symmetry that can't be recreated
      }
    }

    // Remap points for every instance of the imported-onto skeleton. Instances
    // of other skeletons in a multi-skeleton project keep their own skeleton and
    // points untouched. The skeleton object is rebuilt in place,
    // so `inst.skeleton` refs are already correct — no reassignment needed.
    for (const lf of labels.labeledFrames) {
      for (const inst of lf.instances) {
        if (inst.skeleton !== skeleton) continue;
        inst.points = remapInstancePoints(inst, oldNodes, newNodes, linkMap);
      }
    }

    const after = takeSkeletonSnapshot(ctx);
    storeSkeletonUndo(ctx, "OpenSkeleton", before, after);

    ctx.state.markChanged();
    // Node count changed: refresh skeleton-dependent UI (see AddNode).
    ctx.state.bumpOverlayVersion();
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Apply a template to the skeleton, rebuilding nodes/edges and instance points. */
function applyTemplate(
  skeleton: Skeleton,
  template: SkeletonTemplate,
  labels: { labeledFrames: { instances: Instance[] }[] }
) {
  // Create new nodes
  const newNodes = template.nodes.map((name) => new Node(name));
  skeleton.nodes = newNodes;

  // Create new edges
  skeleton.edges = template.edges.map(
    ([srcIdx, dstIdx]) => new Edge(newNodes[srcIdx], newNodes[dstIdx])
  );

  skeleton.rebuildCache(skeleton.nodes);

  // Reset points to match the new node count — only for instances of the
  // replaced skeleton; other skeletons' instances in a multi-skeleton project
  // keep their points and skeleton reference.
  for (const lf of labels.labeledFrames) {
    for (const inst of lf.instances) {
      if (inst.skeleton !== skeleton) continue;
      inst.points = newNodes.map((node) => ({
        xy: [NaN, NaN] as [number, number],
        visible: false,
        complete: false,
        name: node.name,
      }));
    }
  }
}

/**
 * Store a skeleton-aware undo entry.
 *
 * The standard CommandContext undo system only snapshots instance data per frame.
 * Skeleton mutations need custom undo that restores both skeleton state and
 * all instance points.
 */
function storeSkeletonUndo(
  ctx: CommandContext,
  commandName: string,
  before: SkeletonSnapshot,
  _after: SkeletonSnapshot
) {
  // We create a custom undo snapshot that, when restored, will also
  // restore the skeleton state. We piggyback on the allFrames snapshot
  // mechanism and add skeleton restoration via a monkey-patched approach.
  //
  // Since CommandContext.restoreSnapshot doesn't know about skeleton,
  // we use pushUndoSnapshot with a special snapshot and override the
  // restore by storing the before state in a WeakMap.
  const snapshot = ctx.takeAllFramesSnapshot(commandName);

  // Store skeleton state in the snapshot via the tracks field (hacky but works
  // without modifying CommandContext). We'll restore skeleton on undo by
  // registering a one-time listener.
  //
  // Better approach: store the before skeleton snapshot and register a
  // listener that runs on next undo to also restore skeleton.

  // Store in module-level map
  skeletonUndoMap.set(snapshot, before);

  ctx.pushUndoSnapshot(snapshot);

  // Register a one-time update listener that intercepts undo
  const unsub = ctx.onUpdate(() => {
    // This fires on any command execution; we need to check if it's an undo
    // that matches our snapshot. Since we can't directly detect that, we
    // instead just always restore skeleton state when undo happens.
    // This is handled by the SkeletonPanel via the onUpdate mechanism.
  });

  // Clean up listener after a short delay — it's only needed for the immediate
  // next undo operation
  setTimeout(() => unsub(), 0);
}

/**
 * Map from undo snapshots to their corresponding skeleton state.
 * Used by the skeleton undo interceptor.
 */
const skeletonUndoMap = new WeakMap<object, SkeletonSnapshot>();

/**
 * Install a skeleton-aware undo/redo interceptor on the CommandContext.
 *
 * This wraps the undo() and redo() methods to also restore skeleton state
 * when skeleton-related commands are undone/redone.
 */
export function installSkeletonUndoInterceptor(ctx: CommandContext): void {
  const originalUndo = ctx.undo.bind(ctx);
  const originalRedo = ctx.redo.bind(ctx);

  // Access the undo/redo stacks via the command context
  // We need to peek at the top of the stack before undo/redo pops it
  ctx.undo = function (): boolean {
    // Peek at the top of the undo stack
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const undoStack = (ctx as any).undoStack as any[];
    if (!undoStack || undoStack.length === 0) return false;

    const topSnapshot = undoStack[undoStack.length - 1];
    const skeletonBefore = skeletonUndoMap.get(topSnapshot);

    // Take current skeleton snapshot for redo
    let currentSkelSnapshot: SkeletonSnapshot | undefined;
    if (skeletonBefore) {
      currentSkelSnapshot = takeSkeletonSnapshot(ctx);
    }

    const result = originalUndo();

    if (result && skeletonBefore) {
      restoreSkeletonSnapshot(ctx, skeletonBefore);

      // Store current state for redo
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const redoStack = (ctx as any).redoStack as any[];
      if (redoStack && redoStack.length > 0 && currentSkelSnapshot) {
        const redoTop = redoStack[redoStack.length - 1];
        skeletonUndoMap.set(redoTop, currentSkelSnapshot);
      }
    }

    return result;
  };

  ctx.redo = function (): boolean {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const redoStack = (ctx as any).redoStack as any[];
    if (!redoStack || redoStack.length === 0) return false;

    const topSnapshot = redoStack[redoStack.length - 1];
    const skeletonBefore = skeletonUndoMap.get(topSnapshot);

    let currentSkelSnapshot: SkeletonSnapshot | undefined;
    if (skeletonBefore) {
      currentSkelSnapshot = takeSkeletonSnapshot(ctx);
    }

    const result = originalRedo();

    if (result && skeletonBefore) {
      restoreSkeletonSnapshot(ctx, skeletonBefore);

      // Store current state for undo
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const undoStack = (ctx as any).undoStack as any[];
      if (undoStack && undoStack.length > 0 && currentSkelSnapshot) {
        const undoTop = undoStack[undoStack.length - 1];
        skeletonUndoMap.set(undoTop, currentSkelSnapshot);
      }
    }

    return result;
  };
}
