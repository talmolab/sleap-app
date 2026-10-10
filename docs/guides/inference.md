# Inference

Inference runs a trained model over frames and writes predictions back into the
project. Open the **Inference** panel, or **Predict ▸ Inference / Run
Prediction…**.

## Models

Pick the **Pipeline**, then point the panel at your trained model directories:

| Pipeline | Models needed |
|---|---|
| **Top-Down** | Two — centroid and centered-instance |
| **Bottom-Up** | One — confidence maps + PAFs |
| **Single Animal** | One confidence-map model |
| **Top-Down + ID** | Top-down models with identity classification |
| **Bottom-Up + ID** | Bottom-up with identity classification |

On the desktop app, the most recently trained models in the project's `models/`
folder are picked for you. Click **Add** to choose a directory yourself, or
**Browse Worker** for one on a [remote worker](remote-compute.md).

## What to predict on

**Inference Target**:

- Custom range
- Entire current video
- All videos
- Current frame
- Random sample (current video)
- Random sample (all videos)
- Suggested frames
- User labeled frames
- Frames with predictions

**Exclude user-labeled frames** keeps the model off the frames you already did by
hand.

Predicting on **suggested frames** right after a first training run is the
fastest way to get correctable predictions in front of you.

## Handling existing predictions

**Existing predictions** decides what happens to predictions already in the
project:

| Option | Effect |
|---|---|
| **Replace** (default) | Replace predictions on re-inferred frames; your labels are kept |
| **Keep** | Add new predictions on top of existing ones (may duplicate) |
| **Clear all** | Remove all existing predictions first, then add the new ones |

**Replace** is almost always what you want.

## Inference settings

- **Batch size**
- **Device** (desktop) — **Auto** (the default), **CUDA (GPU)**, **CPU**, or
  **MPS (Apple Silicon)**
- **Runtime** (desktop) — **Auto** (the default) lets `sleap-nn` choose.
  **ONNX** and **TensorRT** apply only when the model is an
  [exported model](#exporting-a-model) directory; they're ignored for regular
  checkpoints. **TensorRT** is only listed on machines with an NVIDIA (CUDA) GPU
- **Peak threshold** — minimum confidence for a detected point
- **Max instances** — cap per frame, or check **No limit**

## Post-processing

Filters that clean up predictions before they land in the project:

- **Filter overlapping instances**, with a **Method** (IoU or OKS) and
  **Threshold**
- **Min visible nodes** / **Min visible node fraction**
- **Min mean node score**, **Min instance score**
- **Min centroid distance**

These are much cheaper than deleting bad instances by hand afterwards.

## Tracking

Check **Enable tracking** to assign identities across frames as part of the same
run.

- **Method** — **Simple** (match by similarity alone), **Optical Flow** (predict
  motion from pixel displacement; good for fast-moving animals), or **Kalman
  Filter** (a per-track motion model; good for a known, fixed number of animals)
- **Similarity** — **OKS**, **IoU**, **Centroid dist.**, or **Euclidean dist.**
- **Matching** — **Hungarian** or **Greedy**
- **Window size**, **Max tracks**
- **Advanced** — **Robust (quantile)**, **Connect single-frame breaks**, **Min match points**, **Min
  new-track points**, **Scoring reduction**, **Target instance count**, **Pre-cull
  to target** (with its own IoU threshold), and **Clean-up instance count** (with
  its own IoU threshold)
- With **Optical Flow**: **Image scale**, **Flow window size**, **Pyramid levels**
- With **Kalman Filter**: **Track features** (**Centroid** or **Keypoints**),
  **Init frame count**, **Reset gap size**, and **Tracked nodes** to restrict
  tracking to a subset of nodes

**Track only** (top of the panel) skips pose estimation entirely and just
(re)tracks the instances already in the project — use it to retry tracking
parameters without paying for inference again.

See [Tracks](tracks.md) for correcting what tracking gets wrong.

## Monitoring and results

Click **Run Inference** (or **Run Remote Inference** with a worker selected). The
panel shows progress, an inference log (click for the full terminal), and
errors; **Cancel** stops a run. When a run finishes, **Load Results** brings the
predictions into the open project (for a remote run, **Fetch & Load Results**).

To bring in predictions produced elsewhere, open the `.slp` with
**File ▸ Open Project…**, or merge it into the current project with
**File ▸ Merge into Project…**.

## Exporting a model

Exporting converts a trained model to a faster runtime. It's desktop-only. Open
it from **Predict ▸ Export Model to ONNX/TensorRT…**, or from **Export Model…**
in the Training panel after a run finishes.

- **Format** — **ONNX**, **TensorRT**, or **Both**. TensorRT needs an NVIDIA GPU
- **Precision** (TensorRT) — fp16, fp32, or tf32

Export needs `sleap-nn`'s ONNX/TensorRT support. Install it from the
[Environment](../installation.md#environment-setup) panel: under **Extras**,
check **ONNX** (and **TensorRT**, on Linux/Windows with an NVIDIA GPU), then click
**Apply**. That reinstalls `sleap-nn` with those extras. If support is missing
when you export, the export dialog offers **Install support & retry**.

To export automatically when a local training run finishes, set **Export Model** under
**Output** in the training **Full Configuration...** dialog.
