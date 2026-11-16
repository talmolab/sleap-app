# View & Display

Everything here lives under the **View** menu, and most of it is also in the
**View** panel.

## Zoom and pan

| Action | Shortcut |
|---|---|
| Fit view to instances | ++cmd+equal++ / ++ctrl+equal++ |
| Fit view to selection | **View ▸ Fit View to Selection** |
| One video pixel per screen pixel | **View ▸ Actual Size (1:1)** |
| Zoom to the selected instance once | **View ▸ Zoom to Selection**, or ++shift+up++ / ++shift+down++ to select and zoom |
| Reset view | ++r++ |
| Toggle pan mode | ++p++ |

**Fit View to Instances**, **Fit View to Selection** and **Actual Size (1:1)**
are checkboxes that stay on, and only one can be on at a time:

- **Fit View to Instances** re-fits to every instance each time the frame changes.
- **Fit View to Selection** zooms to the selected instance when you turn it on,
  then again each time the frame changes. Moving to another frame clears the
  selection, so the view follows the same *track* there — handy for stepping
  through one animal. It doesn't zoom when you click or drag on the current
  frame. Untracked instances can't be followed to the next frame.
- **Actual Size (1:1)** shows one video pixel per screen pixel, keeping the
  middle of the view where it is. Unchecking it (or pressing ++r++) shows the
  whole frame again.

With the mouse and trackpad:

| Gesture | Does |
|---|---|
| Scroll (wheel or two-finger) | Pan |
| ++ctrl++ + scroll | Zoom toward the pointer (++ctrl++ on macOS too) |
| Trackpad pinch | Zoom, in Chrome and Edge |
| Middle-button drag | Pan |
| Hold ++space++ and drag | Pan |
| Drag on empty canvas | Draw a selection box |
| ++alt++ + drag on empty canvas | Draw a box and zoom to it; ++alt++ + double-click resets the zoom. Either turns off **Fit View to Instances** |

**Default to Pan Mode** (++p++) makes a plain drag pan instead of drawing a
selection box — handy when you're reviewing rather than editing. You can still
drag nodes in pan mode. In pan mode, ++space++-drag selects instead, ++cmd++ /
++ctrl++-drag zooms, and double-clicking empty canvas resets the view.

Two aids for precision work:

- **Crosshair When Zoomed** — draws crosshairs so you can line a point up exactly
- **Magnifier When Moving Nodes** — a zoomed view in the top-right corner of the
  video while you drag a node, while you place nodes, or while you hold
  ++shift++. The magnifier button on the video turns it on and off too, and the
  **View** panel sets its size and zoom.
- **Play Neighboring Frames in Magnifier** — while the magnifier is up from
  holding ++shift++ or placing nodes (not while dragging), it loops through the
  frames around the current one, so you see the motion around the point you're
  labeling. In the **View** panel, choose earlier and/or later frames and how
  many on each side (1–10, default 2).

## What gets drawn

| Toggle | Shortcut |
|---|---|
| Show instances | ++h++ |
| Show node names | ++t++ |
| Show edges | ++cmd+shift+tab++ |
| Show non-visible nodes | ++shift+v++ |
| Show mean node score | **View ▸ Show Mean Node Score** |

**Show Mean Node Score** adds a *Mean node score* column to the
[Instances panel](../reference/panels.md): the average confidence of the nodes
the model placed (nodes without a position are left out). It differs from the
*Score* column, which is the model's confidence in the whole instance. User
instances show "--".

**View ▸ Display** sets a coarser policy for showing occluded geometry:

| Mode | Shows |
|---|---|
| **Manual** | Whatever you toggled by hand |
| **Only selected (with hidden points)** | Just the selected instance, hidden points included |
| **All instances, visible points only** | Every instance, visible points only |
| **All visible + selected hidden points** | Everything, plus the selected instance's hidden points |

## Color

**View ▸ Apply Distinct Colors To** decides what the palette is spent on:

| Mode | Distinct colors per |
|---|---|
| **Auto (Node / Track)** | Nodes when there are no tracks, tracks when there are |
| **Tracks** | Identity — the right choice for reviewing tracking |
| **Instances** | Instance — useful on frames with several untracked animals |
| **Nodes** | Body part — useful for checking a skeleton |
| **Edges** | Connection |

**View ▸ Color Palette** picks the palette: **standard**, **five+** (more distinct
hues, for many tracks), or **alphabet**.

**View ▸ Color Predicted Instances** controls whether predictions get the same
color treatment as user labels, or are drawn distinctly so you can tell at a
glance what still needs accepting.

## Sizing

- **Node Marker Size** — how big the node circles are
- **Pose Opacity** — 100%, 75%, 50% or 25%, to see the animal under the pose
- **Node Label Size** — how big node name text is
- **Edge Style** — **Line** or **Wedge** (wedges make direction along a chain
  readable)
- **Bold Lines** — edges and node outlines twice as thick
- **Trail Length** — how many frames of motion history to draw behind each tracked instance
- **Trail Node** — what the trail follows: **Centroid** (the middle of the
  visible nodes) or one skeleton node, e.g. the head
- **Fade Older Trail Segments** — on by default; older parts of the trail are
  fainter. Off draws the whole trail at one opacity.
- **Trail Opacity** — 25%, 50%, 75% or 100%
- **Trail Width** — 1–8 px (default 4), in screen pixels, so it looks the same
  at any zoom

Exported clips (**File ▸ Export ▸ Clip**) use the same trail and Bold Lines
settings.
- **Text Size** — the whole UI's text scale (++cmd+shift+equal++ / ++cmd+minus++,
  and **Reset to Default**)

## Layout

- **Side Panel** — show or hide the panel column
- **Sidebar on Left** — move it to the other side
- **Allow Multiple Panels** — open several panels at once instead of one at a time
- **Panels ▸ Reset to Defaults…** — put the layout back

The **Panels** menu opens any individual panel; see the
[panels reference](../reference/panels.md).
