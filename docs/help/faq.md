# FAQ

## Do I need to install anything?

No. [app.sleap.ai](https://app.sleap.ai) is the full labeling app. Install the
[desktop build](../installation.md) if you want native file access, local GPU
training, or offline use.

## Do I need Python?

Not for labeling. Training and inference need
[sleap-nn](https://nn.sleap.ai) — either installed locally through the
[Environment panel](../guides/environment.md) (desktop, no conda required) or
running on a [remote worker](../guides/remote-compute.md) you connect to.

## Is my data uploaded anywhere?

No. The browser app runs entirely on your machine — files are read and written
locally through the browser's file-system APIs, and nothing is sent to a server.

The exception is deliberate: if you connect to a
[remote worker](../guides/remote-compute.md), the files that job needs go to that
worker, over an encrypted peer-to-peer channel you authenticated to.

## Can I open files from the legacy SLEAP GUI?

Yes. `.slp` is the same format. You can label here, analyze in Python with
[sleap-io](https://io.sleap.ai), and open the same file in the Qt GUI, without
converting.

## Are the keyboard shortcuts the same as SLEAP?

Yes — they follow SLEAP's defaults. See the
[shortcuts reference](../reference/shortcuts.md).

## My video won't play

Most likely a codec WebCodecs can't decode. The desktop app transcodes these for
you; in the browser, convert first. See
[Troubleshooting](troubleshooting.md#video-wont-play).

## How many frames should I label before training?

Fewer than you'd think for the *first* run — label one frame completely, train
for 5 epochs, and see what happens end to end. Then correct predictions instead
of labeling from scratch. See
[Your First Labels](../getting-started/first-labels.md).

## Which model type should I use?

**Top-Down** for multiple animals, **Single Animal** for one. Bottom-up needs a
fully connected skeleton and suits crowded scenes. The `+ ID` variants add
learned identity. See [Training](../guides/training.md#model-types).

## What crop size should I use?

Run **Analyze ▸ Instance Size Distribution**, set the rotation preset to match
your planned augmentation, and take the 95th or 99th percentile. See the
[guide](../guides/instance-size.md).

## Can I train without a GPU?

Technically yes, practically no for anything real. Use a
[remote worker](../guides/remote-compute.md) instead — it works from the browser.

## Will I lose work if the app crashes?

The app keeps a background draft of unsaved changes and offers to restore it on
next launch. It's a safety net, not a substitute for ++cmd+s++. See
[Saving & Recovery](../guides/saving.md).

## How do I know which version I'm running?

**Help ▸ About SLEAP Label**, or the window title. See
[Release channels](../installation.md#release-channels).

## Can I cite a specific version?

Yes — every release gets a permanent URL like `app.sleap.ai/v0.1.2-1/` that is
never modified afterwards. Cite that rather than the bare domain.

## Where do I report bugs?

**Help ▸ Report Issue**, or
[the issue tracker](https://github.com/talmolab/sleap-app/issues). Attach the
output of **Help ▸ Collect Diagnostics…**.
