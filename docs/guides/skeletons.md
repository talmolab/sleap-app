# Skeletons

A **skeleton** defines the parts you label. It is a set of **nodes** (body parts)
and **edges** (connections between them), shared by every instance in the
project. Everything downstream — training, the quality checks, the rendering —
is defined in terms of it.

## Starting from a template

**File ▸ New Project…** and the **Skeleton** panel's **Load template** offer the
skeletons legacy SLEAP ships, one per SLEAP reference dataset:

| Template | Nodes | Animals |
|---|---|---|
| Bees | 21 | Bumblebees in a petri dish |
| Flies 13 | 13 | Pairs of fruit flies |
| Fly | 32 | A single fruit fly, animal-centered |
| Gerbils | 14 | Gerbils in a home cage |
| Mice, home cage | 5 | Pairs of mice, from above |
| Mice, open field | 11 | Mice in an open field, from below |
| Empty — define later | none yet | |

Picking one in **Load template** previews it before anything changes: a labeled
example image, its nodes, and **Example**, which opens a larger frame from the
reference dataset with the skeleton drawn on each animal. **Load** applies it.

Pick the closest one and edit it, or start empty.

## Drawing a skeleton on the frame

Often the fastest route, because you can see the animal while you do it:

1. Open the **Skeleton** panel and click **Draw skeleton on frame**.
2. **1 · Place nodes** — **click** to place each node where that body part sits.
   Drag a placed node to move it, and double-click it to rename it.
3. Click **Next: Connect edges →**.
4. **2 · Connect edges** — **drag a stroke through** the nodes you want
   connected; the stroke becomes edges along the path. **Clear edges** starts
   the edges over, and **← Back** returns to placing nodes.
5. Click **Done**. The app asks whether to create an instance on this frame from
   your layout: **Create instance** or **Not now**.

Nodes come out named `node_0`, `node_1`, … Rename them on the frame while
placing, or later by double-clicking a name in the **Skeleton** panel.

If the project already has a skeleton, **Draw skeleton on frame** first asks
whether to **Edit existing** (add to it) or **Delete & start new**.

!!! tip "Rename before you label"

    Node names are how you'll read every quality-check finding, every metrics
    table, and every exported column. `head` / `torso` / `tailbase` beats
    `node_0` / `node_1` / `node_2` immediately and forever.

## Editing in the panel

The **Skeleton** panel has three tabs, each with its own buttons:

| Tab | Buttons |
|---|---|
| **Nodes** | **New Node**, **Delete Node**, **Delete Skeleton** (clear it and start again) |
| **Edges** | **New Edge** (pick a source and destination node), **Delete Edge** |
| **Symmetries** | **New Symmetry** (declare a left/right pair), **Delete Symmetry** |

## Symmetries

A **symmetry** marks two nodes as mirror images of each other — `left_ear` and
`right_ear`, `left_hind_paw` and `right_hind_paw`.

Declaring them is worth the thirty seconds: the
[Label Quality Check](label-qc.md) uses symmetries to detect **chirality
errors**, where an instance has left and right systematically swapped. That is
one of the most common labeling mistakes and one of the hardest to spot by eye.
If you haven't declared symmetries, the check falls back to inferring pairs from
node names that start or end with `left`/`right` or `L`/`R`, such as
`left_ear` or `ear_R`.

## Loading and saving skeletons

**Load From File…** in the Skeleton panel reads a skeleton out of:

- a `.slp` project
- a skeleton **JSON** file (the legacy SLEAP format)
- a skeleton **YAML** file

and **Save As** writes YAML. This is how you reuse one lab-standard skeleton
across many projects.

When you load a skeleton into a project that already has labels, the app compares
the two and remaps existing instance points onto the new node set by name, so
labels survive a skeleton swap wherever the names still line up.

## Designing a skeleton

A good skeleton makes labeling faster and models more accurate. Settle it before
you label much: every change later means revisiting labeled frames.

### Choose landmarks you can find every time

A node should sit on a spot you can place in the same place on every frame,
on every animal: the tip of the snout, the base of the tail, a joint. Avoid
vague spots like "middle of the back" unless you'll place them consistently. If
two people would put a node in different places, the model learns that
disagreement.

### How many nodes?

Fewer than you want. Every node is a point you must place on every instance on
every labeled frame, forever. Three to five well-chosen, reliably visible parts
get you a working model far faster than a 30-node rig you'll label sloppily.
Start small: you can add nodes later.

Adding a node later gives every existing instance an empty, non-visible point
for it, so you'll need to go back and place it on your labeled frames.

For [top-down models](training.md) you also need one node that is central and
almost always visible, to serve as the **anchor part** the model crops around.
Design the skeleton so such a node exists.

### Edges

What edges do depends on the model type:

- **Top-Down and Single Animal:** edges are for display. They make poses easier
  to read and help you spot mistakes, but the model doesn't use them.
- **Bottom-Up:** edges are how the model groups detected parts into animals, so
  every node must be connected. The Training panel disables Bottom-Up when the
  skeleton has no edges, and warns when it isn't fully connected.

For Bottom-Up, keep the tree **shallow**: connect parts to a central node rather
than in one long chain. Grouping follows the edges, so in a chain like
`head → neck → torso → hip → tail`, missing one node in the middle cuts off
everything after it.

### Name left and right consistently

Use one pattern for paired parts, such as `left_ear` / `right_ear` or
`ear_L` / `ear_R`, and declare them as [symmetries](#symmetries). Consistent
names keep exported columns readable and let the
[Label Quality Check](label-qc.md) find the pairs.

### Common mistakes

| Mistake | Why it hurts | Instead |
|---|---|---|
| Too many nodes | Slow labeling, and sloppy labels | Start with 3–5; add more once the model works |
| Landmarks you can't place consistently | The model learns your inconsistency | Pick sharp, visible features |
| No central, reliably visible node | Top-down crops have nothing stable to center on | Include a node like `torso` or `thorax` |
| Long chains of edges (Bottom-Up) | One missing node breaks the animal apart | Connect parts to a central node |
| Mixed left/right naming | Unreadable exports, and missed symmetry checks | One pattern, plus declared symmetries |
