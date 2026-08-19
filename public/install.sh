#!/usr/bin/env sh
#
# SLEAP desktop installer (macOS / Linux).
#
#   curl -fsSL https://app.sleap.ai/install.sh | sh
#
# Why this exists: the desktop app is ad-hoc signed but not notarized (that needs
# a paid Apple Developer ID). A .dmg downloaded through a *browser* -- or handed
# over via Slack, email, or AirDrop -- gets tagged with com.apple.quarantine,
# which propagates to the app you copy out of it, and macOS then refuses to
# launch an un-notarized app that carries it. curl does not set that tag, so
# installing this way just works, with no Gatekeeper prompt at all.
#
# See `--help` for installing a file you already have, e.g. a .dmg or an
# artifact .zip downloaded from a GitHub Actions run.
#
# POSIX sh on purpose -- this is run via `curl | sh`, so no bashisms, and
# everything lives inside main(), which is invoked on the last line. That way a
# truncated download can never execute a half-read script.

set -eu

REPO="talmolab/sleap-app"
API="https://api.github.com/repos/talmolab/sleap-app"
APP="SLEAP" # macOS .app bundle name, and the dmg/deb/AppImage filename prefix

MOUNTPOINT=""
WORKDIR=""
RELEASE_JSON=""

# ---------------------------------------------------------------- helpers ----

cleanup() {
    # Detach before removing the workdir -- the mountpoint lives inside it, and
    # a failed copy would otherwise leave the volume mounted.
    if [ -n "$MOUNTPOINT" ] && [ -d "$MOUNTPOINT" ]; then
        hdiutil detach "$MOUNTPOINT" -quiet 2>/dev/null || true
    fi
    if [ -n "$WORKDIR" ] && [ -d "$WORKDIR" ]; then
        rm -rf "$WORKDIR"
    fi
}

die() {
    echo "Error: $*" >&2
    exit 1
}

have() {
    command -v "$1" >/dev/null 2>&1
}

usage() {
    cat <<EOF
SLEAP desktop installer

Usage:
  install.sh                     Install the latest release
  install.sh --tag v0.2.0        Install a specific release tag
  install.sh <file>              Install from a local .dmg, .deb, .AppImage,
                                 or a .zip containing one (e.g. an artifact
                                 downloaded from a GitHub Actions run)
  install.sh --help              Show this message

macOS installs to /Applications (falling back to ~/Applications if that is not
writable) and uses no sudo. Linux installs the .deb via dpkg when it can
elevate, otherwise drops the AppImage in ~/.local/bin.
EOF
}

fetch_stdout() {
    if have curl; then
        curl -fsSL "$1"
    elif have wget; then
        wget -qO- "$1"
    else
        die "curl or wget is required"
    fi
}

fetch_file() {
    echo "Downloading $(basename "$2")..."
    if have curl; then
        curl -fSL --retry 3 --retry-delay 2 -o "$2" "$1"
    elif have wget; then
        wget --tries=3 -O "$2" "$1"
    else
        die "curl or wget is required"
    fi
}

# First string value for a top-level key, without needing jq.
json_field() {
    printf '%s' "$1" |
        tr ',' '\n' |
        grep -m1 "\"$2\"[[:space:]]*:" |
        sed -e 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"//' -e 's/".*//'
}

# First release asset download URL whose filename matches a pattern.
asset_url() {
    printf '%s' "$1" |
        grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*"' |
        sed -e 's/.*"\(https[^"]*\)"$/\1/' |
        grep -- "$2" |
        head -1
}

deb_arch() {
    case "$(uname -m)" in
    x86_64 | amd64) echo "amd64" ;;
    aarch64 | arm64) echo "arm64" ;;
    *) die "unsupported architecture: $(uname -m)" ;;
    esac
}

# Does this release carry something installable on the current platform?
release_has_asset() {
    if [ "$(uname -s)" = "Darwin" ]; then
        [ -n "$(asset_url "$1" '\.dmg$')" ]
    else
        [ -n "$(asset_url "$1" "_$(deb_arch)\.deb$")" ] ||
            [ -n "$(asset_url "$1" "_$(deb_arch)\.AppImage$")" ]
    fi
}

