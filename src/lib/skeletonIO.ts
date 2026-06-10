/**
 * Pure, decode-light skeleton I/O core.
 *
 * The building blocks for the "Load Skeleton From File / Save As" feature
 * (#163), kept React-free and side-effect-free so they are fully unit-testable.
 * Only {@link parseSkeletonFile} touches the outside world, and only by calling
 * sleap-io.js decoders (no platform/file-system access of its own).
 *
 * Ports of the PyQt SLEAP `OpenSkeleton` command (`sleap/gui/commands.py`):
 *   - {@link compareSkeletons}   ← `OpenSkeleton.compare_skeletons` (`:3017`)
 *   - {@link remapInstancePoints}← the point side of `OpenSkeleton.do_action`
 */

import {
  loadSlp,
  readSkeletonJson,
  decodeYamlSkeleton,
  encodeYamlSkeleton,
} from "@talmolab/sleap-io.js";
import type { Skeleton, Instance, Node } from "@talmolab/sleap-io.js";

/**
 * Diff of node NAMES between the current ("old") and the imported ("new")
 * skeleton. Port of `OpenSkeleton.compare_skeletons`.
 */
export interface SkeletonDiff {
  /** Old names present in BOTH (kept; auto-linked to themselves). */
  renameNodes: string[];
  /** Old names NOT in new (would be deleted → points dropped). */
  deleteNodes: string[];
  /** New names NOT in old (would be added → empty points). */
  addNodes: string[];
}

/**
 * Three-way diff of node names between the current and the imported skeleton.
 *
 * Port of `OpenSkeleton.compare_skeletons` (`commands.py:3017`):
 *   - `deleteNodes = old \ new`
 *   - `addNodes    = new \ old`
 *   - `renameNodes = old ∩ new`  (the old names that survive — i.e. old minus
 *     deleteNodes)
 *
 * Order-preserving on the SOURCE arrays: `renameNodes`/`deleteNodes` follow
 * `oldNames` order, `addNodes` follows `newNames` order.
 */
export function compareSkeletons(
  oldNames: string[],
  newNames: string[],
): SkeletonDiff {
  const oldSet = new Set(oldNames);
  const newSet = new Set(newNames);

  const deleteNodes = oldNames.filter((name) => !newSet.has(name));
  const addNodes = newNames.filter((name) => !oldSet.has(name));
  const renameNodes = oldNames.filter((name) => newSet.has(name));

  return { renameNodes, deleteNodes, addNodes };
}

/** Coerce a `string | ArrayBuffer | Uint8Array` payload into an ArrayBuffer. */
function toArrayBuffer(data: string | ArrayBuffer | Uint8Array): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  if (data instanceof Uint8Array) {
    // Slice to the exact view so we never hand loadSlp a larger backing buffer.
    return data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer;
  }
  // string → UTF-8 bytes (only reached if a .slp was read as text, which is a
  // caller bug; supported defensively).
  return new TextEncoder().encode(data).buffer as ArrayBuffer;
}

/** Decode a `string | ArrayBuffer | Uint8Array` payload to text (UTF-8). */
function toText(data: string | ArrayBuffer | Uint8Array): string {
  if (typeof data === "string") return data;
  return new TextDecoder().decode(data);
}

/** Lower-cased file extension (without the dot), or "" if none. */
function extOf(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx >= 0 ? filename.slice(idx + 1).toLowerCase() : "";
}

/**
 * Parse a skeleton file into a {@link Skeleton}, dispatching on the file
 * extension:
 *   - `.json` → `readSkeletonJson(JSON.parse(text))` (jsonpickle SLEAP format;
 *     also accepts the `nx_graph` shape — `readSkeletonJson` handles it).
 *   - `.yaml` / `.yml` → `decodeYamlSkeleton(text)`, taking `[0]` if an array.
 *   - `.slp` → `await loadSlp(buf, { openVideos: false })`, taking
 *     `.skeletons[0]`.
 *
 * Async because of the `.slp` (HDF5) path. Throws a friendly `Error` on an
 * unknown extension or when no skeleton can be produced — the caller surfaces
 * the message as a toast.
 */
export async function parseSkeletonFile(
  filename: string,
  data: string | ArrayBuffer | Uint8Array,
): Promise<Skeleton> {
  const ext = extOf(filename);

  switch (ext) {
    case "json": {
      const json = JSON.parse(toText(data)) as Record<string, unknown>;
      const skeleton = readSkeletonJson(json);
      if (!skeleton) {
        throw new Error(`No skeleton found in "${filename}".`);
      }
      return skeleton;
    }

    case "yaml":
    case "yml": {
      const decoded = decodeYamlSkeleton(toText(data));
      const skeleton = Array.isArray(decoded) ? decoded[0] : decoded;
      if (!skeleton) {
        throw new Error(`No skeleton found in "${filename}".`);
      }
      return skeleton;
    }

    case "slp": {
      const labels = await loadSlp(toArrayBuffer(data), { openVideos: false });
      const skeleton = labels.skeletons[0];
      if (!skeleton) {
        throw new Error(`No skeleton found in "${filename}".`);
      }
      return skeleton;
    }

    default:
      throw new Error(
        `Unsupported skeleton file type ".${ext}". ` +
          `Use a .json, .yaml, .yml, or .slp file.`,
      );
  }
}

/**
 * Build the NEW point array for one instance under a node-name remap. Port of
 * the point side of `OpenSkeleton.do_action`.
 *
 * The instance's existing `points` are aligned to `oldNodes` (index by index).
 * For each NEW node, the source old point is chosen as:
 *   1. `linkMap.get(newName)` → that OLD node's point (explicit link / rename),
 *      else
 *   2. the OLD node with the SAME name (auto-match), else
 *   3. a fresh `{ xy:[NaN,NaN], visible:false, complete:false }` point (a truly
 *      added node).
 *
 * Cloned points preserve `xy` (deep-cloned), `visible`, `complete`, and any
 * `score`, with `name` set to the NEW node's name. The returned array always
 * has `newNodes.length` entries, in `newNodes` order.
 *
 * @param linkMap newName → oldName explicit links from the replace dialog.
 */
export function remapInstancePoints(
  instance: Instance,
  oldNodes: Node[],
  newNodes: Node[],
  linkMap: Map<string, string>,
): Instance["points"] {
  // Map old node NAME → its point (aligned by index to oldNodes).
  const oldByName = new Map<string, Instance["points"][number]>();
  for (let i = 0; i < oldNodes.length; i++) {
    const point = instance.points[i];
    if (point) {
      oldByName.set(oldNodes[i].name, point);
    }
  }

  return newNodes.map((newNode) => {
    const linked = linkMap.get(newNode.name);
    const srcName = linked ?? (oldByName.has(newNode.name) ? newNode.name : null);
    const src = srcName != null ? oldByName.get(srcName) : undefined;

    if (src) {
      return {
        ...src,
        xy: [src.xy[0], src.xy[1]] as [number, number],
        name: newNode.name,
      };
    }

    return {
      xy: [NaN, NaN] as [number, number],
      visible: false,
      complete: false,
      name: newNode.name,
    };
  });
}

/**
 * Serialize the current skeleton to YAML text (wrapper over
 * `encodeYamlSkeleton`). Round-trips through {@link parseSkeletonFile} with a
 * `.yaml` filename and through `decodeYamlSkeleton`.
 */
export function serializeSkeletonYaml(skeleton: Skeleton): string {
  return encodeYamlSkeleton(skeleton);
}
