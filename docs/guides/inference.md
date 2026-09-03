# Inference

Inference runs a trained model over frames and writes predictions back into the
project. Open the **Inference** panel, or **Predict ▸ Inference / Run
Prediction…**.

## Models

Point the panel at your trained model directories:

| Pipeline | Models needed |
|---|---|
| **Single Animal** | One confidence-map model |
| **Top-Down** | Two — centroid and centered-instance |
| **Bottom-Up** | One — confidence maps + PAFs |
| **Top-Down + ID** | Top-down models with identity classification |
| **Bottom-Up + ID** | Bottom-up with identity classification |

Models you trained in the app are discovered automatically; you can also browse
for a directory, including on a [remote worker](remote-compute.md).

## What to predict on

**Inference Target**:

- Current frame
- Custom range
- Suggested frames
- User-labeled frames
- Frames with predictions
- Random sample (current video / all videos)
- Entire current video
- All videos

**Exclude user-labeled frames** keeps the model off the frames you already did by
hand.

Predicting on **suggested frames** right after a first training run is the
fastest way to get correctable predictions in front of you.

## Handling existing predictions

| Mode | Effect |
|---|---|
| **Replace** | Replace predictions on re-inferred frames; your labels are kept |
| **Add** | Add new predictions on top of existing ones (may duplicate) |
| **Clear first** | Remove all existing predictions, then add the new ones |

**Replace** is almost always what you want.

## Device and performance

- **Device** — CUDA (GPU), MPS (Apple Silicon), or CPU
- **Batch size** and **Image scale**
- **Peak threshold** — minimum confidence for a detected point
- **Max instances** — cap per frame

## Post-processing

Filters that clean up predictions before they land in the project:

- **Min instance score**, **min mean node score**
- **Min visible nodes** / **min visible node fraction**
- **Filter overlapping instances**, with an IoU threshold
- **Pre-cull to target** instance count, with its own IoU threshold

These are much cheaper than deleting bad instances by hand afterwards.

## Tracking

Enable **tracking** to assign identities across frames as part of the same run.

- **Track features** — centroid, keypoints, or bounding box
- **Similarity** — Euclidean distance, centroid distance, IoU, or optical flow
- **Matching** — greedy or Hungarian assignment
- **Max tracks**, **window size**, **init frame count**
- **Connect single-frame breaks**, **reset gap size**, **min new-track points**
- Optional **Kalman filter** smoothing
- **Tracked nodes** — restrict tracking to a subset of nodes

**Track only** mode skips pose estimation entirely and just (re)tracks existing
predictions — use it to retry tracking parameters without paying for inference
again.

See [Tracks](tracks.md) for correcting what tracking gets wrong.

## Monitoring and results

The panel shows progress, an inference log (click for the full terminal), and
errors. When a run finishes, **Load Results** brings the predictions into the
open project.

You can also bring in predictions produced elsewhere with
**Predict ▸ Import Predictions…**.

## Exporting a model

**Export model** writes a trained model out for deployment:

- **ONNX**
- **TensorRT**, with a precision setting

Both need `sleap-nn` installed with the export extras — the
[Environment](environment.md) panel can reinstall it with those included, and the
export dialog offers to do it for you.
