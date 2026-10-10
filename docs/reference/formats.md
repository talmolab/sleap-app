# File Formats

All I/O goes through [sleap-io.js](https://iojs.sleap.ai), the TypeScript port of
the Python [sleap-io](https://io.sleap.ai) library, so files written here are
byte-compatible with the rest of the SLEAP ecosystem.

## Project formats

| Format | Read | Write | Notes |
|---|---|---|---|
| `.slp` | ✅ | ✅ | The native format. HDF5 under the hood, via [h5wasm](https://github.com/usnistgov/h5wasm) |
| `.pkg.slp` | ✅ | ✅ | A `.slp` with image data embedded — opens with no video files present |

## Import

| Format | Menu |
|---|---|
| Analysis HDF5 (`.h5`) | **File ▸ Import ▸ Analysis HDF5…** |
| NWB (`ndx-pose`) | **File ▸ Import ▸ NWB dataset…** |
| COCO keypoints (`.json`) | **File ▸ Import ▸ COCO dataset…** |
| DeepLabCut | **File ▸ Import ▸ DeepLabCut dataset…** |
| DeepLabCut, in bulk | **File ▸ Import ▸ Multiple DeepLabCut datasets from folder…** |
| Predictions (`.slp`) | **File ▸ Open Project…**, or **File ▸ Merge into Project…** to add them to the open project |

## Export

| Format | Menu | Use |
|---|---|---|
| JSON | **File ▸ Export ▸ JSON…** | Plain-text dump |
| Analysis CSV | **File ▸ Export ▸ Analysis CSV…** | Downstream analysis |
| Analysis HDF5 | **File ▸ Export ▸ Analysis HDF5…** | SLEAP's analysis `.h5` layout, current video only |
| NWB (ndx-pose) | **File ▸ Export ▸ NWB (ndx-pose)…** | Sharing and archiving. Desktop only |
| Labels package (`.pkg.slp`) | **Predict ▸ Export Labels Package…** | Portable, self-contained project with frames embedded (Level 1/2/3, below) |
| Labels package (`.pkg.json`) | **File ▸ Export ▸ Labels Package…** | Labels plus a list of the project's videos, as JSON. No image data |
| Labeled clip (MP4) | **File ▸ Export ▸ Labeled Clip (Video)…** | Talks and figures |
| ONNX / TensorRT | **Predict ▸ Export Model to ONNX/TensorRT…**, or **Export Model…** in the Training panel after a run | Model deployment. Desktop only |

### Labels package levels

For the `.pkg.slp` export:

| Level | Frames included |
|---|---|
| 1 | Only frames you labeled by hand |
| 2 | Your labeled frames plus suggested frames (the default) |
| 3 | Every labeled frame, including predictions |

## Skeletons

| Format | Read | Write |
|---|---|---|
| Skeleton JSON (legacy SLEAP) | ✅ | |
| Skeleton YAML | ✅ | ✅ |
| From a `.slp` project | ✅ | |

## Video formats

Decoded directly via WebCodecs (8-bit): **H.264**, **HEVC/H.265**, **VP8**,
**VP9**, **AV1**. **MJPEG** decodes as per-frame JPEGs.

Needs transcoding first: MPEG-1/2, MPEG-4 ASP (Xvid/DivX), MS-MPEG4, WMV 1–3,
VC-1, and 10-bit H.264/HEVC. The desktop app transcodes these for you and caches
the result; in the browser, convert them yourself. See
[Videos](../guides/videos.md#codecs).

Videos can also be loaded from `https://` URLs — **File ▸ Add Video from URL…**
