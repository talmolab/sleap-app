# Quick Start

Get from nothing to a labeled frame in about five minutes.

!!! tip "There is a guided tutorial built into the app"

    Click **Start Tutorial** in the menu bar and the app walks you through the
    entire workflow — new project, video, skeleton, suggestions, labeling,
    training, correcting predictions, retraining, and inference — highlighting
    the exact control to click at each step. It downloads a small sample video
    (`mice.mp4`) for you. If you would rather be shown than read, start there.

---

## 1. Open the app

=== "Browser"

    Go to [app.sleap.ai](https://app.sleap.ai). Nothing to install.

=== "Desktop"

    Launch **SLEAP** after [installing](../installation.md) it.

---

## 2. Open a project — or start one

If you already have a `.slp` file, **drag it onto the window**, or use
**File ▸ Open Project…** (++cmd+o++ / ++ctrl+o++).

`.pkg.slp` files with embedded videos work too, and open with no further setup —
the frames come out of the file itself.

To start fresh, use **File ▸ New Project…** (++cmd+n++ / ++ctrl+n++). You pick a
skeleton — one of the built-in templates (fly, mouse top-down, human,
*C. elegans*) or an empty one you define later — and add one or more videos.

!!! note "Where projects live"

    In the **desktop app**, projects are ordinary files on disk and **Save**
    writes back in place. In the **browser**, opening a file gives the page a
    copy; **Save** writes back through the browser's file-system access, and
    **Save As** downloads. See [Saving & Recovery](../guides/saving.md).

---

## 3. Move around the video

| Action | Shortcut |
|---|---|
| Next / previous frame | ++right++ / ++left++ |
| Jump 10 frames | ++cmd+right++ / ++cmd+left++ |
| Jump 100 frames | ++cmd+shift+right++ / ++cmd+shift+left++ |
| Next / previous **labeled** frame | ++alt+right++ / ++alt+left++ |
| Next / previous **suggestion** | ++space++ / ++shift+space++ |
| Go to frame… | ++cmd+j++ / ++ctrl+j++ |
| First / last frame | ++home++ / ++end++ |

The **seekbar** under the video marks labeled frames, shows track occupancy bars,
and can plot a per-frame statistic behind them — instance count, point
displacement, prediction score, and more. See [Navigation](../guides/navigation.md).

---

## 4. Place an instance

1. Press ++cmd+i++ / ++ctrl+i++ (or **Labels ▸ Add Instance**) to drop a new
   instance on the current frame.
2. **Drag nodes** to their correct positions.
3. Nodes you can't see should be marked non-visible rather than guessed —
   right-click a node for its menu. Press ++v++ to toggle whether non-visible
   nodes are drawn at all.
4. ++cmd+z++ / ++ctrl+z++ undoes anything.

Have more than one animal in the frame? ++cmd++-drag an existing instance to
clone it, or right-click ▸ **Add Instance**.

More in [Labeling Instances](../guides/labeling.md).

---

## 5. Pick better frames to label

Labeling consecutive frames is mostly wasted effort — neighboring frames look
almost identical. Open the **Suggestions** panel and generate a set of frames
spread across the video instead:

- **Stride** — evenly spaced, the sane default
- **Random** — uniform random sample
- **Image features** — decodes frames, clusters them, and picks a diverse set
- **Prediction score** / **Velocity** / **Max displacement** — target frames a
  model already struggles with

Then move through them with ++space++ / ++shift+space++.

See [Suggestions](../guides/suggestions.md).

---

## 6. Save

++cmd+s++ / ++ctrl+s++ saves back to `.slp`. **File ▸ Save As…** writes a new file.

The app also keeps a background draft of unsaved work, so a crashed tab or a
closed window doesn't cost you labels — you get a **Restore unsaved work?**
prompt next time. It's a safety net, not a substitute for saving.

---

## What next?

<div class="grid cards" markdown>

-   ✏️ **Label a real dataset**

    ---

    Skeletons, placement methods, and the editing workflow in depth.

    [:octicons-arrow-right-24: Your First Labels](first-labels.md)

-   🧠 **Train a model**

    ---

    Set up the Python environment and run sleap-nn training from the app.

    [:octicons-arrow-right-24: Training](../guides/training.md)

-   ⌨️ **Learn the shortcuts**

    ---

    Every keybinding, matching SLEAP's defaults.

    [:octicons-arrow-right-24: Keyboard Shortcuts](../reference/shortcuts.md)

</div>
