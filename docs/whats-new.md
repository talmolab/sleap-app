# New in SLEAP App

Coming from the Qt GUI (SLEAP v1.5–1.6)? Your projects, skeletons, models and
keyboard habits carry over: SLEAP App opens the same `.slp` files and keeps the
same menus and shortcuts. This page lists what it adds that the Qt GUI doesn't
have.

## Highlights

<div class="grid cards" markdown>

-   ↩️ **[Undo and redo](guides/labeling.md#undo)**

    ---

    ++cmd+z++ / ++ctrl+z++ undoes any edit — node drags, deleted instances,
    track changes, skeleton edits, merges. The Qt GUI has no undo; here the
    **Labels** menu even names the step it will undo.

-   🔍 **[Magnifier](guides/view.md#zoom-and-pan)**

    ---

    A zoomed view of the area under the node you're dragging, so you can place
    it precisely without zooming the whole frame. It can also loop the
    neighboring frames, to see how the body part moves.

-   💾 **[Autosave and recovery](guides/saving.md#crash-recovery)**

    ---

    Unsaved work is drafted in the background. If the app or the computer
    stops, the next launch offers to restore it.

-   🖥️ **[Train on another computer](guides/remote-compute.md)**

    ---

    Pair a GPU machine with a one-line code, then train and predict on it from
    your laptop, and load the predictions straight back into your project.

-   🌐 **[Runs in your browser](reference/browser-vs-desktop.md)**

    ---

    Open [app.sleap.ai](https://app.sleap.ai) and label — nothing to install.
    Install the desktop app when you want local GPU training.

-   🧪 **[Label Quality Check](guides/label-qc.md)**

    ---

    Finds labeling mistakes for you — swapped left/right nodes, duplicates,
    out-of-order chains, outlier poses — and walks you through fixing them.

</div>

## Labeling

- **[Undo and redo](guides/labeling.md#undo)** across the whole editor.
- **[Magnifier When Moving Nodes](guides/view.md#zoom-and-pan)**, with
  **Play Neighboring Frames in Magnifier** to loop the frames around the
  current one inside it.
- **[Pose Opacity](guides/view.md#color)** — fade the pose to 75%, 50% or 25%
  to see the animal underneath.
- **[Labeling hints](guides/labeling.md#hints)** — tips on screen for common
  first-time mistakes, as you make them.
- **[Per-track colors](guides/tracks.md#renaming-and-recoloring)** — pick the
  color of any track yourself.

## Finding mistakes

SLEAP v1.5 added an anomaly score. [Label Quality Check](guides/label-qc.md)
goes further:

- **[Structural and geometric checks](guides/label-qc.md#what-it-checks)** —
  duplicate instances, left/right swaps, chains labeled out of order, one
  animal split into two instances.
- **[GMM score](guides/label-qc.md#the-gmm-score)** next to the anomaly score.
- **[Flags on the video](guides/label-qc.md#the-label-qc-panel)** and a side
  panel to step through them frame by frame.
- **[Review window](guides/label-qc.md#the-review-window)** — fix flagged
  instances one after another without leaving the list.
- **[Ignore a flag](guides/label-qc.md#ignoring-a-flag)** you've checked, so it
  stops coming back.

## Training and inference

- **[Train on another computer](guides/remote-compute.md)** — pair a GPU
  workstation or cluster node, browse its files, queue jobs, and pull results
  back. The Qt GUI could only export a training package to run by hand.
- **[Dry run](guides/training.md#checking-before-you-train-desktop)** — check
  a configuration in seconds before committing to a long run.
- **Auto [crop size](guides/training.md#key-ideas) and max stride** from your
  labeled animals, with GPU and cache memory estimates before you start.
- **[ONNX and TensorRT](guides/inference.md#exporting-a-model)** — export a
  trained model for faster inference, and run it from the Inference panel.

## Videos and saving

- **[Autosave and crash recovery](guides/saving.md#crash-recovery)** — unsaved
  work is drafted in the background and offered back after a crash.
- **[Check Frames](guides/videos.md#checking-a-videos-frames)** — find frames
  that won't decode or seek to the wrong place, and re-encode the video.
- **[Scrub proxies](reference/browser-vs-desktop.md)** (desktop) — smooth
  scrubbing through videos stored on a network drive.

## Getting started

- **[Runs in the browser](reference/browser-vs-desktop.md)** — at
  [app.sleap.ai](https://app.sleap.ai), with no install. The
  [desktop app](installation.md) adds local training and offline use.
- **[Interactive tutorial](tutorial/index.md)** — **Start Tutorial** walks you
  through labeling, training and proofreading on a sample video.
- **[One-click sample video](tutorial/new-project.md)** — **Use sample
  video** in New Project, to try things out without your own data.
- **[Search Menus](reference/menus.md#help)** — **Help ▸ Search Menus…** finds
  any command by name.
