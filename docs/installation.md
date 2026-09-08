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
[Releases page](https://github.com/talmolab/sleap-app/releases), and macOS builds
are signed with a Developer ID and notarized by Apple, so the `.dmg` works on its
own. The script is a convenience on top of that, not a workaround.

??? tip "What the script does that a manual download doesn't"

    - Skips even the one-time "downloaded from the Internet" prompt, because
      `curl` never sets `com.apple.quarantine`.
    - Replaces the app **atomically** — stages alongside, then renames.
    - Refuses to overwrite a running copy, so you cannot lose unsaved labels.

    Linux also gets a `.deb` and an `.rpm`, and Windows an `.msi`, if you would
    rather install one of those yourself.

??? warning "Platform caveats"

    **Windows** — SmartScreen may warn, because the installer is not signed with
    an EV certificate. The warning has a **More info → Run anyway**.

    **Linux** — nothing gates the install. The script prefers the `.AppImage`,
    because that is the only Linux payload the in-app updater can replace without
    root. Set `SLEAP_PREFER_DEB=1` if you would rather have the `.deb` in your
    package manager.

??? example "Install a specific version, or a file you already downloaded"

    Each release channel serves its own copy of the installer and defaults to
    that channel. `--tag` / `--pre` (or `-Tag` / `-Pre`) always override the
    default — see [Release channels](#release-channels).

    ```bash
    # A specific release tag (pre-releases included when named explicitly)
    curl -fsSL https://app.sleap.ai/install.sh | sh -s -- --tag v0.1.2

    # The newest build even if it is a pre-release
    curl -fsSL https://app.sleap.ai/install.sh | sh -s -- --pre

    # Read it before you run it
    curl -fsSL https://app.sleap.ai/install.sh | less
    ```

    Point the script at a local path to install a `.dmg`, `.deb`, `.AppImage`,
    `.rpm`, or the `.zip` straight off a GitHub Actions artifact page. This route
    also strips the quarantine flag.

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

| You are | Use | Web | Desktop installer |
|---|---|---|---|
| Doing science with this | **Stable** — and cite the `/<tag>/` URL | [app.sleap.ai](https://app.sleap.ai) | `app.sleap.ai/install.sh` |
| Wanting new features early | **Latest** — highest version, release *or* pre-release | [/latest/](https://app.sleap.ai/latest/) | `app.sleap.ai/latest/install.sh` |
| Testing, or asked to reproduce a fix | **Dev** — rolling, refreshed nightly | [/dev/](https://app.sleap.ai/dev/) | `app.sleap.ai/dev/install.sh` |

Two more web-only paths: [/main/](https://app.sleap.ai/main/) tracks the tip of
`main` on every merge, and `app.sleap.ai/<tag>/` serves one specific release
permanently — e.g. `/v0.1.2-1/`. Tagged paths are never touched again once
published, so a link to one in a methods section keeps working *and* keeps
behaving identically.

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

??? failure "If macOS refuses to open the app"

    You should not hit this on a release build. If you do — most likely a build
    from a fork or a PR, which get no signing secrets and fall back to ad-hoc
    signing — clear the quarantine tag on the **`.dmg`, before opening it**,
    which stops the tag propagating to the app in the first place:

    ```bash
    xattr -dr com.apple.quarantine ~/Downloads/SLEAP_*.dmg
    ```

    If you already tried and got blocked, clear it on the installed app instead:

    ```bash
    xattr -dr com.apple.quarantine /Applications/SLEAP.app
    ```

    The GUI route is **System Settings → Privacy & Security → Security → Open
    Anyway**, which needs your login password and only offers itself for about an
    hour after a blocked launch. Control-click → Open no longer works — Apple
    removed that bypass in macOS 15.

    Two dialogs are worth telling apart. "Apple could not verify…" means a valid
    signature that is not notarized. "**SLEAP is damaged and can't be opened**"
    means an *invalid* signature, and has no override at all — if you ever see
    that on a release build, please
    [report it](https://github.com/talmolab/sleap-app/issues/new).

More in [Troubleshooting](help/troubleshooting.md).
