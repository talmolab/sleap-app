# Import & Export

The project's native format is `.slp`. Everything else is a conversion, handled
by [sleap-io.js](https://iojs.sleap.ai).

## Opening projects

| Format | How |
|---|---|
| `.slp` | **File ▸ Open Project…**, or drag onto the window |
| `.pkg.slp` | Same — frames come out of the file, no video files needed |

## Importing

**File ▸ Import ▸ …**

| Format | Notes |
|---|---|
| **Analysis HDF5** | SLEAP's analysis `.h5` export |
| **NWB dataset** | Neurodata Without Borders, `ndx-pose` |
| **COCO dataset** | COCO keypoint JSON |
| **DeepLabCut dataset** | A single DLC project |
| **Multiple DeepLabCut datasets from folder** | Batch-import a folder of DLC projects at once |

**Predict ▸ Import Predictions…** brings in predictions produced outside the app.

## Exporting

**File ▸ Export ▸ …**

| Format | What it's for |
|---|---|
| **JSON** | Plain-text dump of the labels |
| **Analysis CSV** | Tabular per-frame, per-node coordinates — the usual input to downstream analysis |
| **Analysis HDF5** | The same data in SLEAP's analysis `.h5` layout |
| **NWB (ndx-pose)** | Sharing and archiving in the NWB ecosystem |
| **Labels Package** | Labels bundled with their image data — portable, self-contained |
| **Labeled Clip (Video)** | An MP4 with the pose overlay rendered in |

++cmd+alt+e++ exports the analysis file for the current video directly.

### Labels packages

A **labels package** (`.pkg.slp`) embeds the image data alongside the labels, so
the project opens anywhere without its original videos. Three levels of
completeness:

| Level | Contents |
|---|---|
| **Level 1** | Only frames you labeled by hand |
| **Level 2** | Your labeled frames plus suggested frames |
| **Level 3** | Every labeled frame, including predictions |

Level 1 is what you send to a collaborator or upload for training elsewhere;
Level 3 is a full archive. **Predict ▸ Export Labels Package…** is the same
export, reachable from the training workflow.

### Labeled clips

**File ▸ Export ▸ Labeled Clip (Video)…** renders MP4 with the skeleton overlay
burned in. You pick the frame range, which videos to include, and the frame rate,
and preview before rendering. Good for talks, figures, and showing someone what
your data actually looks like.

## Interoperability

`.slp` is the same format the [legacy SLEAP GUI](https://docs.sleap.ai) and the
Python [sleap-io](https://io.sleap.ai) library read and write. You can label
here, analyze in Python, and open the same file in the Qt GUI, without converting
anything.

See the [File Formats reference](../reference/formats.md) for the full table.