# Sets RELEASE_JSON. Honors an explicit tag; otherwise prefers the stable
# latest release and falls back to the newest pre-release that has a build.
resolve_release() {
    want_tag="$1"

    if [ -n "$want_tag" ]; then
        RELEASE_JSON="$(fetch_stdout "$API/releases/tags/$want_tag")" ||
            die "no release tagged $want_tag in $REPO"
        return
    fi

    RELEASE_JSON="$(fetch_stdout "$API/releases/latest" 2>/dev/null || true)"
    if [ -n "$RELEASE_JSON" ] && release_has_asset "$RELEASE_JSON"; then
        return
    fi

    stable_tag="$(json_field "$RELEASE_JSON" tag_name)"
    if [ -n "$stable_tag" ]; then
        echo "Note: latest release $stable_tag has no build for this platform." >&2
    fi
    echo "Looking for the newest release that does..." >&2

    # /releases/latest skips pre-releases and drafts, so walk the full list.
    all="$(fetch_stdout "$API/releases?per_page=30")" ||
        die "could not reach the GitHub API (rate limited?)"

    for candidate in $(printf '%s' "$all" |
        grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' |
        sed -e 's/.*"\([^"]*\)"$/\1/'); do
        json="$(fetch_stdout "$API/releases/tags/$candidate" 2>/dev/null || true)"
        if [ -n "$json" ] && release_has_asset "$json"; then
            RELEASE_JSON="$json"
            return
        fi
    done

    die "no release in $REPO has a build for $(uname -s) $(uname -m) yet.
Browse https://github.com/$REPO/releases and pass one explicitly:
  install.sh --tag <tag>"
}

# ------------------------------------------------------------------ macOS ----

install_macos_dmg() {
    dmg_path="$1"

    if pgrep -f "/$APP.app/Contents/MacOS/" >/dev/null 2>&1; then
        die "$APP is currently running. Quit it and re-run this installer."
    fi

    MOUNTPOINT="$WORKDIR/mnt"
    mkdir -p "$MOUNTPOINT"
    hdiutil attach "$dmg_path" -nobrowse -readonly -quiet -mountpoint "$MOUNTPOINT" ||
        die "could not mount $dmg_path"

    [ -d "$MOUNTPOINT/$APP.app" ] || die "$dmg_path does not contain $APP.app"

    # /Applications is group-writable by admin users, so this normally needs no
    # sudo -- which matters, because `curl | sh` leaves stdin bound to the pipe
    # and sudo would have no way to prompt for a password.
    dest="/Applications"
    if [ ! -w "$dest" ]; then
        dest="$HOME/Applications"
        mkdir -p "$dest"
        echo "Note: /Applications is not writable; installing to $dest instead."
    fi

    if [ -e "$dest/$APP.app" ]; then
        echo "Removing existing $dest/$APP.app..."
        rm -rf "$dest/$APP.app"
    fi

    echo "Installing to $dest/$APP.app..."
    cp -R "$MOUNTPOINT/$APP.app" "$dest/"

    hdiutil detach "$MOUNTPOINT" -quiet
    MOUNTPOINT=""

    # Belt and braces: if this .dmg itself arrived through a browser, the copy
    # inherits com.apple.quarantine and Gatekeeper would gate the first launch.
    xattr -dr com.apple.quarantine "$dest/$APP.app" 2>/dev/null || true

    if have codesign; then
        if codesign --verify --deep --strict "$dest/$APP.app" >/dev/null 2>&1; then
            echo "Signature check: OK (ad-hoc signed)"
        else
            echo "Warning: code signature did not verify; the app may not launch." >&2
        fi
    fi

    echo ""
    echo "Installed $APP to $dest/$APP.app"
    echo ""
    echo "Launch it from Spotlight, or:"
    echo "  open -a \"$dest/$APP.app\""
}

install_macos_release() {
    url="$(asset_url "$1" '_universal\.dmg$')"
    if [ -z "$url" ]; then
        # Releases before the universal build was introduced were per-arch.
        case "$(uname -m)" in
        arm64 | aarch64) url="$(asset_url "$1" '_aarch64\.dmg$')" ;;
        *) url="$(asset_url "$1" '_x64\.dmg$')" ;;
        esac
    fi
    [ -n "$url" ] || die "no macOS .dmg in that release"

    dmg="$WORKDIR/$(basename "$url")"
    fetch_file "$url" "$dmg"
    install_macos_dmg "$dmg"
}

# ------------------------------------------------------------------ Linux ----

