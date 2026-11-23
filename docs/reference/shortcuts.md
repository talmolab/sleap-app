# Keyboard Shortcuts

These match [SLEAP](https://docs.sleap.ai)'s defaults, so muscle memory carries
over from the legacy GUI.

++cmd++ is shown for macOS; on Windows and Linux it is ++ctrl++.

**Help ▸ Keyboard Shortcuts…** shows these inside the app, and lets you
change them; this page lists the defaults.

## Changing shortcuts

In **Help ▸ Keyboard Shortcuts…**, click an action's key, then press the new
key (++esc++ cancels). If another action already uses that key, the app asks
whether to move it; if you say yes, the other action is left without a key.
The ✕ next to a key removes it, and ↺ puts an action back on its default.
Changes apply when you click **Save**, everywhere: on the canvas, in the
menus (including the macOS menu bar), and in **Help ▸ Search Menus**.

- Your shortcuts are saved on this computer with your other preferences.
  **File ▸ Reset Preferences to Defaults…** (or **Reset to Defaults** in the
  dialog) puts them all back.
- **Export…** saves them as a `shortcuts.yaml` file, and **Import…** loads
  one, for example to use the same keys on another computer. The file uses
  the same format as SLEAP's own `shortcuts.yaml`, so you can import your
  shortcuts from the legacy SLEAP GUI too (there, `Ctrl` means ++cmd++ on
  macOS). Entries you never changed in SLEAP keep this app's keys (for
  example ++t++ for node names and ++shift+m++ for Merge Instance).
- Some keys can't be assigned: Undo/Redo, the text-size keys,
  ++cmd+1++–++cmd+9++ (set track), ++backspace++/++delete++ (delete selected
  nodes) and ++space++ (hold to pan; only the suggestion keys may use it).
  Nor can keys the system or browser keep: ++cmd+tab++ and ++cmd+space++ on
  macOS; ++cmd+q++, ++cmd+h++, ++cmd+m++ and ++cmd+w++ in the macOS desktop
  app; and in a browser, its tab and window keys such as ++cmd+w++,
  ++cmd+t++ and ++cmd+n++.
- Shortcuts without ++cmd++/++ctrl++ (a letter, an arrow) do nothing while
  you're typing in a text field.

## File

| Action | Shortcut |
|---|---|
| New project | ++cmd+n++ |
| Open project | ++cmd+o++ |
| Save | ++cmd+s++ |
| Save As | ++cmd+shift+s++ |
| Quit | ++cmd+q++ |

## Frame navigation

| Action | Shortcut |
|---|---|
| Next / previous frame | ++right++ / ++left++ |
| ± 10 frames | ++cmd+right++ / ++cmd+left++ |
| ± 100 frames | ++cmd+shift+right++ / ++cmd+shift+left++, or SLEAP's ++cmd+alt+right++ / ++cmd+alt+left++ (desktop app only on macOS: browsers there use it to switch tabs) |
| First frame | ++home++ |
| Last frame | ++end++ |
| Go to frame… | ++cmd+j++ |
| Select to frame… | ++cmd+shift+j++ |
| Mark frame | ++cmd+m++ |
| Go to marked frame | ++cmd+shift+m++ |

## Labeled-frame navigation

| Action | Shortcut |
|---|---|
| Next / previous labeled frame | ++alt+right++ / ++alt+left++ |
| Next / previous user-labeled frame | ++cmd+u++ / ++cmd+shift+u++ |
| Next / previous suggestion | ++space++ / ++shift+space++ |
| Next track spawn frame | ++cmd+e++ |
| Last interacted frame | ++cmd+a++ |

## Video navigation

| Action | Shortcut |
|---|---|
| Next video | ++alt+shift+right++ |
| Previous video | ++alt+shift+left++ |

## Selection

| Action | Shortcut |
|---|---|
| Select next instance | ++grave-accent++ |
| Select next instance and zoom | ++shift+down++ |
| Select previous instance and zoom | ++shift+up++ |
| Clear selection | ++escape++ |

## Labeling

| Action | Shortcut |
|---|---|
| Add instance | ++cmd+i++ |
| Delete instance | ++cmd+backspace++ |
| Merge instance — fill the selected instance's missing nodes from another user instance on the frame, then remove that one | ++shift+m++ |
| Select every node of the selected instance | ++shift+a++ |
| Accept all predictions on frame | ++cmd+shift+a++ |
| Mark frame as negative | ++n++ |
| Delete predictions in area | ++cmd+k++ |
| Copy instance | ++cmd+c++ |
| Paste instance | ++cmd+v++ |
| Undo | ++cmd+z++ |
| Redo | ++cmd+shift+z++ |

