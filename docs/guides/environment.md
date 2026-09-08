# Environment Setup

Labeling needs nothing installed. **Training and inference** need
[sleap-nn](https://nn.sleap.ai), which is Python — and the desktop app can set
that up for you.

!!! info "Desktop only"

    The **Environment** panel exists only in the desktop app, because it has to
    run processes on your machine. In the browser, use a
    [remote worker](remote-compute.md) instead.

## What it does

The **Environment** panel manages a Python toolchain through
[`uv`](https://docs.astral.sh/uv/), so you never touch conda, pip, or a shell:

1. **Installs `uv`** if you don't have it, via the official installer.
2. **Provisions a Python interpreter** — install a version, or point at one you
   already have.
3. **Installs `sleap-nn` and `sleap-rtc`** as isolated `uv` tools, so they cannot
   collide with anything else on your system.

The panel shows each piece as detected / not detected, with a button to fix it.

## GPU detection

When installing `sleap-nn`, the app detects your GPU and picks the matching
PyTorch build automatically — you do not choose a CUDA version by hand.

If you plan to [export models](inference.md#exporting-a-model) to ONNX or
TensorRT, use the **Advanced** options to reinstall `sleap-nn` with the export
extras included.

## Channels and updates

`sleap-nn` can track:

- **Stable** — the latest release
- **Latest** — newest release or pre-release
- **Dev (main)** — the development branch

The panel tells you when a newer version is available on your channel, links to
its release notes, and offers **Update** or **Force reinstall**. `uv` itself can
be updated from the same place.

## No GPU?

Two options:

- **Train on CPU** — fine for a tiny sanity-check run, painful for anything real.
- **Use a remote worker** — submit the job to a machine that does have a GPU. This
  works from the browser too. See [Remote Compute](remote-compute.md).

## Checking what the app sees

**Help ▸ Collect Diagnostics…** gathers the runtime, versions, detected GPU,
environment state, and recent session log into a single file you can attach to a
bug report. Look there first when training refuses to start.
