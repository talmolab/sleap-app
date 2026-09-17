# Skeletons

A **skeleton** defines the parts you label. It is a set of **nodes** (body parts)
and **edges** (connections between them), shared by every instance in the
project. Everything downstream — training, the quality checks, the rendering —
is defined in terms of it.

## Starting from a template

**File ▸ New Project…** offers built-in skeletons:

| Template | Nodes |
|---|---|
| Fly | 32 |
| Mouse top-down | 12 |
| Human | 17 |
| *C. elegans* | 2 |
| Custom (empty) | — define it later |

Pick the closest one and edit it, or start empty.

## Drawing a skeleton on the frame

Often the fastest route, because you can see the animal while you do it:

1. Open the **Skeleton** panel and click **Draw skeleton on frame**.
2. **Click** to place each node where that body part sits.
3. **Drag a stroke through** the nodes you want connected — the stroke becomes
   edges along the path.
4. Click **Done**.

Nodes come out named `node_0`, `node_1`, … Double-click a name in the **Skeleton**
panel to rename it.

!!! tip "Rename before you label"

    Node names are how you'll read every quality-check finding, every metrics
    table, and every exported column. `head` / `torso` / `tailbase` beats
    `node_0` / `node_1` / `node_2` immediately and forever.

## Editing in the panel

The **Skeleton** panel lists nodes and edges with buttons to:

- **Add Node** / **Delete Node**
- **Add Edge** — pick a source and destination node
- **Add Symmetry** — declare a left/right pair
- **Delete Skeleton** — clear it and start again

## Symmetries

A **symmetry** marks two nodes as mirror images of each other — `left_ear` and
`right_ear`, `left_hind_paw` and `right_hind_paw`.

Declaring them is worth the thirty seconds: the
[Label Quality Check](label-qc.md) uses symmetries to detect **chirality
errors**, where an instance has left and right systematically swapped. That is
one of the most common labeling mistakes and one of the hardest to spot by eye.
If you haven't declared symmetries, the check falls back to inferring pairs from
node names containing left/right markers.

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

## How many nodes?

Fewer than you want. Every node is a point you must place on every instance on
every labeled frame, forever. Three to five well-chosen, reliably visible parts
get you a working model far faster than a 30-node rig you'll label sloppily.

For [top-down models](training.md) you also need one node that is central and
almost always visible, to serve as the **anchor part** the model crops around.
Design the skeleton so such a node exists.