# True if sudo will work without hanging on a password prompt we cannot answer.
can_elevate() {
    [ "$(id -u)" = "0" ] && return 0
    have sudo || return 1
    sudo -n true 2>/dev/null && return 0
    [ -t 0 ] # only prompt when stdin is a terminal, not a curl pipe
}

install_linux_deb() {
    echo "Installing .deb package..."
    if [ "$(id -u)" = "0" ]; then
        dpkg -i "$1" || apt-get install -f -y
    else
        sudo dpkg -i "$1" || sudo apt-get install -f -y
    fi
    echo ""
    echo "Installed $APP. Launch it from your application menu."
}

install_linux_appimage() {
    install_dir="$HOME/.local/bin"
    mkdir -p "$install_dir"
    cp "$1" "$install_dir/$APP"
    chmod +x "$install_dir/$APP"

    echo ""
    echo "Installed $APP to $install_dir/$APP"
    case ":$PATH:" in
    *":$install_dir:"*) ;;
    *)
        echo ""
        echo "Note: $install_dir is not on your PATH. Add it with:"
        echo "  export PATH=\"$install_dir:\$PATH\""
        ;;
    esac
}

install_linux_release() {
    arch="$(deb_arch)"

    if have dpkg && can_elevate; then
        url="$(asset_url "$1" "_${arch}\.deb$")"
        if [ -n "$url" ]; then
            deb="$WORKDIR/$(basename "$url")"
            fetch_file "$url" "$deb"
            install_linux_deb "$deb"
            return
        fi
    fi

    url="$(asset_url "$1" "_${arch}\.AppImage$")"
    [ -n "$url" ] || die "no Linux .deb or .AppImage for $arch in that release"
    img="$WORKDIR/$(basename "$url")"
    fetch_file "$url" "$img"
    install_linux_appimage "$img"
}

# ------------------------------------------------------ local file install ----

install_local() {
    src="$1"
    [ -f "$src" ] || die "no such file: $src"

    case "$src" in
    *.zip)
        # GitHub Actions hands you a .zip of the build artifacts; look inside.
        have unzip || die "unzip is required to install from a .zip"
        echo "Extracting $(basename "$src")..."
        unzip -q -o "$src" -d "$WORKDIR/unzipped"
        inner="$(find "$WORKDIR/unzipped" -type f \
            \( -name '*.dmg' -o -name '*.deb' -o -name '*.AppImage' \) | head -1)"
        [ -n "$inner" ] ||
            die "no .dmg, .deb, or .AppImage inside $(basename "$src")"
        echo "Found $(basename "$inner")"
        install_local "$inner"
        ;;
    *.dmg)
        [ "$(uname -s)" = "Darwin" ] || die ".dmg can only be installed on macOS"
        install_macos_dmg "$src"
        ;;
    *.deb)
        have dpkg || die "dpkg not found; cannot install a .deb here"
        install_linux_deb "$src"
        ;;
    *.AppImage)
        install_linux_appimage "$src"
        ;;
    *)
        die "don't know how to install $(basename "$src")
(expected .dmg, .deb, .AppImage, or a .zip containing one)"
        ;;
    esac
}

# ------------------------------------------------------------------- main ----

main() {
    src=""
    tag=""

    while [ $# -gt 0 ]; do
        case "$1" in
        -h | --help)
            usage
            exit 0
            ;;
        --tag)
            shift
            [ $# -gt 0 ] || die "--tag requires a value"
            tag="$1"
            ;;
        --tag=*) tag="${1#--tag=}" ;;
        -*) die "unknown option: $1 (try --help)" ;;
        *) src="$1" ;;
        esac
        shift
    done

    trap cleanup EXIT INT TERM
    WORKDIR="$(mktemp -d)"

    if [ -n "$src" ]; then
        install_local "$src"
        return
    fi

    os="$(uname -s)"
    case "$os" in
    Darwin | Linux) ;;
    *) die "unsupported OS: $os (on Windows, use install.ps1)" ;;
    esac
    echo "Detected: $os ($(uname -m))"

    echo "Fetching release info..."
    resolve_release "$tag"
    echo "Release: $(json_field "$RELEASE_JSON" tag_name)"

    if [ "$os" = "Darwin" ]; then
        install_macos_release "$RELEASE_JSON"
    else
        install_linux_release "$RELEASE_JSON"
    fi
}

main "$@"
