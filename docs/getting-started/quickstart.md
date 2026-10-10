# Quick Start

Get from nothing to a labeled frame in about five minutes.

!!! tip "There is a guided tutorial built into the app"

    Click **Start Tutorial** in the menu bar and the app walks you through the
    workflow, highlighting the exact control to click at each step. It
    downloads a sample video (`mice.mp4`) for you. If you would rather be
    shown than read, start there.

    - **Desktop app:** the full loop — new project, video, suggestions,
      skeleton, labeling, training, correcting predictions, retraining, and
      inference.
    - **Browser:** everything up to training — new project, video,
      suggestions, skeleton, and labeling one frame. It ends there, because
      models can't be trained in the browser.

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

To start fresh, use **File ▸ New Project…** (++cmd+n++ / ++ctrl+n++):

1. Pick a **Skeleton** — one of the built-in templates (fly, mouse top-down,
   human, *C. elegans*) or **Empty — define later**.
2. Add videos: drag them onto the dropzone or click it to browse. No video
   handy? Click **Use sample video** to download `mice.mp4`.
3. Click **Create Project**.

!!! note "Where projects live"

    In the **desktop app**, projects are ordinary files on disk and **Save**
    writes back in place. In the **browser**, it depends on the browser:

    - **Chrome / Edge** — **Save** writes back to the file you opened, and
      **Save As…** opens a save dialog.
    - **Firefox / Safari** — both download a new copy of the `.slp`.

    See [Saving & Recovery](../guides/saving.md).

---

## 3. Move around the video

| Action | Shortcut |
|---|---|
| Next / previous frame | ++right++ / ++left++ |
| Jump 10 frames | ++cmd+right++ / ++cmd+left++ (++ctrl+right++ / ++ctrl+left++) |
| Jump 100 frames | ++cmd+shift+right++ / ++cmd+shift+left++ (++ctrl+shift+right++ / ++ctrl+shift+left++) |
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
   right-click the node ▸ **Mark Node Non-Visible**.
4. ++cmd+z++ / ++ctrl+z++ undoes anything.

Have more than one animal in the frame? Hold ++ctrl++ and drag a node of an
existing instance to clone it (it's ++ctrl++ on macOS too, not ++cmd++), or
right-click ▸ **Add Instance**.

More in [Labeling Instances](../guides/labeling.md).

---

## 5. Pick better frames to label

Labeling consecutive frames is mostly wasted effort — neighboring frames look
almost identical. Open the **Suggestions** panel and generate a set of frames
spread across the video instead:

- **Stride** — evenly spaced, the sane default
- **Random** — uniform random sample
- **Frame chunk** — every frame in one range
- **Image features** — decodes frames, clusters them, and picks a diverse set
- **Prediction score** / **Velocity** / **Max displacement** — target frames a
  model already struggles with

Then move through them with ++space++ / ++shift+space++.

See [Suggestions](../guides/suggestions.md).

---

## 6. Save

++cmd+s++ / ++ctrl+s++ saves back to `.slp`. The first save of a new project
suggests the name `labels.v001.slp`. **File ▸ Save As…** writes a new file and
suggests the next version (`labels.v002.slp`, …).

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
