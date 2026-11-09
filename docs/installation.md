# Installation

**In the browser** there is nothing to install — open
[app.sleap.ai](https://app.sleap.ai) and you have the full labeling interface.

**On the desktop** one command does it. Install that when you want native file
dialogs, direct access to files on disk, local GPU training and inference, or
offline use; [Browser vs Desktop](reference/browser-vs-desktop.md) lists the
exact differences.

**From source**, see [Development setup](#development-setup).

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
and architecture and puts the app where it belongs:

- **macOS** — the universal `.dmg`, installed to `/Applications` (or
  `~/Applications` if you can't write there)
- **Windows** — the NSIS installer
- **Linux** — the `.AppImage`, the one Linux build the app can update by itself.
  On RPM-based distributions without `dpkg` (Fedora, RHEL) it installs the
  `.rpm` instead; set `SLEAP_PREFER_DEB=1` to get the `.deb` on Debian or
  Ubuntu.

Prefer to click through a download? Every artifact is on the
[Releases page](https://github.com/talmolab/sleap-app/releases).

---

## Release channels

The app is published to several URLs at once. Which one you use decides how new
and how stable your build is. For the desktop app, the channel also decides
which updates it offers — see [Updating](#updating).

| Channel | Web | Desktop installer |
|---|---|---|
| **Stable** — full releases only | [app.sleap.ai](https://app.sleap.ai) | `app.sleap.ai/install.sh` |
| **Latest** — highest version, release *or* pre-release | [/latest/](https://app.sleap.ai/latest/) | `app.sleap.ai/latest/install.sh` |
| **Dev** — rolling, refreshed nightly | [/dev/](https://app.sleap.ai/dev/) | `app.sleap.ai/dev/install.sh` |
| **Main** — tip of `main`, rebuilt on every merge | [/main/](https://app.sleap.ai/main/) | — *web only* |
| **`<tag>`** — one release, never republished; cite this one | [/v0.1.2-2/](https://app.sleap.ai/v0.1.2-2/) | `install.sh --tag <tag>` — see below |

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

To install one exact release — pre-releases included — pass its tag:

=== "macOS / Linux"

    ```bash
    curl -fsSL https://app.sleap.ai/install.sh | sh -s -- --tag v0.1.2
    ```

=== "Windows"

    ```powershell
    # `| iex` cannot pass parameters, so build a script block first.
    & ([scriptblock]::Create((irm https://app.sleap.ai/install.ps1))) -Tag v0.1.2
    ```

### Knowing what you're running

**Help ▸ About SLEAP Label** reports the exact version and whether it is a
*Stable release*, *Pre-release*, or *Dev build*. The version is also in the
window title.

Release builds are stamped by CI from the release tag, so the version a build
reports is always the version it actually is.
`/main/` builds report `<highest-tag>+main.<sha>`, which names the exact commit.

---

## Updating

Open the **Environment** panel and click **Update**. The app downloads the new
version, swaps it in, and relaunches.

- **Channel** — the panel's dropdown (*Stable*, *Latest*, *Dev (main)*) picks
  which builds you get. Installed from `/latest/`? Switch it to **Latest**; the
  app starts on Stable.
- **Update badge** — a pulsing orange dot on the **Environment** button means a
  newer Stable release is out (or Latest, once you've picked it). Dev builds
  don't show it.
- **Linux `.deb` / `.rpm`** — update through your package manager. Only the
  `.AppImage` updates in place.

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
2. **Installs `sleap-nn` and the SLEAP Connect worker (`sleap-connect`)** as isolated `uv` tools, so they cannot
   collide with anything else on your system.

You do not need to pick a Python interpreter — `uv` resolves a suitable one on its own
and downloads a managed Python if it needs to. Each piece shows as detected /
not detected, with a button to fix it.

The **Advanced** options are there if you want to override that: choose a
specific interpreter that `uv` found, or install a particular Python version for
it to use.

### GPU detection

When installing `sleap-nn`, the app has `uv` detect your GPU and pick the
matching PyTorch build (`--torch-backend=auto`) — you do not choose a CUDA
version by hand.

If you plan to [export models](guides/inference.md#exporting-a-model) to ONNX or
TensorRT, use the **Extras** field in the panel's `sleap-nn` section: tick
**ONNX** and/or **TensorRT**, then click **Apply**, which reinstalls `sleap-nn`
with exactly those extras. **TensorRT** is greyed out where it can't be used —
on macOS ("Linux/Windows only") and on machines without an NVIDIA GPU.

### Keeping sleap-nn up to date

The panel reports the installed `sleap-nn` version, links to its release notes,
and offers **Update** or **Force reinstall**. `uv` itself can be updated from the
same place.

!!! tip "No GPU? No problem"

    **Train on CPU** — fine for a tiny sanity-check run, painful for anything
    real. Or pair the app with a **remote worker** that has a GPU and send
    training and inference jobs to it — this works from the browser too. See
    [Remote Compute](guides/remote-compute.md).

### Checking what the app sees

**Help ▸ Collect Diagnostics…** gathers the runtime, versions, detected GPU,
environment state, and recent session log into a single file you can attach to a
bug report. Look there first when training refuses to start.

---

## Development setup

To run the app from source, for example to work on it or try an unreleased
change, build it yourself. To send changes back, read
[Contributing](reference/contributing.md) next.

### Prerequisites

- [**bun**](https://bun.com) **1.3.14** (the version pinned in `.bun-version`).
  bun is the package manager and the runtime; the project has no npm/Node step.
- **git**.
- For the **desktop** build only:
    - a **Rust 1.95+** toolchain, from [rustup](https://rustup.rs). The dev-only
      `tauri-pilot` plugin uses edition 2024, so older toolchains fail.
    - the [Tauri system prerequisites](https://v2.tauri.app/start/prerequisites/)
      for your platform. On Linux, that's the packages below.

### Get the code

```bash
git clone https://github.com/talmolab/sleap-app.git
cd sleap-app
bun install
```

### Run it

=== "Browser"

    ```bash
    bun run dev          # http://localhost:5173
    ```

=== "Desktop"

    ```bash
    bun run fetch:ffmpeg # once: download the ffmpeg/ffprobe sidecars
    bun run tauri:dev
    ```

    The `ffmpeg`/`ffprobe` sidecars are not committed. Without them, Tauri fails
    with `resource path binaries/ffmpeg-<triple> doesn't exist`.

    If a browser `bun run dev` already holds port 5173, point the desktop app at
    that server instead of starting a second one:

    ```bash
    bun run tauri dev --config '{"build":{"beforeDevCommand":""}}'
    ```

### Build it

| Command | Produces |
|---|---|
| `bun run build` | Type check, then the browser build in `dist/` |
| `bun run tauri:build:local` | Desktop installers in `src-tauri/target/release/bundle/`, from a fresh clone. It fetches the ffmpeg sidecars on first run and skips the signed updater artifacts, which need a key only CI has |
| `bun run tauri:build` | What CI runs for releases |

### Linux system dependencies

```bash
sudo apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev \
  libjavascriptcoregtk-4.1-dev librsvg2-dev patchelf \
  libglib2.0-dev libayatana-appindicator3-dev libdbus-1-dev \
  gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
  gstreamer1.0-plugins-bad gstreamer1.0-gl \
  gstreamer1.0-alsa gstreamer1.0-pulseaudio
```

The GStreamer plugins are what the Linux WebView needs to open videos.

### Working on sleap-io.js too

The data model and SLP I/O come from
[`@talmolab/sleap-io.js`](https://iojs.sleap.ai). To develop against unpublished
changes, clone it next to this repo and link it:

```bash
git clone https://github.com/talmolab/sleap-io.js.git ../sleap-io.js
bun add file:../sleap-io.js
```

Vite detects whether `node_modules/@talmolab/sleap-io.js` is a local link or a
normal install. To go back to the published package, run
`bun add @talmolab/sleap-io.js@<version>`. CI always uses the published package,
so don't commit the `file:` link.

---

[Troubleshooting](help/troubleshooting.md)
