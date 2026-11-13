# Label Quality Check

**Analyze ▸ Label Quality Check…**

Checks every labeled frame in the project and flags labels that are probably
wrong. Running it before a training run is a much better use of ten seconds than
almost anything else you could do with them — training on a systematically
mislabeled set teaches the model to be systematically wrong.

Nothing runs when the dialog opens. Click **Run QC** to run both kinds of check
at once, then look at the results on the dialog's two tabs:

- **Rules** — the rule-based checks below.
- **Anomalies** — a statistical score per instance.

Click any result row to jump to that frame and instance. After you fix things,
click **Re-run** to check again. To review the results frame by frame instead,
use the [Label QC panel](#the-label-qc-panel).

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
    infers pairs from node names that start or end with `left`/`right` or
    `L`/`R`, such as `left_ear` or `ear_R`. No pairs, no chirality check.

**Chain order** — nodes along a chain (a limb, a spine, a tail) labeled out of
sequence. The check looks at the turning angles along each chain of four or
more nodes in your skeleton; a correctly ordered chain turns smoothly, a
transposed one doubles back on itself. A chain here is a run of nodes with no
side branches, such as a tail. A skeleton where everything hangs off one hub,
such as a fly's (legs, wings and head all attached to the thorax), has none,
so the check doesn't run on it.

Chain order and chirality are heuristics: an unusual but correct pose can
trip them. The Label QC panel lists them as **possible** errors and doesn't
put them ahead of the anomaly flags.

## Working through the results

On the **Rules** tab, results are a table of **Issue**, **Frame**, and
**Details**. Click a row to jump to it and fix it.

**Add flagged frames to Suggestions** pushes every flagged frame into the
[Suggestions](suggestions.md) list, so you can work through them with ++space++
like any other labeling pass.

## The Label QC panel

The **Label QC** panel in the right sidebar (the shield icon) is for working
through the flags one frame at a time. It shares its results with the dialog:
a run started in either shows up in both.

- **Run QC** runs both kinds of check, as in the dialog.
- The **list** at the top has one row per flagged frame. Frames with a definite
  error (a duplicate, a point outside the image, an empty instance…) come
  first, then everything else by its worst anomaly score. Click a row to go
  there.
- The **card** below shows everything QC found on the frame you're on: definite
  errors in red, possible errors (chain order, chirality) in amber, and each
  flagged instance with its issue, the node to blame and its anomaly and GMM
  scores. Click an instance to select it.
- Press ++f++ for the next flagged frame and ++shift+f++ for the previous one,
  from anywhere in the app (also **Go ▸ Next Label QC Flag**). They select the
  worst flagged instance, zoom to it and open the panel.
- The **threshold** slider works as it does in the dialog.

On the video, each flagged instance gets a red dashed box, and the nodes behind
its flag get red dashed circles: an edge's two ends, a joint and the two nodes
on either side of it, an isolated node, or the node the GMM blames. A few
anomalies aren't about particular nodes (an unusual share of visible nodes,
bounding-box size, or distance to the nearest similar pose); those get only
the box. Going to a flag zooms to its instance, and while a flagged instance
is selected, the poses around it fade to 25% so it stands out from animals
overlapping it. All of this shows only while the Label QC panel is open: close
the panel to label without it.

When you edit a flagged frame, its row and card dim and say **Edited since the
run**: its flags may already be fixed. Click **Rerun** to re-check everything.

## Anomalies

The **Anomalies** tab scores every instance by how unusual its pose is compared
with the rest of your labels — an unusual joint angle, edge length, or
visibility pattern, a likely L/R swap, and the like.
Click **Run QC**; on a large project it shows progress and a **Cancel**
button.

- The table lists **Score**, **GMM**, **Confidence**, **Top issue**, and
  **Frame**, worst first. An instance is listed if either score flags it.
- The **Threshold** slider sets the **Score** at which an instance is flagged.
  Lower it to flag more. The **GMM** column has its own fixed threshold (below).
- **Export CSV** saves both scores for every instance, not just the flagged
  ones.

### How the score works

The check learns what a normal pose looks like from your own labels, then
measures how far each labeled instance is from normal. Predictions aren't
scored.

1. For every instance it measures 18 things about the pose: edge lengths,
   joint angles, distances between nodes, overall size, how curved and compact
   the pose is, how symmetric the left/right pairs are, which nodes are visible,
   and how close it is to its most similar instance.
2. For each measurement, it works out how many standard deviations the
   instance is from the project's typical value.
3. The **score** comes from the most unusual of those measurements, scaled to
   between 0 and 1. A measurement 3 standard deviations out scores 0.5, and the
   default **threshold** of 0.7 flags instances about 4 standard deviations
   out.
4. **Top issue** names that most unusual measurement, such as *Unusual joint
   angle* or *Likely L/R swap*.

**Confidence** is read off the score: **high** above 0.8, **medium** above 0.5,
**low** otherwise.

### The GMM score

The **Score** looks at each measurement on its own, so it misses a pose whose
measurements are each normal but whose *combination* is rare, such as one leg
tucked in while the others are spread. The **GMM** column catches those.

1. It treats each instance's 18 measurements as one point and groups your
   labels into a few clusters of typical poses (up to 5).
2. It scores each instance by how far it falls from every cluster: the **GMM**
   score is the share of your labels that look more typical than this one.
3. Instances in the least typical 5% (GMM score 0.95 or more) are flagged,
   whatever the **Threshold** slider says. Their **Top issue** reads
   *Improbable pose*, followed by the measurement that stands out most.

The GMM needs at least 50 labeled instances; with fewer, the column shows a
dash and only the **Score** is used. Because it always flags about 5% of your
labels, treat its flags as poses worth a look, not as likely mistakes. The same
labels always give the same GMM scores, but after you add or fix labels the
borderline ones can change.

!!! tip "Reading the results"

    - **A flag isn't always a mistake.** Unusual poses score high too, so look
      before you change anything.
    - **Look for patterns.** If one **Top issue** keeps coming up, the problem
      may be a labeling habit rather than single mistakes.
    - **It works best with consistent labeling.** The check compares your
      labels with each other.
    - **Re-run it after you fix things**, and after proofreading, to confirm
      the fixes.

## When to run it

- **Before your first training run** — cheapest possible model improvement
- **After a [merge](merging.md)** — merges are the main source of duplicates
- **After a bulk import** — format conversions can put points out of range
- **Before publishing or sharing a dataset**

## Related

[Instance Size Distribution](instance-size.md) catches a different class of
problem: instances whose *size* is anomalous, which usually means a stray point
dragged far from the animal.
