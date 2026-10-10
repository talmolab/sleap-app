# Training

The **Training** panel configures and runs [sleap-nn](https://nn.sleap.ai)
training without leaving the app. Runs go to a local GPU (desktop, see
[Environment setup](../installation.md#environment-setup)) or to a [remote worker](remote-compute.md).

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

The panel holds the settings you change most. Everything else lives in the
**Full Configuration...** dialog.

### In the panel

- **Model Type & Configs** — the **Model Type**, plus one config slot per model.
  A ★ marks the type recommended for your data; types that need skeleton edges
  are disabled until you add them. Each slot is filled in for you (from your
  most recent trained run when there is one, otherwise a baseline profile), and
  you can browse to a different config
- **Data**
    - **Training Labels** — which project to train on (defaults to the open one)
    - **Validation Labels (optional)** — leave empty for *Same as training
      (auto-split)*
    - **Post-Training Inference Target** — see
      [Post-training inference](#post-training-inference)
- **Hyperparameters** — **Max Epochs**, **Batch Size**, **Rotation
  Augmentation** (Off, ±15°, ±180°, Custom), and **Scale Augmentation**. For
  top-down, **Anchor Part** sits above them, and two-model pipelines get one tab
  per model. Start at 5 epochs for a first end-to-end run, then raise it
- **Remote** (desktop) — send the run to a [remote worker](remote-compute.md)
  instead of the local GPU
- **Estimated Memory Usage** — params, weights, batch images, activations,
  confidence maps, gradients, and image cache, so you find out that a
  configuration won't fit *before* you start the run rather than at epoch 1

### Full Configuration...

**Full Configuration...** opens the **Training Configuration** dialog: a
**Pipeline** tab, plus one tab per model. Use **Search parameters...** to jump to
a field. Edits save as you type; click **Done** to close, or **Reset to profile
defaults…** to start over.

The **Pipeline** tab:

| Section | What's in it |
|---|---|
| **Pipeline Type** | The pipeline, plus pipeline-wide fields such as **Anchor Part** and sigma |
| **Inference Target** | **Post-Training Inference Target**, **Skip user labeled frames**, and **Existing predictions** (Replace, Keep, Clear all) |
| **Pre/Post-proc.** | **Convert Colors** (Auto, RGB, Grayscale), **Max Instances**, **Filter Overlapping Instances** |
| **Performance** | **Data Pipeline** (Stream (no caching), Cache in Memory, Cache to Disk), **Dataloader Workers**, **Accelerator**, **Number of Devices**, **Multi-GPU Strategy** |
| **W&B** | **Enable WandB for logging**, **Offline Mode**, API key, entity, project, and group names |
| **Evaluation** | **Run evaluation during training** (mOKS, mAP, PCK) at a set epoch frequency |
| **Output** | **Run Name**, **Runs Folder**, **Checkpoint**, **Visualization**, and **Export Model** (convert to ONNX or TensorRT when training finishes) |
| **Remote Training** | Pick a [remote worker](remote-compute.md) for the run |

Each model's tab:

| Section | What's in it |
|---|---|
| **Data** | **Validation Fraction**, **Overfit Mode (train=val)**, **Random Seed**, **Input Scaling**, and **Crop Size**. Size the crop from [Instance Size Distribution](instance-size.md), not from a guess |
| **Augmentation** | **Rotation**, **Scale**, **Uniform Noise**, **Gaussian Noise**, **Contrast**, **Brightness**. Usually the cheapest accuracy you can buy on a small labeled set |
| **Optimization** | **Batch Size**, **Epochs**, **Initial Learning Rate**, **LR Scheduler**, **Stop Training on Plateau**, and **Online Mining** for datasets with a few very hard frames |
| **Model** | **Backbone** (UNet, ConvNeXt, Swin Transformer), **Max Stride**, **Filters**, **Filters Rate**, **Middle Block**, and more |

### Scratch, fine-tune, or resume

The top of each model's tab picks how the run starts:

| Option | What it does |
|---|---|
| **Train from scratch** | New weights. The default |
| **Fine-tune (start from prior weights)** | Starts from a `.ckpt` or `.h5` checkpoint and trains with your current settings. The **Model** section is locked to match the checkpoint |
| **Resume training (continue from checkpoint)** | Continues an interrupted run from its `.ckpt`. All settings are locked |

Fine-tune and Resume need a checkpoint path; **Start Training** stays disabled
until you set one.

## Running

Click **Start Training** (or **Start Remote Training** with a worker selected).
While it runs:

- Each model gets a **progress row** with its epoch count and loss. Click the row
  to open the **Training Monitor** — live training and validation loss curves,
  plus each epoch's sample predictions when **Visualize Predictions** is on
  (under **Output** ▸ **Visualization**)
- The **log** shows raw `sleap-nn` output — click it, or **Expand**, for the full
  log
- If a run fails, the **error output** shows why without making you dig through
  the log

To end a run early, use the buttons under the panel (also in the Training
Monitor):

- **Stop Early** — stops the current model and keeps its checkpoint. The run
  carries on: the next model of a top-down pair, then post-training inference
- **Cancel** — terminates immediately. Nothing after it runs

When training finishes:

- **View Metrics** — accuracy metrics for the models you just trained
- **Export Model…** (desktop) — convert the trained model to ONNX or TensorRT.
  See [Exporting a model](inference.md#exporting-a-model)
- **Train Again** — clears the finished run so you can start the next round

## Post-training inference

**Post-Training Inference Target** tells the app what to predict on as soon as
training finishes. The predictions are merged into the project automatically
(a remote run shows **Fetch & Load Predictions** instead):

- Nothing (skip inference)
- Suggested frames
- User labeled frames
- Frames with predictions
- Entire current video
- All videos
- Random sample (current video)
- Random sample (all videos)

!!! warning "Set it before you start"

    The field is disabled once training is running. Choosing a target here is
    what turns a finished model straight into frames you can correct.

## After training

- **Predict ▸ Evaluation Metrics for Trained Models…** — accuracy metrics for
  models you've trained, with detailed per-node breakdowns
- **Predict ▸ Set Overlay Models…**, then check **Predict ▸ Visualize Model
  Outputs** (desktop) — draws a model's confidence map over the current frame,
  which is how you diagnose *why* a model is wrong rather than just *that* it is.
  The checkbox stays disabled until you've set overlay models. Single-animal and
  top-down models are supported
- **Predict ▸ Export Labels Package…** — bundle labels and frames for training
  elsewhere

Then go correct the predictions and train again. See
[Inference](inference.md).
