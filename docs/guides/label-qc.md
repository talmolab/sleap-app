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
  first, then everything else by its worst anomaly score (or in the order
  picked in the [Review window](#the-review-window)). Click a row to go there.
- The **card** below shows everything QC found on the frame you're on: definite
  errors in red, possible errors (chain order, chirality) in amber, and each
  flagged instance with its issue, the node to blame and its anomaly and GMM
  scores. Click an instance to select it.
- Press ++f++ for the next flagged frame and ++shift+f++ for the previous one,
  from anywhere in the app (also **Go ▸ Next Label QC Flag**). They select the
  worst flagged instance, zoom to it and open the panel.
- The **threshold** slider works as it does in the dialog.

On the video, each flagged instance gets a red dashed box, and on it the
thing that looks wrong, drawn in red dashes over a dark outline:

- an **edge** whose length is unusual (or two nodes unusually far apart or
  close together, or a likely L/R swapped pair): a dashed line between the two
  nodes;
- an unusual **joint angle** (or bend along the body): both arms of the angle
  dashed, with an arc at the joint between them;
- an isolated node, or the node the GMM blames: a dashed circle around it.

A few anomalies aren't about particular nodes (an unusual share of visible
nodes, bounding-box size, or distance to the nearest similar pose); those get
only the box. Going to a flag zooms to its instance, and while a flagged
instance is selected, the poses around it fade to 25% so it stands out from
animals overlapping it. All of this shows only while the Label QC panel or the
[Review window](#the-review-window) is open: close them to label without it.

When you edit a flagged frame, its row and card dim and say **Edited since the
run**: its flags may already be fixed. Click **Rerun** to re-check everything.

### The Review window

Click the blue **Review** button at the top of the panel (next to **Rerun**)
to go through the flags one at a time. The video area turns into a window
over the rest of the app, which dims, and zooms to the flagged instance on
each flag. It is the same video view as always, so you fix things the usual
way: drag a point to move it, ++v++ to hide a node, ++cmd+z++ to undo, scroll
to zoom.

- The **header** shows where you are (**Review 4 / 31**), the worst score on
  the frame (red when it is over the threshold, or **Error** for a definite
  error), how many flags the frame has, and the frame number.
- Under the video, the selected instance's issue and the node(s) it is about,
  e.g. *Unusual joint angle (decreased) · thorax*, with its **Anomaly** and
  **GMM** scores (red when over their thresholds) and any errors QC found on
  it.
- Each flag selects its instance and the node behind it: the joint of an
  unusual angle, the first node of an edge or pair, or the node QC blames. So
  you can drag it straight away, or press ++v++ to hide it.
- If that node isn't placed, a line above the issue says so (**wingL** isn't
  placed (click to place it)) and a click on the image places it (++cmd+z++
  undoes it). Only a click places it: dragging pans the view, and a press
  held longer than about a third of a second does nothing. (This now applies
  to placing nodes outside Review too.)
- ++left++ / ++right++ (or **‹ Prev** / **Next ›**) go to the previous / next
  flagged frame instead of the previous / next frame.
- ++0++ zooms back to the flagged instance.
- ++3++ (or **Ignore**) ignores the selected instance's flags and goes to the
  next one, as [below](#ignoring-a-flag).
- **Delete instance** deletes the selected instance, for a duplicate. ++cmd+z++
  brings it back.
- ++esc++, the **×** button, or a click on the dimmed area closes the window.

When you edit a flagged instance in the Review window (drag a node, place
one, ++v++, undo or redo), QC scores it again right away and the header, the
issue line and the panel's card show the new scores, tagged **re-scored**.
This scores it against the last run (what it learned from all your labels
then) and doesn't learn again, so it's an estimate: **Rerun** checks it
against all your labels. If the new scores no longer flag it, the issue line
says **Looks OK now** and its box on the video fades. It keeps its place in
the list until you **Rerun**, so ++left++ / ++right++ don't skip around.

The tabs at the top right choose the order of the flagged frames:

| Tab | Order |
|---|---|
| **Severity** | Definite errors first, then by the worst score (the panel's usual order) |
| **Detectors** | Frames where the most checks agree first: how many of the anomaly score, the GMM score and the rule checks flag the frame's worst instance. Ties go by the worst score |
| **Frame** | In frame order (by video, then frame) |

The order you pick also orders the panel's list and ++f++ / ++shift+f++.
Switching keeps you on the frame you're on.

### Ignoring a flag

Some flags are false alarms: an animal really was curled up, or two really
were touching. To ignore one, select the instance (++f++ already does) and
press ++3++, or click **Ignore** on its card. That hides every flag on
that instance (its anomaly and GMM flag and any error QC found on it) and
moves on: to the next flagged instance on the same frame, else to the next
flagged frame (also **Go ▸ Ignore Label QC Flag**). Flags on the frame as a
whole, such as an incomplete frame, can't be ignored this way.

Ignored instances leave the list, ++f++ / ++shift+f++ and the boxes on the
video, and a frame whose flags are all ignored leaves the list. The top of the
panel counts them (**12 flagged frames · 3 ignored**). Click the eye button
(**Show ignored**) to list them again, greyed with an **Ignored** tag (their
boxes on the video faded), and click **Undo** on one to flag it again.

Ignoring applies to that instance's pose as it is now. If you edit the pose
later, it no longer applies: the instance shows up flagged again until you
ignore it again or a **Rerun** no longer flags it.

Ignored flags are kept on this computer (in the desktop app) or in this browser (on
the web), per project: by the project's file path in the desktop app, by its
file name in the browser. They are not saved in the `.slp` file, so they don't
travel with it to another computer or to someone else, and in the browser
they're lost if you clear the site's data. They survive **Rerun** and
reopening the project.

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