## Tracks

| Action | Shortcut |
|---|---|
| Transpose instance tracks | ++cmd+t++ |
| Turn Propagate Track Labels on / off | ++shift+p++ (SLEAP uses ++p++, which is pan mode here) |
| New track | ++cmd+0++ |
| Set instance track 1–9 | ++cmd+1++ … ++cmd+9++ — creates the track (and any before it) if it doesn't exist yet |
| Delete instance and track | ++cmd+shift+backspace++ |
| Copy instance track | ++cmd+shift+c++ |
| Paste instance track | ++cmd+shift+v++ |

## View

| Action | Shortcut |
|---|---|
| Fit view to instances | ++cmd+equal++ |
| Reset view | ++r++ |
| Toggle pan mode | ++p++ |
| Node placement mode | ++shift+n++ |
| Next / previous node, in node placement mode | ++tab++ / ++shift+tab++ |
| Show / hide instances | ++h++ |
| Show / hide node names | ++t++, or SLEAP's ++ctrl+tab++ (the Control key on macOS too; desktop app only: browsers use it to switch tabs) |
| Show / hide edges | ++cmd+shift+tab++ |
| Flip the node under the pointer between visible and non-visible | ++v++ |
| Set all selected nodes visible, or all non-visible (visible unless more than half already are) | ++v++ with nodes selected |
| Toggle non-visible nodes | ++shift+v++ |
| Increase text size | ++cmd+shift+equal++ |
| Decrease text size | ++cmd+minus++ |

## Canvas gestures

Mouse and trackpad, on the video canvas.

| Gesture | Action |
|---|---|
| Scroll / two-finger swipe | **Pan** — not zoom |
| ++ctrl++ + scroll | Zoom, anchored at the cursor |
| Trackpad pinch | Zoom (in Chrome and Edge) |
| Middle-button drag | Pan |
| Drag on empty canvas | Selection box; hold ++shift++ to add to the selection |
| Click a node | Select it |
| ++shift++ + click a node | Mark every node of that instance complete, as in SLEAP |
| ++alt+shift++ + click a node | Add it to the selection, or remove it |
| Double-click a user instance | Add the nodes it's missing, as non-visible nodes to drag into place (as in SLEAP) |
| Drag a selected node | Move all selected nodes together |
| ++alt++ + drag a node | Move the whole instance |
| ++alt++ + drag on empty canvas | Draw a box and zoom to it, as in SLEAP |
| ++alt++ + double-click empty canvas | Reset the zoom |
| ++alt++ + scroll | Rotate the selected instance |
| Right-click a node | Flip it between visible and non-visible |
| Right-click an instance's body or empty canvas | Context menu: add, copy, paste, delete or merge instances, assign a track, mark the frame negative |
| Double-click a prediction | Accept it as your label |
| ++shift++ + double-click a prediction | Accept it with every node marked complete |
| ++delete++ / ++backspace++ | Delete the selected instance, when all its visible nodes are selected |
| Hold ++space++ + drag | Pan |
| Double-tap ++space++ | Cycle zoom: free → fit instances → fit frame |
| ++cmd++ + drag, in pan mode (++p++) | Zoom by dragging |
| ++ctrl++ + drag a user instance | Clone it and drag the copy — ++ctrl++ on macOS too |

Scrolling **pans** by default — deliberately, so a mouse wheel and a trackpad
two-finger swipe behave identically without the app guessing which one you have.
Hold ++ctrl++ to zoom instead. Here ++ctrl++ means ++ctrl++ on macOS as well
(as it does for ++ctrl++ + drag to clone): ++cmd++ with the scroll wheel does not
zoom. A trackpad pinch zooms in Chrome and Edge.

++space++ does three things. A **tap** jumps to the next suggestion — it fires on
release, and is skipped if you clicked or dragged while holding it. A **hold**
pans (in pan mode, it selects instead). A **double-tap** cycles the zoom modes.

## Models

| Action | Shortcut |
|---|---|
| Training… | ++cmd+l++ |

## Other

| Action | Shortcut |
|---|---|
| Dismiss all notifications | ++cmd+shift+d++ |

!!! tip "Can't find a command?"

    **Help ▸ Search Menus…** searches every menu item by name and runs it — faster
    than remembering which menu something lives under.
