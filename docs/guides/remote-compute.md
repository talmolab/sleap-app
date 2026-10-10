# Remote Compute

You can run training and inference on a machine that isn't the one you're
labeling on — a lab workstation, a shared GPU box, a cluster node. That way you
can train from a laptop with no Python and no GPU. It works from the desktop app,
and from the browser where the browser allows the connection (see
[How the connection runs](#how-the-connection-runs)).

The machine doing the work is a **worker**: it runs
[sleap-rtc](https://github.com/talmolab/sleap-connect) (from the sleap-connect project) and sleap-nn. There is no
account, login, or server in between. You pair the app with a worker once, using
a one-line code, and after that the app connects to it directly.

## Pairing a worker

On the GPU machine, start the worker, then ask it for a pairing code:

```bash
sleap-rtc serve
sleap-rtc pair
```

`sleap-rtc serve --daemonize` keeps the worker running in the background.
`sleap-rtc pair` prints a one-line code that starts with `sleap1`.

In the app:

1. Open the **Connect** panel.
2. Click **Pair a new worker**. (With no workers paired yet, the form is already
   open.)
3. Paste the code and click **Pair**.

Fill in **Worker address** only if the code has none — for example
`ws://192.168.1.42:9631`. Codes expire; if pairing says yours has, run
`sleap-rtc pair` again.

Pairing connects you right away. The worker is remembered, so next time you just
pick it — no new code needed. The trash button on a worker's card in the
**Connect** panel forgets it.

!!! note "Each device pairs on its own"

    Pairing is per device, not per person. The app keeps its own key on this
    computer (or in this browser), and the worker remembers that key when you
    pair. A second computer, or a different browser, has to be paired separately.

### How the connection runs

| Transport | Where | What it is |
|---|---|---|
| **WebSocket** | Browser and desktop | A `ws://` connection to the worker's address. The default. |
| **iroh (direct)** | Desktop only | A QUIC connection to the worker's ID. Offered only when the pairing code includes iroh details. |

When a code offers iroh, the desktop pairing form shows **Connect directly (iroh)
— this code includes a direct address**, and the worker's card in the
**Connect** panel offers both
**Connect (WebSocket)** and **Connect directly (iroh)**. The browser always uses
WebSocket. Wherever the app shows connection status it says which one is in use
(`via WebSocket` or `via iroh (direct)`).

!!! warning "Browser on app.sleap.ai"

    app.sleap.ai is served over HTTPS, and browsers may block a secure page from
    opening a plain `ws://` connection to another machine. If pairing or
    connecting fails from the browser while the worker is running, use the
    desktop app, which doesn't have this restriction.

Every connection is checked both ways. The worker proves it holds the identity
you paired with, and the app proves it is the device the worker paired. If the
address now answers as a different worker — say the machine was reinstalled or
the IP moved to another box — the app refuses it. The worker's card in the Connect window shows **has a
new identity** with a **Re-pair** button; get a fresh code with `sleap-rtc pair`
and paste it there.

### Dropped connections

If the connection drops, the app reconnects on its own with increasing waits and
shows **Reconnecting…** meanwhile. On desktop, if a WebSocket connection stays
down for about 10 seconds and the worker offers iroh, the app switches to iroh,
then moves back to WebSocket once that works again. Jobs keep running on the
worker throughout.

## Running a job

=== "Desktop"

    In the **Training** or **Inference** panel, open the **Remote** section and
    pick the worker under **Backend**. The default is **Local (this machine)**.
    Picking a worker connects to it. The start button becomes **Start Remote
    Training** or **Run Remote Inference**.

=== "Browser"

    Training and inference always run on a worker. Until you're connected, the
    Training panel says **Connect to a worker in the Connect tab to start remote
    training** (the Inference panel says the same for inference). Connect from
    the worker's card in the **Connect** panel.

Everything else — the configuration, progress, live loss curves, the log — works
as it does for a local run.

### Training on your current labels

Under **Data ▸ Training Labels** you choose what the worker trains on:

- **This window** (the default) — sends the labels open in this window,
  **unsaved edits included**. You don't need to save or copy anything first.
- **A file on *worker*** — a `.slp` already on the worker. Pick it with the
  folder button.

With **This window**, the app checks which of your videos the worker can see and
shows **Videos N/M visible on *worker***:

- A video the worker can see is used from the worker's copy.
- A video it can't see has only its **labeled frames** embedded in the upload —
  never the whole video. Before starting, a dialog lists these videos and their
  frame counts.
- **Locate on worker…** next to a hidden video lets you browse the worker for
  its copy. The app remembers that location and applies it to other videos in
  the same folder.

Post-training inference can only run on videos the worker can see. When it
can't see some of them, the summary says so (for example **Training only —
videos not visible**). If you're predicting **Suggested frames**, the dialog
offers to **Also embed** those frames so they can be predicted too.

!!! warning "Upload size"

    Embedded frames add up. Above 10 MB the app asks before sending (**Large
    upload** ▸ **Send anyway**). Above 150 MB it refuses: put the videos where
    the worker can read them, or locate them on the worker, then try again.

### Inference

Remote inference runs on files already on the worker. In the **Inference**
panel, set **Data Path (on worker)** to a `.slp` or video on the worker and add
model folders with **Browse Worker**.

### While it runs

A remote training run starts as a compact card with each model's epoch and loss.
**Watch Live** switches to the full progress view and loss plot. **Open in
Connect** jumps to the job in the Connect window. The job runs on the worker, so
you can close the app; when you're connected and the job finishes, a
notification appears with an **Open** button.

- **Stop Early** ends training and saves a checkpoint.
- **Cancel** terminates immediately.

On desktop, if you reconnect to a worker that still has a job this device
started in an earlier session, the **Remote** section tells you and offers
**Cancel it**.

### Getting predictions back

After remote training, the app submits post-training inference as its own job on
the worker, using the **Post-Training Inference Target** you chose (**Nothing
(skip inference)** skips it). Predictions are not pulled in automatically: click
**Fetch & Load Predictions** in the Training panel to merge them into your
project. For a remote inference run, the Inference panel's button is **Fetch &
Load Results**.

## The Connect window

**Open Connect window** in the Connect panel shows every paired worker and the
jobs on it. Browsing here never changes which worker the Training and Inference
panels use.

### Workers

Each worker card shows a status — **Idle**, **Busy**, or **Offline** (also
**Connecting…** / **Reconnecting…**) — and, once known, its GPU model, memory,
count, CUDA version and sleap-nn version. Filter chips narrow the list by
status. **+ Pair worker** opens the same pairing form as the Connect panel.

### Jobs tab

Lists every job on the selected worker, refreshed every 10 seconds. This
project's jobs come first, marked ★. Jobs from other projects can be watched
but not stopped.
Search by labels file, job ID, run ID, or model.

- **Watch live** (running) or **View** (finished) replays the job from the
  worker's history: loss plot under **Monitor**, output under **Logs**, with
  **Copy** and an **Errors only** filter.
- **Stop** (running) or **Cancel** (queued) ends one of your jobs.
- **Run again** re-opens a failed training run with its configuration.
- **Fetch & Load** on a finished inference job opens **Load predictions**:
  **Merge matching** into the open project, **Open predictions**, or **Download
  .slp**. A job that clearly matches the open project merges right away.
- The trash button (**Remove this run**) clears a finished run from the worker's
  job list. Nothing is deleted from disk: trained models, logs and predictions
  stay on the worker, and your labels and videos aren't touched.

**+ New job** starts a training or inference job on data that already lives on
the worker — no upload from this computer. Choose **Train** or **Inference**,
browse to a `.slp` on the worker, set up the run, then **Add to queue**. Each
worker runs jobs from a queue; a waiting job shows **Queued · #N**. You can keep
adding jobs (**Add another**) and follow jobs on several workers at once.

### Data access tab

- **Folders this worker shares** — the folders the worker can see, set with
  `--mount` on the worker. The file browser only reaches inside these.
- **Remembered locations** — the local-to-worker folder matches saved when you
  used **Locate on worker…**. **Clear** forgets one.

## Which route should I use?

| Situation | Route |
|---|---|
| Desktop app, local GPU | Local — see [Environment setup](../installation.md#environment-setup) |
| Browser, or no local GPU | Remote worker |
| Big dataset already sitting on the GPU machine | Remote worker — start it from **+ New job** and the data never moves |
| No network, no shared machine | Local (CPU if you must) |
