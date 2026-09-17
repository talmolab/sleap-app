# Installation

**In the browser** there is nothing to install — open
[app.sleap.ai](https://app.sleap.ai) and you have the full labeling interface.

**On the desktop** one command does it. Install that when you want native file
dialogs, direct access to files on disk, local GPU training and inference, or
offline use; [Browser vs Desktop](reference/browser-vs-desktop.md) lists the
exact differences.

---

## Desktop app

=== "macOS / Linux"

    ```bash
    curl -fsSL https://app.sleap.ai/install.sh | sh
    ```

=== "Windows"

    ```powershell
    irm https://app.sleap.ai/install.ps1 | iex
    ```

That is the whole install. The script picks the right artifact for your platform
and architecture — a universal `.dmg` on macOS, an `.AppImage` on Linux, an NSIS
installer on Windows — and puts the app where it belongs.

Prefer to click through a download? Every artifact is on the
[Releases page](https://github.com/talmolab/sleap-app/releases).

---

## Release channels

The app is published to several URLs at once. Which one you use decides how new
and how stable your build is — and the desktop app's in-app updater follows the
channel it was installed from.

| Channel | Web | Desktop installer |
|---|---|---|
| **Stable** — full releases only | [app.sleap.ai](https://app.sleap.ai) | `app.sleap.ai/install.sh` |
| **Latest** — highest version, release *or* pre-release | [/latest/](https://app.sleap.ai/latest/) | `app.sleap.ai/latest/install.sh` |
| **Dev** — rolling, refreshed nightly | [/dev/](https://app.sleap.ai/dev/) | `app.sleap.ai/dev/install.sh` |
| **Main** — tip of `main`, rebuilt on every merge | [/main/](https://app.sleap.ai/main/) | — *web only* |
| **`<tag>`** — one release, never republished; cite this one | [/v0.1.2-2/](https://app.sleap.ai/v0.1.2-2/) | — *web only* |

To install a channel other than stable, use the same command from
[Desktop app](#desktop-app) with that URL swapped in — nothing else changes:

=== "macOS / Linux"

    ```bash
    curl -fsSL https://app.sleap.ai/dev/install.sh | sh
    ```

=== "Windows"

    ```powershell
    irm https://app.sleap.ai/dev/install.ps1 | iex
    ```

### Knowing what you're running

**Help ▸ About SLEAP Label** reports the exact version and channel. The version is
also in the window title.

Versions are stamped by CI from the release tag rather than committed to the
repository, so the version a build reports is always the version it actually is.
`/main/` builds report `<highest-tag>+main.<sha>`, which names the exact commit.

---

## Updating

The desktop app checks its own release channel for updates and shows an indicator
in the title bar when one is available. Accepting it downloads and swaps the app
in place; on Linux this works for the `.AppImage` payload without root.

You are not locked into the channel you installed from. The **Environment**
panel has a **Channel** dropdown — *Stable*, *Latest*, *Dev (main)* — and
changing it re-points the updater. If the channel you pick is on an older
version than the one running, the button reads **Switch** rather than
**Update**, and takes you down to it.

The browser app has nothing to update — reload the page.

---

## Environment setup

Labeling needs nothing installed. **Training and inference** need
[sleap-nn](https://nn.sleap.ai), which is Python — and the desktop app can set
that up for you.

!!! info "Desktop only"

    The **Environment** panel exists only in the desktop app, because it has to
    run processes on your machine. In the browser, use a
    [remote worker](guides/remote-compute.md) instead.

### What the Environment panel does

It manages a Python toolchain through [`uv`](https://docs.astral.sh/uv/), so you
never touch conda, pip, or a shell:

1. **Installs `uv`** if you don't have it, via the official installer.
2. **Installs `sleap-nn` and `sleap-rtc`** as isolated `uv` tools, so they cannot
   collide with anything else on your system.

You do not need to pick a Python interpreter — `uv` resolves a suitable one on its own
and downloads a managed Python if it needs to. Each piece shows as detected /
not detected, with a button to fix it.

The **Advanced** options are there if you want to override that: choose a
specific interpreter that `uv` found, or install a particular Python version for
it to use.

### GPU detection

When installing `sleap-nn`, the app detects your GPU and picks the matching
PyTorch build automatically — you do not choose a CUDA version by hand.

If you plan to [export models](guides/inference.md#exporting-a-model) to ONNX or
TensorRT, use the **Advanced** options to reinstall `sleap-nn` with the export
extras included.

### Keeping sleap-nn up to date

The panel reports the installed `sleap-nn` version, links to its release notes,
and offers **Update** or **Force reinstall**. `uv` itself can be updated from the
same place.

!!! tip "No GPU? No problem"

    **Train on CPU** — fine for a tiny sanity-check run, painful for anything
    real. Or point the app at a **remote worker** with a GPU and submit training
    and inference jobs to it over an encrypted peer-to-peer connection, which
    works from the browser too. See [Remote Compute](guides/remote-compute.md).

### Checking what the app sees

**Help ▸ Collect Diagnostics…** gathers the runtime, versions, detected GPU,
environment state, and recent session log into a single file you can attach to a
bug report. Look there first when training refuses to start.

---

[Troubleshooting](help/troubleshooting.md)
