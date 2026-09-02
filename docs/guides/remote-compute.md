# Remote Compute

You can run training and inference on a machine that isn't the one you're
labeling on — a lab workstation, a shared GPU box, a cluster node. This works
from the **browser** as well as the desktop app, which means you can train from a
laptop with no Python and no GPU.

The transport is [sleap-rtc](https://github.com/talmolab/sleap-rtc): a signaling
server introduces you to workers, and the actual job traffic runs over a WebRTC
data channel directly between you and the worker.

## Connecting

Open the **Connect** panel.

1. **Log in with GitHub**, or **import a private key** — a 32-byte Ed25519 key in
   URL-safe base64. Authentication to a worker is an Ed25519
   challenge-response: the worker sends a nonce, you sign it, nothing shared
   travels the wire.
2. **Select a room**. Rooms are how workers are grouped and shared.
3. Pick a **worker** from the list.

Each worker advertises its status (available / busy / offline), its GPU model,
memory and CUDA version, and the filesystem **mounts** it can see.

The panel tells you whether you got a **direct** peer-to-peer connection or fell
back to a **relay server** when WebRTC couldn't punch through. Both work; direct
is faster.

## Browsing the worker's filesystem

Jobs run on the worker, so their inputs must be paths *the worker* can see. The
**Browse Worker** button opens a remote file browser over the same data channel,
scoped to the mounts the worker exposes. Use it to pick training labels, model
directories, and inference inputs.

## Path resolution

When you submit a job for a project whose files live on your machine, the app has
to translate every path into the worker's view of the world. The **path
resolution** dialog lists each required file with its status and the resolved
worker path, and gives you:

- **Browse** for anything unresolved
- **Auto-detect in folder** — find the rest of a set once you've located one
- **Cascade fill** — when it works out the prefix difference (say your
  `/Users/you/data/` is the worker's `/mnt/lab/data/`), it applies that mapping
  to everything else

Learned mappings are remembered, so this is a one-time cost per machine pairing.

## Running a job

With a worker selected, the Training and Inference panels switch their buttons to
**Start Remote Training** and **Run Remote Inference**. Everything else — the
configuration, the progress display, the live loss curves, the log terminal — is
the same as a local run. Progress, logs, and completion stream back over the data
channel.

You can cancel or stop a remote job from the panel.

## Which route should I use?

| Situation | Route |
|---|---|
| Desktop app, local GPU | Local — see [Environment Setup](environment.md) |
| Browser, or no local GPU | Remote worker |
| Big dataset already sitting on the GPU machine | Remote worker — the data never moves |
| No network, no shared machine | Local (CPU if you must) |
