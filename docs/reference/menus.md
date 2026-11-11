# Menus

Every menu and what its items do, in the order they appear in the menu bar.
**Help ▸ Search Menus…** finds any of these by name.

++cmd++ is shown for macOS; on Windows and Linux it is ++ctrl++.

## File

| Item | Notes |
|---|---|
| New Project… | ++cmd+n++ — opens a new tab (browser) or window (desktop) at the Welcome screen, where you create the project; the current project stays open |
| Open Project… | ++cmd+o++ — `.slp` or `.pkg.slp` |
| **Import ▸** Analysis HDF5… / NWB dataset… / COCO dataset… / DeepLabCut dataset… / Multiple DeepLabCut datasets from folder… | [Import & Export](../guides/import-export.md) |
| Merge into Project… | [Merging Projects](../guides/merging.md) |
| **Replace Videos… ▸** *(one entry per video)* | Re-point a video at a new file |
| Add Video from URL… | Videos served over `https://` |
| Save | ++cmd+s++ |
| Save As… | ++cmd+shift+s++ |
| **Export ▸** JSON… | The labels as plain JSON |
| **Export ▸ Analysis CSV ▸** Current Video… / All Videos… | Per-frame coordinates as CSV |
| **Export ▸ Analysis HDF5 ▸** Current Video… / All Videos… | The same, in SLEAP's analysis `.h5` layout |
| **Export ▸** NWB (ndx-pose)… | Desktop only |
| **Export ▸** Labels Package (.pkg.slp)… | A self-contained `.pkg.slp` with frame images embedded |
| **Export ▸** JSON Package… | The labels as JSON plus a list of the project's videos; no images |
| **Export ▸** Labeled Clip (Video)… | An MP4 with the poses drawn on |
| Reveal Project in File Manager | Desktop only |
| Open Preferences Directory… | Desktop only |
| Clear Video Transcode Cache… | Desktop only |
| Quit | ++cmd+q++ |

## Go

| Item | Notes |
|---|---|
| Go to Frame… / Select to Frame… | ++cmd+j++ / ++cmd+shift+j++ |
| Next / Previous Labeled Frame | ++alt+right++ / ++alt+left++ |
| Navigate All Frames / Navigate Labeled Frames Only / Navigate Suggested Frames Only / Navigate Imaged Frames Only | Sets what ++right++ / ++left++ step through |
| Next / Previous Suggestion | ++space++ / ++shift+space++ |
| Last Interacted Frame | ++cmd+a++ |
| Next / Previous User Labeled Frame | ++cmd+u++ / ++cmd+shift+u++ |
| Next Track Spawn Frame | ++cmd+e++ |
| Mark Frame / Go to Marked Frame | ++cmd+m++ / ++cmd+shift+m++ |
| Next / Previous Video | ++alt+shift+right++ / ++alt+shift+left++ |
| Select Next Instance / Clear Selection | ++grave-accent++ / ++escape++ |

[Navigation guide](../guides/navigation.md)

## View

| Item | Notes |
|---|---|
| Side Panel / Sidebar on Left / Allow Multiple Panels | Layout |
| **Panels ▸** *(one checkbox per panel)* / Reset to Defaults… | Each checkbox shows or hides that panel's button in the sidebar strip; it doesn't open the panel. See [Panels](panels.md) |
| Fit View to Instances | Checkbox; ++cmd+equal++ toggles it |
| Fit View to Selection | Needs a selected instance |
| Default to Pan Mode | ++p++ |
| Node Placement Mode | ++shift+n++ — needs a selected instance |
| **Text Size ▸** Increase / Decrease / Reset to Default | ++cmd+shift+equal++ / ++cmd+minus++ |
| Show Instances | ++h++ |
| Show Non-Visible Nodes | ++shift+v++ |
| **Display ▸** Manual / Only selected (with hidden points) / All instances, visible points only / All visible + selected hidden points | How much hidden geometry is drawn |
| Show Node Names / Show Edges | ++t++ / ++cmd+shift+tab++ |
| Crosshair When Zoomed / Magnifier When Moving Nodes | Precision aids |
| Play Neighboring Frames in Magnifier | Loops the frames around the current one inside the magnifier |
| **Edge Style ▸** Line / Wedge | |
| **Node Marker Size ▸** Small (2) / Medium (4) / Large (6) / Extra Large (8) | |
| **Pose Opacity ▸** 100% / 75% / 50% / 25% | |
| **Node Label Size ▸** Small (8) / Medium (10) / Large (12) / Extra Large (14) | |
| **Trail Length ▸** Off / Short (10) / Medium (50) / Long (100) / Very Long (250) / Maximum (500) | Frames of motion history drawn behind each instance |
| **Color Palette ▸** standard / five+ / alphabet | |
| **Apply Distinct Colors To ▸** Auto (Node / Track) / Tracks / Instances / Nodes / Edges | |
| Color Predicted Instances | Off by default: predictions are drawn yellow until you turn this on |
| Show Track Scores | |
| Create Local Scrub Proxies for Network Videos (Desktop) | Desktop only; off by default. Builds a local copy of large network-drive videos for smoother scrubbing |

