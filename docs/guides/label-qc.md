# Label Quality Check

**Analyze ▸ Label Quality Check…**

Walks every labeled frame in the project and flags labels that are probably
wrong. Running it before a training run is a much better use of ten seconds than
almost anything else you could do with them — training on a systematically
mislabeled set teaches the model to be systematically wrong.

Each finding names the video, frame, and instance, and clicking it navigates
there.

## What it checks

### Structural checks

| Issue | What it means |
|---|---|
| **Duplicate** | Two instances on the same frame that are really the same animal — overlapping bounding boxes, or nodes sitting within a few pixels of each other |
| **Incomplete frame** | Fewer instances than the project's typical (median) count — an animal was probably missed |
| **Negative frame** | A frame marked as containing no animals that nevertheless has instances on it |
| **Sparse instance** | An instance with almost no visible nodes |
| **Empty instance** | An instance with no visible nodes at all |
| **Out of range** | Points outside the image bounds |

Duplicate detection also catches the **split duplicate** case: one animal labeled
as two instances with *disjoint* node sets — say head-and-torso in one instance,
torso-and-tail in another. Their boxes may barely overlap, so plain IoU misses
them; the check scores the combination of disjoint visible-node sets and body
contact instead.

### Geometric checks

These are the ones you cannot do by eye at scale.

**Chirality (L/R)** — a whole-instance left/right flip. This is invisible to
distance-based checks, because a mirrored pose has all the same node-to-node
distances. The check fits a body midline to each instance (the principal axis of
its points) and asks which side of it each symmetric pair's "left" member sits
on. It learns the canonical side from the majority of your instances, then flags
the ones that disagree.

!!! note "Declare your symmetries"

    This check needs to know which nodes are left/right pairs. Declare them as
    **symmetries** in the [skeleton](skeletons.md); failing that, the check
    infers pairs from node names containing left/right markers. No pairs, no
    chirality check.

**Chain order** — nodes along a chain (a limb, a spine, a tail) labeled out of
sequence. The check finds the longest chain in your skeleton and looks at the
turning angles along it; a correctly ordered chain turns smoothly, a
transposed one doubles back on itself.

## Working through the results

Results are a table of issue, frame, and details. Click a row to jump to it and
fix it.

**Add flagged frames to Suggestions** pushes every flagged frame into the
[Suggestions](suggestions.md) list, so you can work through them with ++space++
like any other labeling pass.

## When to run it

- **Before your first training run** — cheapest possible model improvement
- **After a [merge](merging.md)** — merges are the main source of duplicates
- **After a bulk import** — format conversions can put points out of range
- **Before publishing or sharing a dataset**

## Related

[Instance Size Distribution](instance-size.md) catches a different class of
problem: instances whose *size* is anomalous, which usually means a stray point
dragged far from the animal.
