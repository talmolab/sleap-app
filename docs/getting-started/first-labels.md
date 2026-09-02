# Your First Labels

This walks the full loop that most SLEAP projects run: label a handful of frames,
train a small model, correct what it gets wrong, and retrain. It mirrors the
app's built-in **Start Tutorial**, which highlights each control as you go — read
this first if you'd like to know *why* each step is there.

!!! tip "The fastest first pass is smaller than you think"

    You do not need 200 labeled frames before your first training run. Label
    **one frame completely**, train for a handful of epochs, and look at what
    comes out. A model that is bad in an informative way tells you more about
    your skeleton and crop size than another hour of labeling does.

---

## 1. Create the project

**File ▸ New Project…**, then add your video. In the browser you drag it in or
click to browse; on the desktop you get a native file picker.

Save immediately (++cmd+s++ / ++ctrl+s++) so the project has a `.slp` file to
write into.

---

## 2. Define a skeleton

A skeleton is the set of body parts (**nodes**) and the connections between them
(**edges**) that every instance in the project shares.

Either pick a template in the New Project dialog, or build one on the frame:

1. Open the **Skeleton** panel and click **Draw skeleton on frame**.
2. Click to place each node on the animal.
3. Drag a stroke through the nodes to connect them into edges.
4. Click **Done**.

Nodes start out named `node_0`, `node_1`, … — double-click a name in the
**Skeleton** panel to rename them to something meaningful (`head`, `torso`,
`tailbase`).

!!! note "Symmetric parts"

    Declare left/right pairs as **symmetries** in the skeleton. The app uses them
    for the chirality check in [Label Quality Check](../guides/label-qc.md), which
    catches left/right swaps you would otherwise never notice.

Three or four well-chosen nodes are plenty to start. See
[Skeletons](../guides/skeletons.md).

---

## 3. Generate suggestions

Open the **Suggestions** panel, leave the method on **Stride** with 20 per video,
and click **Generate**. You now have 20 frames spread across the video instead of
20 nearly identical neighbors.

Move between them with ++space++ and ++shift+space++.

---

## 4. Label

On each suggested frame, place one instance per animal and drag every visible
node into place.

- **Add instance** — ++cmd+i++ / ++ctrl+i++, or right-click ▸ **Add Instance**
- **Clone an existing instance** — ++cmd++-drag it
- **Delete** — ++cmd+backspace++ / ++ctrl+backspace++
- **Don't guess occluded parts** — mark them non-visible instead

**Labels ▸ Instance Placement Method** controls where a new instance starts out:

| Method | Starting pose |
|---|---|
| **Best** | Centered template, offset to avoid overlapping existing instances *(default)* |
| **Template** | The skeleton's stored template pose, unmodified |
| **Force Directed** | Centered, then pushed away from existing instances iteratively |
| **Random** | Random positions |
| **Copy Prior Frame** | The same instance's pose on the previous labeled frame |
| **Copy Predictions** | The prediction already on this frame |

Once a model exists, **Copy Prior Frame** and **Copy Predictions** turn labeling
into nudging rather than placing.

Save when you're done with a frame.

---

## 5. Check your labels before training

Before you spend GPU time, run **Analyze ▸ Label Quality Check**. It flags:

- duplicate instances stacked on the same animal
- frames with fewer instances than the project's typical count
- instances with almost no visible nodes
- points outside the image
- **left/right swaps**, inferred from your skeleton's symmetries
- **chain-order** problems, where a limb or body axis is labeled out of order

Each finding jumps you to the frame and instance. Fixing these is much cheaper
than training on them.

Also run **Analyze ▸ Instance Size Distribution** — it tells you how large your
animals actually are in pixels, which is what you need to choose a sensible crop
size for a top-down model.

---

## 6. Train

Open the **Training** panel.

1. Make sure the Python backend is available — see
   [Environment Setup](../guides/environment.md), or connect to a
   [remote worker](../guides/remote-compute.md) if you have no local GPU.
2. Pick a model type. **Top-Down** is a good default for multiple animals: it
   finds an anchor part, crops around it, and predicts the rest of the pose
   inside the crop.
3. Set the **Anchor Part** to a central, reliably visible node (`torso`, not
   `tail_tip`).
4. Set **Epochs** low — 5 is enough for a first end-to-end pass.
5. Click **Start Training**.

While it runs, open the loss viewer to watch curves live, or the log terminal for
raw output. See [Training](../guides/training.md).

---

## 7. Correct the predictions

When training finishes, predictions appear on the frames it ran on.

- **Double-click** a predicted instance to accept it as a user label
- ++cmd+shift+a++ / ++ctrl+shift+a++ accepts **all** predictions on the frame
- Drag any points that are off

Correcting predictions is far faster than labeling from scratch, which is the
whole point of the loop.

---

## 8. Retrain

Back in the **Training** panel, click **Train Again**. This time:

- raise **Epochs** to something real (200 is a reasonable starting point)
- keep the same anchor part
- set **Post-Training Inference Target** *before* you start — the field is
  disabled once training is running

Repeat until predictions stop needing corrections. Then run
[inference](../guides/inference.md) across the whole video and move on to
[tracking](../guides/tracks.md).

---

## Where to go next

<div class="grid cards" markdown>

-   👥 **Tracks**

    ---

    Assign identities across frames, transpose swaps, propagate labels.

    [:octicons-arrow-right-24: Tracks](../guides/tracks.md)

-   📤 **Export**

    ---

    Analysis HDF5/CSV, NWB, labeled clips, and labels packages.

    [:octicons-arrow-right-24: Import & Export](../guides/import-export.md)

</div>
