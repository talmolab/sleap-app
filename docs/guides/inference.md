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

### What's in a model folder

Each trained model is a folder, named after its run (for example
`251109_130412.centroid.n=8`). The two files inference needs are:

| File | What it is |
|---|---|
| `training_config.yaml` | The model's settings and architecture |
| `best.ckpt` | The weights from the epoch with the best validation score |

Keep both together when you copy or share a model; neither works alone. The
folder also holds `last.ckpt` (the final epoch, used to
[resume training](training.md#scratch-fine-tune-or-resume)), a
`training_log.csv` of the loss curves, and the predictions and metrics from
evaluation.

Models trained in legacy SLEAP (1.4 and earlier) use `training_config.json`
and `best_model.h5` instead. sleap-nn can run these too (UNet models only), so
add the folder the same way.

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

### How tracking works

Pose estimation finds the animals on each frame on its own. Tracking then links
them across frames: for each frame, it compares every new instance with
**candidates** from the frames before, and either adds it to the best-matching
track or starts a new one. Each frame's identities follow from the frame
before, which is why one mistake can carry on for the rest of the video
([Common tracking mistakes](tracks.md#common-tracking-mistakes)).

Tracking is a separate step from pose estimation, so you can redo it without
predicting again: check **Track only** at the top of the panel. It re-tracks the
instances already in the project, which makes it cheap to try different
settings.

### Settings

**Method** decides where candidates come from:

| Method | How it matches | Use it for |
|---|---|---|
| **Simple** | Compares instances with recent ones by similarity alone | Most videos; the place to start |
| **Optical Flow** | Shifts the recent instances along the motion in the image first | Fast-moving animals |
| **Kalman Filter** | Predicts each track's next position from its own velocity | A known, fixed number of animals that cross or hide behind each other |

**Similarity** decides how "close" two instances are:

| Similarity | Compares | Use it when |
|---|---|---|
| **OKS** (default) | Every keypoint, scaled by the animal's size | Most cases |
| **IoU** | Bounding-box overlap | Animals usually stay apart |
| **Centroid dist.** | Distance between centers | Matching by position alone, ignoring pose |
| **Euclidean dist.** | Distance between keypoints | A simple, fast alternative to OKS |

**Matching** pairs instances with tracks: **Hungarian** finds the best overall
assignment, while **Greedy** takes the best match for each instance in turn: it's
faster, but may not find the best overall assignment.

**Window size** is how many past frames supply candidates. A larger window
bridges longer gaps but runs slower.

**Max tracks** caps the number of identities. Set it to the number of animals
when you know it: the tracker then keeps a separate history for each track,
which holds up better through occlusions, and never starts more tracks than
that.

Under **Advanced**:

- **Connect single-frame breaks** (with Max tracks set) joins a track that ends
  to one that starts on the next frame, when exactly one of each happens. This
  fixes brief detection dropouts.
- **Robust (quantile)** makes the similarity score tolerant of a few bad
  keypoints; 0.95 is a good start. At 1 it uses the plain maximum.
- **Min match points** and **Min new-track points** set how many keypoints an
  instance needs to be matched, or to start a new track.
- **Scoring reduction** decides how several similarity scores are combined:
  **Mean**, **Max**, or the robust quantile.
- **Target instance count**, **Pre-cull to target** and **Clean-up instance
  count** drop extra detections above a per-frame count, before or after
  tracking, each with its own IoU threshold.

With **Optical Flow**: **Image scale** (lower is faster but less precise),
**Flow window size** (larger handles faster motion but is slower), and
**Pyramid levels** (more handle larger movements).

With **Kalman Filter**: **Track features** (**Centroid**, the default and most
stable, or **Keypoints**), **Init frame count** (frames tracked normally before
the motion model starts), **Reset gap size** (missed frames before a track's
model resets), and **Tracked nodes** to use only a stable subset, such as the
spine.

### Starting points

| Situation | Try |
|---|---|
| Most videos | **Simple**, **OKS**, **Hungarian**, with **Max tracks** set to the number of animals |
| Fast-moving animals | **Optical Flow**, with a smaller **Image scale** if it's slow |
| Crowded scenes | A larger **Window size**, plus **Max tracks** |
| A fixed number of animals that cross often | **Kalman Filter** |

### When tracking goes wrong

- **Fix the poses first.** Tracking can only link what pose estimation finds:
  missed or jumpy predictions cause most tracking errors. Label more of the
  frames where detection fails, and retrain.
- Set **Max tracks** if you know how many animals there are.
- Try another **Method** or **Similarity**, or a larger **Window size**, with
  **Track only** so you don't have to predict again.

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
