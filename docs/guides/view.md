# View & Display

Everything here lives under the **View** menu, and most of it is also in the
**View** panel.

## Zoom and pan

| Action | Shortcut |
|---|---|
| Fit view to instances | ++cmd+equal++ / ++ctrl+equal++ |
| Fit view to selection | **View ▸ Fit View to Selection** |
| Reset view | ++r++ |
| Toggle pan mode | ++p++ |

Scroll to zoom, drag to pan. **Default to Pan Mode** makes dragging pan instead of
select, for when you're reviewing rather than editing.

Two aids for precision work:

- **Crosshair When Zoomed** — draws crosshairs so you can line a point up exactly
- **Magnifier When Moving Nodes** — a loupe follows the node you're dragging

## What gets drawn

| Toggle | Shortcut |
|---|---|
| Show instances | ++h++ |
| Show node names | ++t++ |
| Show edges | ++cmd+shift+tab++ |
| Show non-visible nodes | ++v++ |

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
- **Node Label Size** — how big node name text is
- **Edge Style** — **Line** or **Wedge** (wedges make direction along a chain
  readable)
- **Trail Length** — how many frames of motion history to draw behind each instance
- **Text Size** — the whole UI's text scale (++cmd+shift+equal++ / ++cmd+minus++,
  and **Reset to Default**)

## Layout

- **Side Panel** — show or hide the panel column
- **Sidebar on Left** — move it to the other side
- **Allow Multiple Panels** — open several panels at once instead of one at a time
- **Panels ▸ Reset to Defaults…** — put the layout back

The **Panels** menu opens any individual panel; see the
[panels reference](../reference/panels.md).
