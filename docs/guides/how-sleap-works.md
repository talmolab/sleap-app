# How SLEAP works

SLEAP is a few pieces working together. Knowing which piece does what tells you
where your data goes, and what you need installed for each step.

## The pieces

| Piece | What it does | Where it runs |
|---|---|---|
| **SLEAP App** (this app) | Labeling, proofreading, quality checks, and starting training and inference | In your browser, or as the desktop app |
| **[sleap-nn](https://nn.sleap.ai)** | Trains models and runs inference and tracking | Python, on your computer or on a remote worker |
| **[SLEAP Connect](remote-compute.md)** | Runs sleap-nn jobs on another machine for you | On the GPU machine, as a background worker |
| **[sleap-io](https://io.sleap.ai)** | Reads, writes and converts SLEAP files | Python, for your own analysis scripts |

The app reads and writes files itself, with
[sleap-io.js](https://iojs.sleap.ai), a version of sleap-io that runs in the
app. So labeling needs no Python at all. Python only comes in for training and
inference.

## Where each step runs

| Step | Browser | Desktop app |
|---|---|---|
| Labeling, proofreading, quality checks | In the browser | On your computer |
| Training and inference | On a [remote worker](remote-compute.md) | On your computer, via the [Environment panel](../installation.md#environment-setup), or on a remote worker |
| Your files | Stay on your computer | Stay on your computer |

Nothing goes to a SLEAP server: there isn't one. The only time data leaves your
computer is when you send a job to a worker you've paired with, and then only
what that job needs. See [Remote Compute](remote-compute.md).

## The workflow

Most projects go around the same loop:

1. **Label** a few frames: build a [skeleton](skeletons.md), pick frames with
   [suggestions](suggestions.md), and [place instances](labeling.md).
2. **Train** a model on them with sleap-nn ([Training](training.md)).
3. **Predict** on more frames ([Inference](inference.md)).
4. **Correct** the predictions and train again. Repeat until predictions rarely
   need fixing ([prediction-assisted labeling](suggestions.md#prediction-assisted-labeling)).
5. **Track** identities across frames while running inference on whole videos
   ([Tracks](tracks.md)).
6. **Proofread** the tracks for swaps and breaks
   ([common tracking mistakes](tracks.md#common-tracking-mistakes)).
7. **Export** the poses for analysis ([Import & Export](import-export.md)).

The [Tutorial](../tutorial/index.md) walks through this loop on a sample video.

Labeling by hand takes the most time, and the loop is what keeps it short: a
few hundred labeled frames (roughly 100–500) is typically enough for accurate
predictions across thousands, and each round of corrections improves the
model. See
[How many frames should I label?](../help/faq.md#how-many-frames-should-i-label-before-training)

## The project file

A project is one `.slp` file. It holds:

- the **skeleton**: the nodes and edges you label
- **paths to your videos**, not the videos themselves
- **labeled frames**, each with its **instances**: one pose per animal, either
  your own labels or a model's predictions
- **tracks**: the identities linking instances across frames
- **suggestions**: the frames picked for labeling

Because the videos aren't inside, moving a project to another computer means
moving the videos too, or pointing the project at them again (see
[Videos](videos.md#when-videos-move)). A **labels package** (`.pkg.slp`) embeds
the images of its frames, so it opens anywhere on its own.

Models trained in the desktop app are saved in a `models/` folder next to the
project. Models trained on a remote worker stay on the worker.

The same `.slp` opens in the legacy SLEAP GUI and in Python with sleap-io, so
you can move between them freely. See [File Formats](../reference/formats.md).