[View guide](../guides/view.md)

## Labels

| Item | Notes |
|---|---|
| Undo / Redo | ++cmd+z++ / ++cmd+shift+z++ — the label names the action, e.g. *Undo Add Instance* |
| Add Instance | ++cmd+i++ |
| **Instance Placement Method ▸** Best / Template / Force Directed / Random / Copy Prior Frame / Copy Predictions | [Labeling](../guides/labeling.md#placement-methods) |
| Show Hints During Labeling | |
| Delete Instance | ++cmd+backspace++ |
| Merge Instance | ++shift+m++ — fills the selected instance's missing nodes from another user instance on the frame, then removes that one. [Labeling](../guides/labeling.md#editing) |
| Copy Instance / Paste Instance | ++cmd+c++ / ++cmd+v++ |
| Mark Frame as Negative | ++n++ — [Negative frames](../guides/labeling.md#negative-frames) |
| Accept All Predictions on Current Frame | ++cmd+shift+a++ |
| Accept All Predictions | Every prediction in the project |
| Delete Predictions on Current Frame | |
| Delete Predictions… | Predictions matching a filter |
| Delete Predictions from Area… | ++cmd+k++ — drag a box on the frame |
| Delete All Predictions… | Asks first |
| Extract Clip and Labels… | Saves the frame range selected on the seekbar as a trimmed clip plus its labels, numbered from frame 0, and opens it. Select a range by shift-dragging on the seekbar |
| Extract Clip Labels Package… | Saves the selected range's labeled and suggested frames, with images, as a `.pkg.slp`, and opens it |

The bottom of the menu shows the project's labeled-frame and instance counts.

## Analyze

| Item | Notes |
|---|---|
| Instance Size Distribution… | [Guide](../guides/instance-size.md) |
| Label Quality Check… | [Guide](../guides/label-qc.md) |

## Tracks

| Item | Notes |
|---|---|
| Transpose Instance Tracks | ++cmd+t++ |
| New Track | ++cmd+0++ |
| **Set Instance Track ▸** *(one entry per track)* | Only when the project has tracks. ++cmd+1++ … ++cmd+9++ set tracks 1–9 directly |
| Copy / Paste Instance Track | ++cmd+shift+c++ / ++cmd+shift+v++ |
| Propagate Track Labels | Checkbox — track changes carry through later frames. [Tracks](../guides/tracks.md#propagating) |
| Delete Instance and Track | ++cmd+shift+backspace++ |
| **Delete Track ▸** *(one entry per track)* | Only when the project has tracks |
| Delete Unused Tracks / Delete All Tracks | Both ask first |
| **Seekbar Header ▸** None / Instance Count / Point Displacement / Primary Point Displacement / Tracking Score / Instance Score / Point Score / Number of predicted points / Min Centroid Proximity | [Navigation](../guides/navigation.md#statistic-graphs) |

## Predict

| Item | Notes |
|---|---|
| Training… | Opens the Training panel and its Full Configuration. ++cmd+l++ opens the panel. [Training](../guides/training.md) |
| Inference / Run Prediction… | Opens the Inference panel and its Full Configuration. [Inference](../guides/inference.md) |
| Connect (Remote Training / Inference)… | Opens the Connect window, for running training and inference on another machine |
| Export Labels Package… | Same as **File ▸ Export ▸ Labels Package (.pkg.slp)…** |
| Export Model to ONNX/TensorRT… | Desktop only — [Inference](../guides/inference.md#exporting-a-model) |
| Evaluation Metrics for Trained Models… | Accuracy metrics per model |
| Set Overlay Models… | Pick the trained models whose outputs to overlay. The overlay runs `sleap-nn` locally, so it needs the desktop app |
| Visualize Model Outputs | Checkbox — confidence maps, PAFs, class maps. Disabled until overlay models are set |

## Connect and Start Tutorial

Buttons in the menu bar, not menus.

- **Connect** opens the same Connect window as **Predict ▸ Connect (Remote
  Training / Inference)…**.
- **Start Tutorial** runs the guided walkthrough of the labeling → training →
  correction → inference loop. It builds its own project from a sample video. If
  you already have a project open, it offers to run in a new window so your
  project is left alone. In the desktop app it starts by checking that uv and
  sleap-nn are installed, and warns you if training will run on the CPU. In the
  browser it explains that models can't be trained there, and ends after
  labeling.

## Help

| Item | Notes |
|---|---|
| Search Menus… | Find and run any menu command by name |
| Keyboard Shortcuts… | [Reference](shortcuts.md) |
| Labeling Tips… | |
| Documentation | Opens this site, for the channel the app is on (`app.sleap.ai/docs/<channel>/`) |
| Report Issue | Opens the issue tracker |
| Collect Diagnostics… | Bundles environment info for a bug report |
| Releases | Opens the releases page |
| About SLEAP Label | Version and channel |
