/**
 * Pure, React-free helpers for the Skeleton panel's "Add Edge" dialog.
 *
 * These compute the auto-filled / auto-advanced source->destination selection
 * and the set of valid destinations for a given source, matching PyQt SLEAP's
 * reference behavior (`sleap/gui/dataviews.py:652 SkeletonNodeModel._valid_dst`):
 * for a given source, valid destinations exclude the source node itself AND any
 * node that is already a destination of that source.
 *
 * The module depends only on structural shapes (no sleap-io.js / React), so it
 * is trivially unit-testable and reusable. See GitHub issue #158.
 */

/** Minimal shape of a skeleton node. */
export interface NodeLike {
  name: string;
}

/** Minimal shape of a directed skeleton edge (source -> destination). */
export interface EdgeLike {
  source: { name: string };
  destination: { name: string };
}

/**
 * Stable key for a directed edge, used for O(1) duplicate/connected checks.
 *
 * Node names are arbitrary free text and may contain spaces (e.g. "left ear"),
 * so the separator must be a character that cannot appear in a name. We use the
 * ASCII Unit Separator (U+001F), a non-printable control character, to avoid
 * collisions like ("a b" -> "c") vs ("a" -> "b c") both keying to "a b c".
 */
const EDGE_KEY_SEP = "";
function edgeKey(srcName: string, dstName: string): string {
  return `${srcName}${EDGE_KEY_SEP}${dstName}`;
}

/**
 * Names of nodes that are valid destinations for `srcName`, in `nodes` order.
 *
 * Excludes `srcName` itself and any node `d` for which an edge
 * `srcName -> d` already exists. If `srcName` is empty/falsy, returns all node
 * names (no source chosen yet, so nothing to exclude).
 */
export function validDestinationNames(
  nodes: NodeLike[],
  srcName: string,
  edges: EdgeLike[],
): string[] {
  if (!srcName) {
    return nodes.map((n) => n.name);
  }
  const connected = new Set(
    edges.map((e) => edgeKey(e.source.name, e.destination.name)),
  );
  return nodes
    .map((n) => n.name)
    .filter(
      (name) => name !== srcName && !connected.has(edgeKey(srcName, name)),
    );
}

/**
 * First valid destination for `srcName`, or `""` when there is none.
 */
export function firstValidDestination(
  nodes: NodeLike[],
  srcName: string,
  edges: EdgeLike[],
): string {
  return validDestinationNames(nodes, srcName, edges)[0] ?? "";
}

/**
 * Initial source/destination selection when opening the Add Edge dialog.
 *
 * `src` is `preferredSrc` when it names a current node, else `nodes[0]`.
 * `dst` is the first valid destination for that source.
 */
export function initialEdgeSelection(
  nodes: NodeLike[],
  edges: EdgeLike[],
  preferredSrc?: string,
): { src: string; dst: string } {
  const isNode = (name: string | undefined): name is string =>
    !!name && nodes.some((n) => n.name === name);
  const src = isNode(preferredSrc) ? preferredSrc : (nodes[0]?.name ?? "");
  return { src, dst: firstValidDestination(nodes, src, edges) };
}

/**
 * Next source/destination selection after adding an edge, for rapid chaining.
 *
 * `src` advances to `justAddedDst` (the node we just connected to) when it is
 * still a node, else falls back to `nodes[0]`. `dst` is the first valid
 * destination for that source. The caller passes POST-add edges (the
 * just-added edge is already present in `edges`).
 */
export function nextEdgeSelection(
  nodes: NodeLike[],
  edges: EdgeLike[],
  justAddedDst: string,
): { src: string; dst: string } {
  const stillANode = nodes.some((n) => n.name === justAddedDst);
  const src = stillANode ? justAddedDst : (nodes[0]?.name ?? "");
  return { src, dst: firstValidDestination(nodes, src, edges) };
}

/**
 * Whether `srcName -> dstName` is a valid new edge: both name current nodes,
 * they differ, and the edge does not already exist.
 */
export function isValidEdgeSelection(
  nodes: NodeLike[],
  edges: EdgeLike[],
  srcName: string,
  dstName: string,
): boolean {
  if (!srcName || !dstName || srcName === dstName) {
    return false;
  }
  const names = new Set(nodes.map((n) => n.name));
  if (!names.has(srcName) || !names.has(dstName)) {
    return false;
  }
  const connected = new Set(
    edges.map((e) => edgeKey(e.source.name, e.destination.name)),
  );
  return !connected.has(edgeKey(srcName, dstName));
}
