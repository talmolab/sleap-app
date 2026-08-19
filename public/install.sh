#!/usr/bin/env sh
#
# SLEAP desktop installer (macOS / Linux).
#
#   curl -fsSL https://app.sleap.ai/install.sh | sh
#
# Why this exists: the desktop app is ad-hoc signed but not notarized (that needs
# a paid Apple Developer ID). A .dmg downloaded through a *browser* gets tagged
# with com.apple.quarantine, and macOS then refuses to launch an un-notarized app
# without a detour through System Settings. curl does not set that tag, so
# installing this way just works. See also `--help` for installing a .dmg you
# already downloaded (e.g. a CI artifact from a workflow run).
#
# POSIX sh on purpose -- this is run via `curl | sh`, so no bashisms and
# everything lives inside main(), which is invoked on the last line. That way a
# truncated download can never execute a half-read script.

set -eu

REPO="talmolab/sleap-app"
APP="SLEAP" # macOS .app bundle name, and the dmg/deb/AppImage filename prefix

# ---------------------------------------------------------------- helpers ----

MOUNTPOINT=""
WORKDIR=""

cleanup() {
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
writable). Linux installs the .deb via dpkg when possible, otherwise drops the
AppImage in ~/.local/bin. No sudo is used on macOS.
EOF
}

# Fetch a URL to stdout.
fetch_stdout() {
    if have curl; then
        curl -fsSL "$1"
    elif have wget; then
        wget -qO- "$1"
    else
        die "curl or wget is required"
    fi
}

# Fetch a URL to a file, showing progress.
fetch_file() {
    echo "Downloading $(basename "$2")..."
    if have curl; then
        curl -fSL --retry 3 --retry-delay 2 -o "$2" "$1"
    elif have wget; then
        wget -q --show-progress --tries=3 -O "$2" "$1"
    else
        die "curl or wget is required"
    fi
}

# Pull one field out of a GitHub API JSON blob without needing jq.
json_field() {
    # json_field <json> <key>  -> first string value for that key
    printf '%s' "$1" |
        tr ',' '\n' |
        grep -m1 "\"$2\"[[:space:]]*:" |
        sed -e 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"//' -e 's/".*//'
}

# Pick the first release asset download URL whose filename matches a pattern.
asset_url() {
    # asset_url <json> <grep-pattern>
    printf '%s' "$1" |
        grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*"' |
        sed -e 's/.*"\(https[^"]*\)"$/\1/' |
        grep -- "$2" |
        head -1
}

# ------------------------------------------------------------------ macOS ----

# Install from an already-downloaded .dmg.
install_macos_dmg() {
    dmg_path="$1"

    if pgrep -f "/$APP.app/Contents/MacOS/" >/dev/null 2>&1; then
        die "$APP is currently running. Quit it and re-run this installer."
    fi

    MOUNTPOINT="$WORKDIR/mnt"
    mkdir -p "$MOUNTPOINT"
    hdiutil attach "$dmg_path" -nobrowse -readonly -quiet -mountpoint "$MOUNTPOINT" ||
        die "could not mount $dmg_path"

    [ -d "$MOUNTPOINT/$APP.app" ] ||
        die "$dmg_path does not contain $APP.app"

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

    # Belt and braces: if the .dmg itself arrived through a browser, the copy
    # inherits com.apple.quarantine and Gatekeeper would gate the first launch.
    xattr -dr com.apple.quarantine "$dest/$APP.app" 2>/dev/null || true

    if have codesign; then
        if codesign --verify --deep --strict "$dest/$APP.app" >/dev/null 2>&1; then
            echo "Signature check: OK (ad-hoc signed)"
        else
            echo "Warning: code signature did not verify. The app may fail to launch." >&2
        fi
    fi

    echo ""
    echo "Installed $APP to $dest/$APP.app"
    echo ""
    echo "Launch it from Spotlight, or:"
    echo "  open -a \"$dest/$APP.app\""
}

install_macos_latest() {
    release_json="$1"

    url="$(asset_url "$release_json" '_universal\.dmg$')"
    if [ -z "$url" ]; then
        # Older releases were built per-architecture rather than universal.
        case "$(uname -m)" in
        arm64 | aarch64) url="$(asset_url "$release_json" '_aarch64\.dmg$')" ;;
        *) url="$(asset_url "$release_json" '_x64\.dmg$')" ;;
        esac
    fi
    [ -n "$url" ] || die "no macOS .dmg found in that release"

    dmg="$WORKDIR/$(basename "$url")"
    fetch_file "$url" "$dmg"
    install_macos_dmg "$dmg"
}

# ------------------------------------------------------------------ Linux ----

deb_arch() {
    case "$(uname -m)" in
    x86_64 | amd64) echo "amd64" ;;
    aarch64 | arm64) echo "arm64" ;;
    *) die "unsupported architecture: $(uname -m)" ;;
    esac
}

# True if we can run sudo without needing to prompt (or can prompt at all).
can_elevate() {
    have sudo || return 1
    sudo -n true 2>/dev/null && return 0
    [ -t 0 ] # only prompt when stdin is a real terminal, not a curl pipe
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

install_linux_latest() {
    release_json="$1"
    arch="$(deb_arch)"

    if have dpkg && can_elevate; then
        url="$(asset_url "$release_json" "_${arch}\.deb$")"
        if [ -n "$url" ]; then
            deb="$WORKDIR/$(basename "$url")"
            fetch_file "$url" "$deb"
            install_linux_deb "$deb"
            return
        fi
    fi

    url="$(asset_url "$release_json" "_${arch}\.AppImage$")"
    [ -n "$url" ] || die "no Linux .deb or .AppImage found for $arch in that release"
    img="$WORKDIR/$(basename "$url")"
    fetch_file "$url" "$img"
    install_linux_appimage "$img"
}

# ------------------------------------------------------- local file install ---

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
            \( -name '*.dmg' -o -name '*.deb' -o -name '*.AppImage' \) |
            head -1)"
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
        die "don't know how to install $(basename "$src") (expected .dmg, .deb, .AppImage, or .zip)"
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
    *) die "unsupported OS: $os (Windows: use install.ps1)" ;;
    esac
    echo "Detected: $os ($(uname -m))"

    if [ -n "$tag" ]; then
        api="https://api.github.com/repos/$REPO/releases/tags/$tag"
    else
        api="https://api.github.com/repos/$REPO/releases/latest"
    fi

    echo "Fetching release info..."
    release_json="$(fetch_stdout "$api")" ||
        die "could not reach the GitHub API (rate limited, or no such release)"

    version="$(json_field "$release_json" tag_name)"
    [ -n "$version" ] || die "could not determine the release version"
    echo "Release: $version"

    if [ -z "$(asset_url "$release_json" '')" ]; then
        die "release $version has no downloadable assets yet.
Check https://github.com/$REPO/releases for one that does, then re-run with:
  install.sh --tag <tag>"
    fi

    if [ "$os" = "Darwin" ]; then
        install_macos_latest "$release_json"
    else
        install_linux_latest "$release_json"
    fi
}

main "$@"
