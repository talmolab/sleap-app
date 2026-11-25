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
  readSkeletonJson,
  writeSkeletonJson,
  decodeYamlSkeleton,
  encodeYamlSkeleton,
  StreamingH5File,
} from "@talmolab/sleap-io.js";
import { loadSlp } from "@/lib/slpRead";
import type { Skeleton, Instance, Node } from "@talmolab/sleap-io.js";
import { distinctSkeletonCount } from "./skeletonStructure";

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

/**
 * PyQt's `OpenSkeleton.load_skeleton` unwrapping: a SLEAP skeleton template
 * (`sleap/skeletons/*.json`) wraps the graph as `{"nx_graph": ..., ...}`, and a
 * saved skeleton file may be a one-skeleton list. Returns the bare graph.
 */
export function unwrapSkeletonJson(parsed: unknown): Record<string, unknown> | null {
  const one = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!one || typeof one !== "object") return null;
  const obj = one as Record<string, unknown>;
  const graph = "nx_graph" in obj ? obj.nx_graph : obj;
  return graph && typeof graph === "object" ? (graph as Record<string, unknown>) : null;
}

/**
 * Skeletons from a legacy SLEAP HDF5 skeleton file: `Skeleton.save_hdf5`
 * (SLEAP 1.x `sleap/skeleton.py`) writes each skeleton as a JSON-string
 * attribute, named after the skeleton, on a `/skeleton` group. The first one
 * is used, as PyQt's `OpenSkeleton.load_skeleton` takes `skel[0]` of a list.
 */
export function skeletonFromHdf5Attrs(
  attrs: Record<string, unknown> | null,
  filename: string,
): Skeleton {
  for (const attr of Object.values(attrs ?? {})) {
    // The HDF5 reader hands back each attribute as a `{ value }` wrapper.
    const value =
      attr && typeof attr === "object" && "value" in attr
        ? (attr as { value: unknown }).value
        : attr;
    const text =
      typeof value === "string"
        ? value
        : value instanceof Uint8Array
          ? new TextDecoder().decode(value)
          : null;
    if (!text) continue;
    const graph = unwrapSkeletonJson(JSON.parse(text));
    if (graph) return readSkeletonJson(graph);
  }
  throw new Error(`No skeleton found in "${filename}".`);
}

/** Same-origin h5wasm (see hdf5VideoSource.ts for why). */
const H5WASM_URL =
  typeof location !== "undefined"
    ? `${location.origin}/h5wasm/h5wasm.js`
    : undefined;

/** Read the `/skeleton` group's attributes from HDF5 bytes (null if absent). */
async function readHdf5SkeletonAttrs(
  bytes: Uint8Array,
  filename: string,
): Promise<Record<string, unknown> | null> {
  const h5 = new StreamingH5File();
  await h5.openBuffer(bytes, { h5wasmUrl: H5WASM_URL, filenameHint: filename });
  try {
    if (!h5.keys().includes("skeleton")) return null;
    return await h5.getAttrs("skeleton");
  } finally {
    await h5.close().catch(() => {});
  }
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
 *   - `.h5` / `.hdf5` → a legacy SLEAP HDF5 skeleton file
 *     ({@link skeletonFromHdf5Attrs}); PyQt's "HDF5 skeleton (*.h5 *.hdf5)".
 *
 * Async because of the `.slp` (HDF5) path. Throws a friendly `Error` on an
 * unknown extension or when no skeleton can be produced — the caller surfaces
 * the message as a toast.
 */
export async function parseSkeletonFile(
  filename: string,
  data: string | ArrayBuffer | Uint8Array,
  readHdf5Attrs: (
    bytes: Uint8Array,
    filename: string,
  ) => Promise<Record<string, unknown> | null> = readHdf5SkeletonAttrs,
): Promise<Skeleton> {
  const ext = extOf(filename);

  switch (ext) {
    case "json": {
      // PyQt saves a one-skeleton LIST (`save_skeleton([skel], ...)`) and
      // reads `skel[0]` back; templates wrap the graph in `nx_graph`.
      const json = unwrapSkeletonJson(JSON.parse(toText(data)));
      const skeleton = json ? readSkeletonJson(json) : null;
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
      // filenameHint names the file in a read error (e.g. a refused SLP
      // format), which would otherwise say "slp-data.slp".
      const labels = await loadSlp(toArrayBuffer(data), {
        openVideos: false,
        h5: { filenameHint: filename },
      });
      // A project file with several different skeletons: don't guess which one
      // is meant. Identical duplicates (old files) are one skeleton: use [0].
      const distinct = distinctSkeletonCount(labels);
      if (distinct > 1) {
        throw new Error(
          `"${filename}" has ${distinct} skeletons. ` +
            `Loading one skeleton from a file with several isn't supported yet.`,
        );
      }
      const skeleton = labels.skeletons[0];
      if (!skeleton) {
        throw new Error(`No skeleton found in "${filename}".`);
      }
      return skeleton;
    }

    case "h5":
    case "hdf5": {
      const attrs = await readHdf5Attrs(
        new Uint8Array(toArrayBuffer(data)),
        filename,
      );
      return skeletonFromHdf5Attrs(attrs, filename);
    }

    default:
      throw new Error(
        `Unsupported skeleton file type ".${ext}". ` +
          `Use a .json, .yaml, .yml, .slp, .h5 or .hdf5 file.`,
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
      // Copy each field explicitly — do NOT spread `src`. Since sleap-io.js
      // 0.5.x, `instance.points[i]` is a columnar proxy whose xy/visible/
      // complete/score are prototype getters, so `{ ...src }` (own-enumerable
      // only) silently drops them all. Mirrors `clonePoints` in editCommands.
      return {
        xy: [src.xy[0], src.xy[1]] as [number, number],
        visible: src.visible,
        complete: src.complete,
        score: src.score,
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

/**
 * Serialize the skeleton to SLEAP's JSON skeleton format, as PyQt's Save As
 * writes it: `save_skeleton([skeleton], filename)` — a one-element list.
 */
export function serializeSkeletonJson(skeleton: Skeleton): string {
  return writeSkeletonJson([skeleton]);
}
