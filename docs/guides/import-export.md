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

To bring in predictions produced outside the app, open their `.slp` with
**File ▸ Open Project…**, or merge it into the open project with
**File ▸ Merge into Project…**.

## Exporting

**File ▸ Export ▸ …**

| Format | What it's for |
|---|---|
| **JSON** | Plain-text dump of the labels |
| **Analysis CSV** | Tabular per-frame, per-node coordinates — the usual input to downstream analysis |
| **Analysis HDF5** | The same data in SLEAP's analysis `.h5` layout, for the **current video** only |
| **NWB (ndx-pose)** | Sharing and archiving in the NWB ecosystem. Desktop only |
| **Labels Package** | A `.pkg.json` file: the labels plus a list of the project's videos. No image data |
| **Labeled Clip (Video)** | An MP4 with the pose overlay rendered in |

For a portable project that carries its own frames, use the `.pkg.slp` labels
package below instead.

### Labels packages

A **labels package** (`.pkg.slp`) embeds the image data alongside the labels, so
the project opens anywhere without its original videos. Export one with
**Predict ▸ Export Labels Package…** and pick a level:

| Level | Option | Contents |
|---|---|---|
| **Level 1** | User labeled frames | Only frames you labeled by hand |
| **Level 2** | User labeled + suggested frames | Your labeled frames plus suggested frames. The default |
| **Level 3** | All labeled frames | Every labeled frame, including predictions |

Level 1 is the smallest package to send to a collaborator; Level 3 is a full
archive.

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
