# Troubleshooting

!!! tip "Start here"

    **Help ▸ Collect Diagnostics…** bundles the runtime, versions, detected GPU,
    environment state, and recent session log into one file. Attach it to any
    bug report — it usually contains the answer.

    The **Notifications** panel keeps the messages that toasts showed and
    dismissed while you were looking elsewhere.

## Video won't play

**The codec isn't supported.** WebCodecs decodes 8-bit H.264, HEVC, VP8, VP9, and
AV1, plus MJPEG. Everything else — MPEG-1/2, Xvid/DivX, WMV, VC-1, and **10-bit**
H.264/HEVC — needs converting.

- **Desktop** — the app offers to transcode it once and caches the result.
- **Browser** — convert it yourself:

    ```bash
    ffmpeg -i input.avi -c:v libx264 -pix_fmt yuv420p output.mp4
    ```

    `-pix_fmt yuv420p` is the part that forces 8-bit.

**The file moved.** Use **File ▸ Replace Videos ▸ *(video)*** to re-point it.

## Labels look shifted from the animal

The labels are right, but the image under them is a different frame. This
happens with videos that don't seek reliably: jumping straight to a frame shows
a different image than playing up to it. Select the video in the **Videos**
panel and click **Check Frames…**; if it finds problems, re-encode the video
from the same dialog. See [Checking a video's frames](../guides/videos.md#checking-a-videos-frames).

## The project opens but frames are blank

The `.slp` references videos that aren't where it expects. Either replace the
video paths as above, or work from a `.pkg.slp`, which carries its frames inside
the file.

## Training won't start

- **"Label at least one frame before training"** — training needs user-labeled
  frames. Predictions don't count until you accept them.
- **sleap-nn not detected** — open the **Environment** panel and install it. See
  [Environment setup](../installation.md#environment-setup).
- **In the browser** — there is no local training. Connect to a
  [remote worker](../guides/remote-compute.md).

## Training runs on the CPU

Open the **Environment** panel and look at **Accelerator** under sleap-nn. It
shows what sleap-nn's own PyTorch can use, not just what the machine has:

| Accelerator shows | Means | Fix |
|---|---|---|
| **CUDA · 1 GPU** (green) | The NVIDIA GPU is in use | Nothing to fix |
| **CUDA**, with a **Driver** row saying *needs …* (orange) | The NVIDIA driver is too old for this PyTorch; training will fail when it starts | Update the driver from [nvidia.com/drivers](https://www.nvidia.com/drivers) |
| **CPU only (GPU not usable)** (orange) | An NVIDIA driver is installed, but sleap-nn got a CPU-only PyTorch | **Force reinstall** sleap-nn in the Environment panel, so it picks up a GPU build |
| **MPS (Apple Silicon)** (green) | The Mac's built-in GPU is in use | Nothing to fix |
| **CPU only** | No usable GPU: no NVIDIA driver, or a Mac without Metal support | Train on a [remote worker](../guides/remote-compute.md) with a GPU |

On Linux or Windows with an NVIDIA card, `nvidia-smi` in a terminal confirms the
driver is installed and sees the card. You don't need to install CUDA
yourself: the PyTorch that sleap-nn installs brings its own CUDA libraries,
and only the driver comes from your system.

## Installing sleap-nn takes a long time

Installing sleap-nn downloads PyTorch, which is large: several minutes is
normal, and 15 or more on a slow connection. Let it finish. If it fails, use
**Help ▸ Collect Diagnostics…** and attach the file to a bug report.

## Training runs out of memory

The Training panel's **Estimated Memory Usage** breakdown shows where it goes.
Reduce, roughly in this order: **batch size**, **crop size**, **input scaling**,
model **filters**. Switching **Data Pipeline** from memory to stream also helps
when the dataset itself is the problem.

## Predictions look wrong everywhere

Before retraining, run **Analyze ▸ Label Quality Check**. A systematic left/right
swap or a chain-order error in the labels produces exactly this, and no amount of
extra training fixes it. See [Label Quality Check](../guides/label-qc.md).

## Predictions are cut off at the edges

The crop is too small. Re-derive it from **Analyze ▸ Instance Size Distribution**
at the rotation setting you train with, and check your **anchor part** is central
and reliably visible.

## Identities keep swapping

That's a tracking failure, not a pose failure. ++cmd+t++ transposes two
instances' tracks. To find where it goes wrong, set the seekbar header to
**Min Centroid Proximity** or **Tracking Score** and look at the dips, and use
++cmd+e++ to walk track spawn frames. See [Tracks](../guides/tracks.md).

## Can't connect to a worker

- Check the worker is running: `sleap-connect serve` on the GPU machine. A worker
  that isn't shows **Offline** in the Connect window.
- **This pairing code expired** — run `sleap-connect pair` again and paste the new code.
- **This ticket has no worker address** — fill in **Worker address** under the code,
  for example `ws://192.168.1.42:9631`. This computer must be able to reach that
  address.
- **Has a new identity** — the address now answers as a different worker (it
  was reinstalled, or the IP moved). Click **Re-pair** on its card and paste a
  fresh code from `sleap-connect pair`.
- **Reconnecting…** — the app retries on its own. Jobs keep running on the
  worker meanwhile.
- **Busy** is not an error: the worker is running a job, and new jobs wait in
  its queue.
- If the worker can't see your videos, use **Locate on worker…**, or check the
  **Data access** tab for the folders it shares. See
  [Remote Compute](../guides/remote-compute.md).

## Save is slow

Saving a large `.pkg.slp` with embedded images uses a streaming writer that does
many small operations. Over a network share this is slow. Save locally, then copy.

## macOS refuses to open the app

macOS builds from v0.1.2 on are signed with an Apple Developer ID and notarized,
so a downloaded `.dmg` opens normally.

The block only affects older copies (v0.1.1 and earlier) and builds you made
yourself, which aren't notarized. For those, clear the quarantine flag on the
`.dmg` **before** opening it:

```bash
xattr -dr com.apple.quarantine ~/Downloads/SLEAP_*.dmg
```

Or install with the [installer script](../installation.md#desktop-app), which
clears the flag for you.

## The update won't apply

- **Linux** — only the `.AppImage` payload can be replaced in place without root.
  If you installed the `.deb` or `.rpm`, update through your package manager.
- **Windows** — the installer refuses to overwrite a running copy. Quit the app
  first.

## Something else

[Open an issue](https://github.com/talmolab/sleap-app/issues/new) with the
diagnostics file attached.
