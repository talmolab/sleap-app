# Training

The **Training** panel configures and runs [sleap-nn](https://nn.sleap.ai)
training without leaving the app. Runs go to a local GPU (desktop, see
[Environment Setup](environment.md)) or to a [remote worker](remote-compute.md).

You need at least one user-labeled frame. Label a handful first —
[Your First Labels](../getting-started/first-labels.md) walks the whole loop.

## Model types

| Type | What it does | Use when |
|---|---|---|
| **Single Animal** | One pose per frame, no instance grouping | Exactly one animal per frame |
| **Top-Down** | Finds an anchor point per animal, crops around it, predicts the pose inside the crop | The default for multiple animals |
| **Bottom-Up** | Predicts all parts across the whole image, then groups them into animals | Many animals; needs a fully connected skeleton |
| **Top-Down + ID** | Top-down, plus a learned identity class per animal | Animals are visually distinguishable and you want identity from the model |
| **Bottom-Up + ID** | Bottom-up, plus identity classes | Same, for the bottom-up pipeline |

Top-down trains **two** models — a **centroid** model and a **centered instance**
model — so the panel shows two config slots. The other types use one.

!!! tip "Pick the anchor part deliberately"

    Top-down crops around the anchor part on every frame, so it must be central
    and almost always visible. `torso` is a good anchor; `tail_tip` is a bad one.
    You can **pick the anchor from the canvas** and **preview the crop** on the
    current frame before committing.

## Configuration

The panel is organized into collapsible sections; **Model Type & Configs** and
**Hyperparameters** cover most of what you'll touch.

### Data

- **Training Labels** — which project to train on (defaults to the open one)
- **Validation** — *Same as training (auto-split)* by default
- **Input Scaling** and **Crop Size** — resolution the model sees. Size the crop
  from [Instance Size Distribution](instance-size.md), not from a guess
- **Convert Colors** — RGB, grayscale, or auto-detect from the video
- **Data Pipeline** — stream, in-memory, or on-disk caching. Memory is fastest
  when the dataset fits; stream is safe when it doesn't

### Model

- **Backbone** — **UNet** (default), **ConvNeXt**, or **Swin Transformer**
- **Filters**, **Filters Rate**, **Max Stride**, **Middle Block** — network capacity
- **Checkpoint** / **Fine-tune (start from prior weights)** — start from an
  existing model instead of from scratch

### Optimization

- **Epochs** — start at 5 for a first end-to-end run, then raise to ~200
- **Batch Size**, **Initial Learning Rate**
- **LR Scheduler** with patience, factor, cooldown, and min/end LR
- **Online Mining** with hard/easy ratios, for datasets with a few very hard frames

### Augmentation

Rotation, scaling, brightness, contrast, and Gaussian noise. Augmentation is
usually the cheapest accuracy you can buy on a small labeled set.

### Hardware

- **Accelerator**, **Number of Devices**, **Multi-GPU Strategy**
- **Dataloader Workers**

The panel also shows an **Estimated Memory Usage** breakdown — weights,
gradients, activations, image cache, batch images — so you find out that a
configuration won't fit *before* you start the run rather than at epoch 1.

### Logging

Enable **Weights & Biases** with an entity, group, and run name, or leave it off.
Offline mode is available.

## Running

Click **Start Training** (or **Start Remote Training** with a worker selected).
While it runs:

- The **progress display** shows epochs and status
- The **loss viewer** plots training and validation curves live — click the graph
  icon next to a model's progress
- The **log terminal** shows raw `sleap-nn` output
- **Error output** surfaces failures without making you dig through the log

You can **stop** a run in progress. **Train Again** re-opens the same
configuration for the next round.

## Post-training inference

**Inference Target** tells the app what to predict on as soon as training
finishes:

- Nothing (skip inference)
- Suggested frames
- User-labeled frames
- Frames with predictions
- Random sample (current video / all videos)
- Entire current video
- All videos

!!! warning "Set it before you start"

    The field is disabled once training is running. Choosing a target here is
    what turns a finished model straight into frames you can correct.

## After training

- **Predict ▸ Evaluation Metrics for Trained Models…** — accuracy metrics for
  models you've trained, with detailed per-node breakdowns
- **Predict ▸ Visualize Model Outputs…** — confidence maps, part affinity fields,
  and class maps rendered over your frames, which is how you diagnose *why* a
  model is wrong rather than just *that* it is
- **Predict ▸ Export Labels Package…** — bundle labels and frames for training
  elsewhere

Then go correct the predictions and train again. See
[Inference](inference.md).
