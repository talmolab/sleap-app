# Menus

Every menu and what its items do. **Help ▸ Search Menus…** finds any of these by
name.

## File

| Item | Notes |
|---|---|
| New Project… | ++cmd+n++ — pick a skeleton and add videos |
| Open Project… | ++cmd+o++ — `.slp` or `.pkg.slp` |
| **Import ▸** Analysis HDF5 / NWB dataset / COCO dataset / DeepLabCut dataset / Multiple DeepLabCut datasets from folder | [Import & Export](../guides/import-export.md) |
| Merge into Project… | [Merging Projects](../guides/merging.md) |
| **Replace Videos ▸** *(per video)* | Re-point a video at a new file |
| Add Video from URL… | Videos served over `https://` |
| Save | ++cmd+s++ |
| Save As… | ++cmd+shift+s++ |
| **Export ▸** JSON / Analysis CSV / Analysis HDF5 / NWB (ndx-pose) / Labels Package / Labeled Clip (Video) | [Import & Export](../guides/import-export.md) |
| Reveal Project in File Manager | Desktop only |
| Open Preferences Directory… | Desktop only |
| Clear Video Transcode Cache… | Desktop only |
| Quit | ++cmd+q++ |

## Edit

| Item | Notes |
|---|---|
| Undo / Redo | ++cmd+z++ / ++cmd+shift+z++ |
| Copy Instance / Paste Instance | ++cmd+c++ / ++cmd+v++ |
| Add Instance | ++cmd+i++ |
| Delete Instance | ++cmd+backspace++ |
| Delete Predictions on Current Frame | |

## Go

| Item | Notes |
|---|---|
| Go to Frame… / Select to Frame… | ++cmd+j++ / ++cmd+shift+j++ |
| Next / Previous Labeled Frame | ++alt+right++ / ++alt+left++ |
| Navigate All Frames / Labeled Frames Only / Imaged Frames Only | Sets what ++right++/++left++ step through |
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
| Fit View to Instances / to Selection | ++cmd+equal++ |
| Default to Pan Mode | ++p++ |
| Node Placement Mode | ++n++ |
| **Text Size ▸** Increase / Decrease / Reset to Default | |
| **Display ▸** Manual / Only selected (with hidden points) / All instances, visible points only / All visible + selected hidden points | Occluded-node policy |
| Show Instances / Show Non-Visible Nodes / Show Node Names / Show Edges | ++h++ / ++v++ / ++t++ / ++cmd+shift+tab++ |
| Crosshair When Zoomed / Magnifier When Moving Nodes | Precision aids |
| **Edge Style ▸** Line / Wedge | |
| **Node Marker Size ▸** / **Node Label Size ▸** / **Trail Length ▸** | |
| **Color Palette ▸** standard / five+ / alphabet | |
| **Apply Distinct Colors To ▸** Auto (Node / Track) / Tracks / Instances / Nodes / Edges | |
| Color Predicted Instances / Show Track Scores | |

[View guide](../guides/view.md)

## Panels

Opens any panel, plus **Reset to Defaults…** for the layout. See
[Panels](panels.md).

## Labels

| Item | Notes |
|---|---|
| Add Instance | ++cmd+i++ |
| **Instance Placement Method ▸** Best / Template / Force Directed / Random / Copy Prior Frame / Copy Predictions | [Labeling](../guides/labeling.md) |
| Show Hints During Labeling | |
| Delete Instance | ++cmd+backspace++ |
| Mark Frame as Negative | |
| Accept All Predictions on Current Frame | ++cmd+shift+a++ |
| Accept All Predictions | Project-wide |
| Delete Predictions on Current Frame | |
| Delete Predictions… | Over a range |
| Delete Predictions from Area… | ++cmd+k++ |
| Delete All Predictions… | |

## Predict

| Item | Notes |
|---|---|
| Training… | ++cmd+l++ — [Training](../guides/training.md) |
| Inference / Run Prediction… | [Inference](../guides/inference.md) |
| Export Labels Package… | For training elsewhere |
| Import Predictions… | Bring in predictions made outside the app |
| Evaluation Metrics for Trained Models… | Accuracy metrics per model |
| Visualize Model Outputs… | Confidence maps, PAFs, class maps |

## Tracks

| Item | Notes |
|---|---|
| Transpose Instance Tracks | ++cmd+t++ |
| New Track | ++cmd+0++ |
| **Set Instance Track ▸** *(per track)* | |
| Copy / Paste Instance Track | ++cmd+shift+c++ / ++cmd+shift+v++ |
| Propagate Track Labels | Carry an identity forward |
| Delete Instance and Track | ++cmd+shift+backspace++ |
| **Delete Track ▸** *(per track)* | |
| Delete Unused Tracks / Delete All Tracks | |
| **Seekbar Header ▸** None / Instance Count / Point Displacement / Primary Point Displacement / Tracking Score / Instance Score / Point Score / Number of predicted points / Min Centroid Proximity | [Navigation](../guides/navigation.md#statistic-graphs) |

## Analyze

| Item | Notes |
|---|---|
| Instance Size Distribution… | [Guide](../guides/instance-size.md) |
| Label Quality Check… | [Guide](../guides/label-qc.md) |

## Start Tutorial

Not a menu — a button. Runs the guided walkthrough of the full labeling →
training → correction → inference loop.

## Help

| Item | Notes |
|---|---|
| Search Menus… | Find and run any menu command by name |
| Keyboard Shortcuts… | [Reference](shortcuts.md) |
| Labeling Tips… | |
| Documentation | Opens [docs.sleap.ai](https://docs.sleap.ai) |
| Report Issue | Opens the issue tracker |
| Collect Diagnostics… | Bundles environment info for a bug report |
| Releases | Opens the releases page |
| About SLEAP Label | Version and channel |
