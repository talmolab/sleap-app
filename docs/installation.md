# Installation

There is nothing to install to use SLEAP App. Open
[app.sleap.ai](https://app.sleap.ai) in any modern browser and you have the full
labeling interface.

Install the **desktop app** when you want native file dialogs, direct access to
files on disk, local GPU training and inference, or offline use. See
[Browser vs Desktop](reference/browser-vs-desktop.md) for the exact differences.

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

The installer picks the right artifact for your platform and architecture. macOS
builds are universal, so one `.dmg` covers both Apple Silicon and Intel. Linux
gets a `.deb`, an `.AppImage` and an `.rpm`; Windows gets an NSIS installer and
an `.msi`.

### Why use the installer?

You can always download an installer straight from the
[Releases page](https://github.com/talmolab/sleap-app/releases) — macOS builds
are signed with a Developer ID and notarized by Apple, so the `.dmg` works on its
own. The script is a convenience on top of that, not a workaround. It:

- skips even the one-time "downloaded from the Internet" prompt, because `curl`
  never sets `com.apple.quarantine`
- replaces the app **atomically** (stages alongside, then renames)
- refuses to overwrite a running copy, so you cannot lose unsaved labels
- picks the right artifact for your platform and architecture automatically

!!! note "Platform caveats"

    **Windows** — SmartScreen may warn, because the installer is not signed with
    an EV certificate. The warning has a **More info → Run anyway**.

    **Linux** — nothing gates the install. The script prefers the `.AppImage`,
    because that is the only Linux payload the in-app updater can replace without
    root. Set `SLEAP_PREFER_DEB=1` if you would rather have the `.deb` in your
    package manager.

### Install a specific version

Each release channel serves its own copy of the installer, defaulting to that
channel. `--tag` / `--pre` (or `-Tag` / `-Pre`) always override the default.

```bash
# A specific release tag (pre-releases included when named explicitly)
curl -fsSL https://app.sleap.ai/install.sh | sh -s -- --tag v0.1.2

# The newest build even if it is a pre-release
curl -fsSL https://app.sleap.ai/install.sh | sh -s -- --pre

# Read it before you run it
curl -fsSL https://app.sleap.ai/install.sh | less
```

See [Release channels](#release-channels) below for what each channel URL points at.

### Install a file you already downloaded

Works with a `.dmg`, `.deb`, `.AppImage`, `.rpm`, or the `.zip` straight off a
GitHub Actions artifact page. This path also strips the quarantine flag.

=== "macOS / Linux"

    ```bash
    curl -fsSL https://app.sleap.ai/install.sh -o install.sh
    sh install.sh ~/Downloads/SLEAP_0.1.2_universal.dmg
    sh install.sh ~/Downloads/sleap-app-macos-universal.zip
    ```

=== "Windows"

    ```powershell
    irm https://app.sleap.ai/install.ps1 -OutFile install.ps1

    # Windows clients default to an ExecutionPolicy of Restricted, which refuses
    # to run ANY .ps1 -- so invoke it explicitly rather than as `.\install.ps1`.
    # This bypasses the policy for one process only; nothing changes machine-wide.
    powershell -ExecutionPolicy Bypass -File .\install.ps1 `
      -Path $HOME\Downloads\sleap-app-windows.zip

    # `| iex` cannot forward parameters, so build a script block for -Tag / -Pre.
    # (This route is unaffected by ExecutionPolicy -- nothing is written to disk.)
    & ([scriptblock]::Create((irm https://app.sleap.ai/install.ps1))) -Tag v0.1.2
    ```

`install.sh --help` and `Get-Help .\install.ps1` list the rest (`--prefix`,
`--force`, `-Interactive`).

---

## Release channels

The app is published to several URLs at once. Which one you use decides how new
and how stable your build is — and the desktop app's in-app updater follows the
channel it was installed from.

### Web

| URL | Serves |
|---|---|
| [app.sleap.ai](https://app.sleap.ai) | The current **stable** release |
| [app.sleap.ai/latest/](https://app.sleap.ai/latest/) | The highest version, release **or** pre-release |
| [app.sleap.ai/dev/](https://app.sleap.ai/dev/) | The rolling **dev** build, refreshed nightly |
| [app.sleap.ai/main/](https://app.sleap.ai/main/) | The tip of `main`, on every merge |
| `app.sleap.ai/<tag>/` | One specific release, permanently — e.g. `/v0.1.2-1/` |

Tagged paths are never touched again once published, so a link to
`app.sleap.ai/v0.1.2-1/` in a methods section keeps working and keeps behaving
identically.

### Desktop

Each channel serves its own copy of the installer, defaulting to that channel:

```bash
curl -fsSL https://app.sleap.ai/install.sh | sh          # stable
curl -fsSL https://app.sleap.ai/latest/install.sh | sh   # newest, incl. pre-releases
curl -fsSL https://app.sleap.ai/dev/install.sh | sh      # rolling dev
```

`--tag` and `--pre` (or `-Tag` / `-Pre` in PowerShell) always override the
baked-in default — see [above](#install-a-specific-version).

### Which should I use?

| You are | Use |
|---|---|
| Doing science with this | **Stable** — and cite the `/<tag>/` URL |
| Wanting new features early | **Latest** |
| Testing, or asked to reproduce a fix | **Dev** |

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

The browser app has nothing to update — reload the page.

---

## Python backend (optional)

Training and inference need [sleap-nn](https://nn.sleap.ai), which is Python. The
desktop app can install and manage it for you through the **Environment** panel —
it uses [`uv`](https://docs.astral.sh/uv/) to provision a Python interpreter and
install `sleap-nn` and `sleap-rtc` as isolated tools. You do not need a
pre-existing conda or pip environment.

See [Environment Setup](guides/environment.md).

!!! tip "No GPU? No problem"

    You can also point the app at a **remote worker** with a GPU and submit
    training and inference jobs to it over an encrypted peer-to-peer connection,
    from either the browser or the desktop app. See
    [Remote Compute](guides/remote-compute.md).

---

## Troubleshooting the install

<details markdown>
<summary>If macOS refuses to open the app</summary>

You should not hit this on a release build. If you do — most likely a build from
a fork or a PR, which get no signing secrets and fall back to ad-hoc signing —
clear the quarantine tag on the **`.dmg`, before opening it**, which stops the
tag propagating to the app in the first place:

```bash
xattr -dr com.apple.quarantine ~/Downloads/SLEAP_*.dmg
```

If you already tried and got blocked, clear it on the installed app instead:

```bash
xattr -dr com.apple.quarantine /Applications/SLEAP.app
```

The GUI route is **System Settings → Privacy & Security → Security → Open
Anyway**, which needs your login password and only offers itself for about an
hour after a blocked launch. Control-click → Open no longer works — Apple removed
that bypass in macOS 15.

Two dialogs are worth telling apart. "Apple could not verify…" means a valid
signature that is not notarized. "**SLEAP is damaged and can't be opened**" means
an *invalid* signature, and has no override at all — if you ever see that on a
release build, please [report it](https://github.com/talmolab/sleap-app/issues/new).

</details>

More in [Troubleshooting](help/troubleshooting.md).
