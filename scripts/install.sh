#!/usr/bin/env sh
#
# SLEAP desktop installer (macOS and Linux).
#
#   curl -fsSL https://app.sleap.ai/install.sh | sh
#   curl -fsSL https://app.sleap.ai/install.sh | sh -s -- --tag v0.1.2
#   sh install.sh ~/Downloads/SLEAP_0.1.2_universal.dmg   # a file you already have
#
# Why this exists (macOS): the app is ad-hoc signed but not notarized, because
# notarization needs a paid Apple Developer ID this project does not have. A .dmg
# that arrives through a browser -- or Slack, email, AirDrop -- is tagged with
# com.apple.quarantine, the tag propagates to the app you drag out of it, and
# Gatekeeper then refuses to launch it. curl never sets that tag, so installing
# this way opens with no prompt at all.
#
# POSIX sh on purpose: this runs through `curl | sh`, where /bin/sh may be dash,
# busybox ash, or bash-as-sh. Everything lives in functions and `main "$@"` is the
# LAST line, so a download truncated mid-flight is a syntax error rather than a
# half-completed install.
#
# Every child command is redirected from /dev/null. Under `curl | sh` stdin IS
# the remainder of this script, and any command that reads it would eat the
# installer.

set -eu

REPO="talmolab/sleap-app"
API="https://api.github.com/repos/talmolab/sleap-app"
RELEASES_URL="https://github.com/talmolab/sleap-app/releases"

# tauri.conf.json productName -> SLEAP.app and the SLEAP_<ver>_<arch>.* prefix.
APP="SLEAP"
# Cargo package name -> the executable inside the bundle is NOT named "SLEAP".
BIN="sleap-app"
# Where the Linux AppImage lands, and the name it gets there.
CLI="sleap"

OPT_TAG="${SLEAP_TAG:-}"
OPT_PRE=0
OPT_PREFIX="${SLEAP_PREFIX:-}"
OPT_FORCE=0
LOCAL_FILE=""

WORKDIR=""
MNT=""
STAGE=""
KEEP_OLD=""
APP_PATH=""
RESOLVED_TAG=""
ASSET_URL=""
CLEANED=0

# --------------------------------------------------------------------- output

log() { printf '%s\n' "$*"; }
step() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() {
    printf 'error: %s\n' "$*" >&2
    exit 1
}
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
    cat <<'EOF'
Install the SLEAP desktop app.

Usage:
  install.sh [options] [FILE]

FILE installs from something you already have instead of downloading -- a .dmg,
a .app, a .tar.gz, a .deb, an .AppImage, an .rpm, or the .zip straight off a
GitHub Actions artifact page. Installing this way also strips the quarantine flag
that otherwise makes macOS refuse to open the app.

Options:
  --tag TAG      Install this exact release tag (pre-releases included).
  --pre          When resolving the newest release, consider pre-releases.
  --prefix DIR   macOS: where SLEAP.app goes (default /Applications, falling back
                 to ~/Applications). Linux AppImage: where the executable goes
                 (default ~/.local/bin).
  --force        Install even while SLEAP is running. The swap is atomic so the
                 running copy keeps working, but it runs the OLD code until you
                 quit and reopen it.
  -h, --help     Show this message.

Environment:
  SLEAP_TAG, SLEAP_PREFIX   Same as --tag / --prefix.
  GITHUB_TOKEN / GH_TOKEN   Used for GitHub API calls, to avoid the 60 requests
                            per hour per IP unauthenticated limit.
EOF
}

# -------------------------------------------------------------------- cleanup

cleanup() {
    [ "$CLEANED" = 1 ] && return 0
    CLEANED=1
    # Detach before deleting the workdir: the mountpoint lives inside it, and
    # rm -rf across a live mount is both useless and alarming.
    [ -n "$MNT" ] && detach_dmg "$MNT"
    # If we moved the old app aside but never got the new one into place, put it
    # back rather than leaving the machine with no SLEAP at all.
    if [ -n "$STAGE" ] && [ -d "$STAGE" ]; then
        rm -rf "$STAGE" 2>/dev/null || true
        if [ -n "$KEEP_OLD" ] && [ -e "$KEEP_OLD" ] && [ -n "$APP_DEST" ] && [ ! -e "$APP_DEST" ]; then
            mv "$KEEP_OLD" "$APP_DEST" 2>/dev/null || true
            warn "install did not complete; restored the previous $APP"
        fi
    fi
    if [ -n "$WORKDIR" ] && [ -d "$WORKDIR" ]; then
        rm -rf "$WORKDIR" 2>/dev/null || true
    fi
    return 0
}
APP_DEST=""

on_signal() {
    cleanup
    printf '\ninterrupted\n' >&2
    exit 130
}

# ------------------------------------------------------------------- download

# -f makes an HTTP error a non-zero exit instead of writing an error page into
# the output file; --proto pins the whole redirect chain to https.
CURL_OPTS="-fSL --proto =https --proto-redir =https --connect-timeout 20 --retry 3 --retry-delay 2"

auth_header() {
    _t="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
    [ -n "$_t" ] && printf 'Authorization: Bearer %s' "$_t"
    return 0
}

# api_get URL -> body on stdout; non-zero on any HTTP or transport error.
api_get() {
    _h="$(auth_header)"
    if have curl; then
        if [ -n "$_h" ]; then
            # shellcheck disable=SC2086
            curl $CURL_OPTS -s -H "$_h" -H 'Accept: application/vnd.github+json' "$1" </dev/null
        else
            # shellcheck disable=SC2086
            curl $CURL_OPTS -s -H 'Accept: application/vnd.github+json' "$1" </dev/null
        fi
    elif have wget; then
        if [ -n "$_h" ]; then
            wget -q -O - --header="$_h" --header='Accept: application/vnd.github+json' "$1" </dev/null
        else
            wget -q -O - --header='Accept: application/vnd.github+json' "$1" </dev/null
        fi
    else
        die "neither curl nor wget is installed; install one and re-run"
    fi
}

download() {
    step "Downloading $(basename "$1")"
    rm -f "$2"
    _h="$(auth_header)"
    if have curl; then
        if [ -t 2 ]; then _q="--progress-bar"; else _q="-s"; fi
        if [ -n "$_h" ]; then
            # shellcheck disable=SC2086
            curl $CURL_OPTS $_q -H "$_h" -o "$2" "$1" </dev/null || die "download failed: $1"
        else
            # shellcheck disable=SC2086
            curl $CURL_OPTS $_q -o "$2" "$1" </dev/null || die "download failed: $1"
        fi
    elif have wget; then
        wget -q --tries=3 -O "$2" "$1" </dev/null || die "download failed: $1"
    else
        die "neither curl nor wget is installed; install one and re-run"
    fi
    [ -s "$2" ] || die "downloaded file is empty: $2"
}

# ----------------------------------------------------------- release metadata

# Emit "<tag>\t<download-url>" for every asset in the release JSON on stdin.
#
# The GitHub REST API pretty-prints one field per line, and within each release
# object "assets_url" comes first, then "tag_name", "draft", "prerelease", then
# the assets. Keying the state machine on "assets_url" therefore delimits
# releases reliably, and none of tag_name/draft/prerelease appear in the nested
# author/uploader objects. (Verified against api.github.com.)
#
# $1 = 1 to allow pre-releases. Drafts are always skipped -- an AUTHENTICATED
# request includes them, and this repo carries a stale draft whose assets use an
# older product name.
parse_assets() {
    awk -v allow_pre="$1" '
    /"assets_url"[[:space:]]*:/ { tag=""; draft=0; pre=0; next }
    /"tag_name"[[:space:]]*:/ {
      t=$0
      sub(/.*"tag_name"[[:space:]]*:[[:space:]]*"/, "", t); sub(/".*$/, "", t)
      tag=t; next
    }
    /"draft"[[:space:]]*:/      { draft = ($0 ~ /true/); next }
    /"prerelease"[[:space:]]*:/ { pre   = ($0 ~ /true/); next }
    /"browser_download_url"[[:space:]]*:/ {
      u=$0
      sub(/.*"browser_download_url"[[:space:]]*:[[:space:]]*"/, "", u); sub(/".*$/, "", u)
      if (u != "" && !draft && (allow_pre == 1 || !pre)) printf "%s\t%s\n", tag, u
    }
  '
}

# select_asset PATTERN...  -- reads "<tag>\t<url>" lines on stdin and prints the
# single best match, trying each pattern in order.
#
# Two safety properties:
#  - Patterns are anchored on a "/" so a file that merely ends the same way
#    cannot shadow the real asset. create-dmg writes its read-write intermediate
#    as rw.<pid>.SLEAP_<ver>_universal.dmg in the same directory, and GitHub
#    returns assets in upload order, not alphabetically.
#  - Among several matches on one release, an asset whose filename carries the
#    release's own version wins. That way a stale asset accidentally attached to
#    a newer tag (SLEAP_0.1.0_universal.dmg on v0.1.2) is not preferred just
#    because it sorts or uploaded first.
select_asset() {
    _all="$(cat)"
    for _pat in "$@"; do
        _hits="$(printf '%s\n' "$_all" | grep -E -- "$_pat" || true)"
        [ -n "$_hits" ] || continue
        _first="$(printf '%s\n' "$_hits" | head -1)"
        _tag="${_first%%	*}"
        _ver="${_tag#v}"
        if [ -n "$_ver" ]; then
            # Match the version inside the FILENAME, not anywhere in the URL --
            # every asset URL contains the tag in its /download/<tag>/ path.
            _vpat="$(printf '%s' "$_ver" | sed 's/\./\\./g')"
            _exact="$(printf '%s\n' "$_hits" |
                grep -E -- "/[^/]*[_-]${_vpat}[_.-]" | head -1 || true)"
            if [ -n "$_exact" ]; then
                printf '%s\n' "$_exact"
                return 0
            fi
        fi
        printf '%s\n' "$_first"
        return 0
    done
    return 1
}

# resolve_asset PATTERN...  -> sets RESOLVED_TAG and ASSET_URL, or dies.
#
# At most two API calls, because unauthenticated api.github.com allows 60 per
# hour per IP and a NAT'd lab burns through that fast. Assets come out of the
# list response itself rather than being re-fetched per candidate tag.
resolve_asset() {
    step "Resolving the SLEAP release"
    _json=""
    _assets=""

    if [ -n "$OPT_TAG" ]; then
        # An explicit tag is explicit consent: no draft/pre-release filtering,
        # and never silently fall back to a different tag.
        _json="$(api_get "$API/releases/tags/$OPT_TAG")" || _json=""
        [ -n "$_json" ] || die "no release tagged '$OPT_TAG' in $REPO.
  Tags that exist: $RELEASES_URL"
        _assets="$(printf '%s' "$_json" | parse_assets 1)"
        _hit="$(printf '%s\n' "$_assets" | select_asset "$@")" || _hit=""
        [ -n "$_hit" ] || die "release $OPT_TAG has no installer for $(uname -s) $(uname -m).
  Assets on that release: $RELEASES_URL/tag/$OPT_TAG"
        RESOLVED_TAG="${_hit%%	*}"
        ASSET_URL="${_hit#*	}"
        return 0
    fi

    if [ "$OPT_PRE" = 0 ]; then
        _json="$(api_get "$API/releases/latest")" || _json=""
        if [ -n "$_json" ]; then
            _assets="$(printf '%s' "$_json" | parse_assets 0)"
            _hit="$(printf '%s\n' "$_assets" | select_asset "$@")" || _hit=""
            if [ -n "$_hit" ]; then
                RESOLVED_TAG="${_hit%%	*}"
                ASSET_URL="${_hit#*	}"
                return 0
            fi
            log "Note: the latest release has no build for this platform yet."
        fi
    fi

    log "Looking for the newest release that does..."
    _json="$(api_get "$API/releases?per_page=30")" || _json=""
    if [ -z "$_json" ]; then
        die "could not reach the GitHub API.
  If you are rate limited (60 requests/hour per IP when unauthenticated, which a
  shared campus or VPN address burns through quickly), either wait an hour, or:
    export GITHUB_TOKEN=<any token, no scopes needed>   # then re-run
  Or download a build by hand from $RELEASES_URL/latest and install it directly:
    sh install.sh ~/Downloads/<the file you downloaded>"
    fi
    _assets="$(printf '%s' "$_json" | parse_assets "$OPT_PRE")"
    _hit="$(printf '%s\n' "$_assets" | select_asset "$@")" || _hit=""
    [ -n "$_hit" ] || die "no SLEAP release in $REPO has a build for $(uname -s) $(uname -m).

  The usual cause is a release whose build never finished, so nothing was ever
  attached to it. Check $RELEASES_URL .
  Pre-releases are skipped unless you pass --pre.

  If you already have a build -- including a .zip straight off the GitHub Actions
  artifact page -- install it directly, which also clears the quarantine flag:
    sh install.sh ~/Downloads/<the file you downloaded>"
    RESOLVED_TAG="${_hit%%	*}"
    ASSET_URL="${_hit#*	}"
    return 0
}

# ---------------------------------------------------------- macOS: internals

app_running() {
    have pgrep || return 1
    pgrep -x "$BIN" >/dev/null 2>&1
}

guard_not_running() {
    app_running || return 0
    if [ "$OPT_FORCE" = 1 ]; then
        warn "$APP is running; installing anyway (--force). The new version is
  swapped in by rename, so the running copy stays usable -- but it keeps running
  the OLD code until you quit and reopen it."
        return 0
    fi
    die "$APP is currently running.
  Quit it first (Cmd-Q, or: osascript -e 'quit app \"$APP\"') and re-run.
  Or pass --force; you will still have to restart $APP afterwards."
}

detach_dmg() {
    [ -d "$1" ] || {
        MNT=""
        return 0
    }
    _i=0
    while [ "$_i" -lt 5 ]; do
        if hdiutil detach "$1" -quiet >/dev/null 2>&1 </dev/null; then
            MNT=""
            return 0
        fi
        # "Resource busy" here is normally Spotlight indexing the volume; it
        # lets go within a second or two.
        _i=$((_i + 1))
        sleep 1
    done
    if hdiutil detach "$1" -force -quiet >/dev/null 2>&1 </dev/null; then
        MNT=""
        return 0
    fi
    warn "could not unmount $1; detach it by hand:  hdiutil detach '$1' -force"
    MNT=""
    return 0
}

copy_tree() {
    # ditto is the macOS-correct copy: it preserves the extended attributes,
    # ACLs and HFS compression that `cp -R` silently drops.
    if have ditto; then
        ditto "$1" "$2" </dev/null
    else
        cp -R "$1" "$2"
    fi
}

mac_prefix() {
    if [ -n "$OPT_PREFIX" ]; then
        mkdir -p "$OPT_PREFIX" 2>/dev/null || die "cannot create --prefix directory: $OPT_PREFIX"
        [ -w "$OPT_PREFIX" ] || die "--prefix directory is not writable: $OPT_PREFIX"
        printf '%s' "$OPT_PREFIX"
        return 0
    fi
    # /Applications is drwxrwxr-x root:admin, so admin accounts write to it with
    # no sudo -- which matters, because under `curl | sh` stdin is the pipe and
    # sudo would have nowhere to prompt.
    if [ -w /Applications ]; then
        printf '%s' /Applications
    else
        mkdir -p "$HOME/Applications" || die "cannot create $HOME/Applications"
        warn "/Applications is not writable by this account; installing to $HOME/Applications"
        printf '%s' "$HOME/Applications"
    fi
}

# Strip com.apple.quarantine. A browser download carries it, an unzip propagates
# it to every extracted file, and copying out of a mounted .dmg propagates it
# again. Quarantine plus an un-notarized bundle is what produces the Gatekeeper
# block; without the tag Gatekeeper is never consulted at all.
unquarantine() {
    have xattr || return 0
    xattr -dr com.apple.quarantine "$1" >/dev/null 2>&1 || true
    return 0
}

quarantine_present() {
    have xattr || return 1
    xattr -p com.apple.quarantine "$1" >/dev/null 2>&1
}

# A bundle whose signature does not match its contents is rejected HARDER than
# an unsigned one: macOS reports "damaged ... move it to the Trash", with no
# "Open Anyway" to click. Builds carrying only the linker's ad-hoc signature on
# the Mach-O (no Contents/_CodeSignature, "Sealed Resources=none") fail exactly
# that way. Re-signing ad-hoc seals the bundle and fixes it. Current CI output
# is already sealed correctly, so this only fires for older or hand-built
# artifacts.
ensure_valid_signature() {
    have codesign || {
        warn "codesign not found; skipping the signature check"
        return 0
    }
    codesign --verify --deep --strict "$1" >/dev/null 2>&1 && return 0

    # Never clobber a real Developer ID signature: if one is present and still
    # failing, re-signing would only hide the actual problem.
    if codesign -dvv "$1" 2>&1 | grep -q '^Authority='; then
        warn "$APP carries a Developer ID signature that does not verify.
  Not re-signing. Re-download it, and report it at $RELEASES_URL if it persists."
        return 0
    fi

    step "Repairing the code signature (ad-hoc)"
    if codesign --force --deep --sign - "$1" >/dev/null 2>&1 &&
        codesign --verify --deep --strict "$1" >/dev/null 2>&1; then
        return 0
    fi
    warn "could not produce a valid signature for $1.
  If macOS refuses to open it:
    xattr -dr com.apple.quarantine '$1'
    codesign --force --deep --sign - '$1'"
    return 0
}

# Install a directory that IS the .app bundle. Staging on the DESTINATION volume
# makes the last step a rename, so a failed copy leaves the existing install
# untouched and there is no window where neither version is present.
install_app_bundle() {
    [ -d "$1" ] || die "not an app bundle: $1"
    _prefix="$(mac_prefix)"
    APP_DEST="$_prefix/$APP.app"
    STAGE="$_prefix/.$APP.app.new.$$"
    KEEP_OLD="$_prefix/.$APP.app.old.$$"

    rm -rf "$STAGE"
    step "Staging into $_prefix"
    copy_tree "$1" "$STAGE" || die "failed to copy the app into $_prefix"

    unquarantine "$STAGE"
    ensure_valid_signature "$STAGE"

    [ -x "$STAGE/Contents/MacOS/$BIN" ] ||
        die "the staged bundle has no executable at Contents/MacOS/$BIN;
  this does not look like a SLEAP build"

    step "Installing to $APP_DEST"
    if [ -e "$APP_DEST" ]; then
        mv "$APP_DEST" "$KEEP_OLD" || die "could not move the existing $APP_DEST aside"
    else
        KEEP_OLD=""
    fi
    if ! mv "$STAGE" "$APP_DEST"; then
        if [ -n "$KEEP_OLD" ] && [ -e "$KEEP_OLD" ]; then
            mv "$KEEP_OLD" "$APP_DEST" 2>/dev/null || true
            warn "install failed; restored the previous $APP"
        fi
        die "could not move the new app into place at $APP_DEST"
    fi
    STAGE=""

    if [ -n "$KEEP_OLD" ] && [ -e "$KEEP_OLD" ]; then
        if app_running; then
            # A live process still reaches its files through the renamed
            # directory; deleting them now is what would actually break it.
            warn "kept the previous version at $KEEP_OLD because $APP is still
  running. Delete it once you have quit:  rm -rf '$KEEP_OLD'"
        else
            rm -rf "$KEEP_OLD" 2>/dev/null || true
        fi
    fi
    KEEP_OLD=""

    # A copy means fresh inodes, so clear the tag again on the final path.
    unquarantine "$APP_DEST"
    APP_PATH="$APP_DEST"
}

report_macos() {
    [ -d "$APP_PATH" ] || die "install finished but $APP_PATH is missing"
    [ -x "$APP_PATH/Contents/MacOS/$BIN" ] ||
        die "install finished but $APP_PATH/Contents/MacOS/$BIN is not executable"

    if have codesign && codesign --verify --deep --strict "$APP_PATH" >/dev/null 2>&1; then
        _sig="code signature verifies"
    else
        _sig="code signature could NOT be verified"
    fi

    log ""
    log "Installed $APP${RESOLVED_TAG:+ $RESOLVED_TAG} to $APP_PATH"
    log "  $_sig"

    if quarantine_present "$APP_PATH"; then
        log ""
        warn "the quarantine flag is still set on $APP_PATH, so macOS will block
  the first launch. Clear it by hand:
    xattr -dr com.apple.quarantine '$APP_PATH'
  If that fails, open System Settings > Privacy & Security > Security, then
  Open Anyway (that button appears only for about an hour after a blocked
  launch, and needs your login password)."
    else
        log "  quarantine flag cleared, so it opens with no Gatekeeper prompt"
    fi

    log ""
    log "Open it:    open -a '$APP'    (or find SLEAP in Spotlight / Launchpad)"
    log "Uninstall:  rm -rf '$APP_PATH'"
}

# --------------------------------------------------------- macOS: entrypoints

install_from_dmg() {
    [ -f "$1" ] || die "no such file: $1"
    MNT="$WORKDIR/mnt"
    mkdir -p "$MNT"
    step "Mounting $(basename "$1")"
    # No -noverify: hdiutil's checksum pass is a free integrity check on the
    # download. -nobrowse/-noautoopen keep Finder out, and </dev/null stops a
    # license prompt from swallowing the rest of this script.
    hdiutil attach "$1" -nobrowse -noautoopen -readonly -quiet -mountpoint "$MNT" </dev/null || {
        MNT=""
        die "could not mount $1.
  It is most likely truncated, or not a disk image. Delete it and re-run."
    }
    _app="$MNT/$APP.app"
    if [ ! -d "$_app" ]; then
        _app="$(find "$MNT" -maxdepth 1 -name '*.app' -print 2>/dev/null | head -1)"
        [ -n "$_app" ] || die "no .app found inside $1"
    fi
    guard_not_running
    install_app_bundle "$_app"
    detach_dmg "$MNT"
}

install_from_tarball() {
    _d="$WORKDIR/untar"
    mkdir -p "$_d"
    step "Extracting $(basename "$1")"
    tar -xzf "$1" -C "$_d" </dev/null || die "could not extract $1"
    unquarantine "$_d"
    _app="$(find "$_d" -maxdepth 2 -name '*.app' -print 2>/dev/null | head -1)"
    [ -n "$_app" ] || die "no .app inside $1"
    guard_not_running
    install_app_bundle "$_app"
}

# macOS's Archive Utility writes a parallel __MACOSX/._<name> AppleDouble stub for
# every entry it zips. Those match exactly the same globs as the real payload, are a
# few KB of resource fork, and are not installable -- picking one up produces a
# bogus "most likely truncated" complaint about a perfectly good archive.
zip_payload() {
    # zip_payload <dir> <name-pattern>
    find "$1" -type f -name "$2" \
        ! -name '._*' \
        ! -path '*/__MACOSX/*' \
        ! -name 'rw.*' \
        -print 2>/dev/null | head -1
}

zip_bundle() {
    find "$1" -maxdepth 3 -name '*.app' \
        ! -name '._*' \
        ! -path '*/__MACOSX/*' \
        -print 2>/dev/null | head -1
}

install_from_zip() {
    _zip="$1"
    _d="$WORKDIR/unzip"
    mkdir -p "$_d"
    step "Extracting $(basename "$_zip")"
    if have unzip; then
        unzip -q -o "$_zip" -d "$_d" </dev/null || die "could not unzip $_zip"
    elif have ditto; then
        ditto -x -k "$_zip" "$_d" </dev/null || die "could not unzip $_zip"
    else
        die "no unzip available; extract $_zip by hand and pass the file inside it"
    fi
    # Expanding a quarantined zip tags every extracted file, so clear the whole
    # tree before anything is copied out of it.
    unquarantine "$_d"

    # Only consider payloads this platform can actually install. A CI artifact zip
    # often holds every platform's bundles at once: searching .dmg first meant Linux
    # picked the .dmg and failed, and the .app fallback was not guarded at all, so a
    # macOS bundle copied into ~/Applications on Linux reported success and left the
    # user with something unrunnable.
    if [ "$(uname -s)" = Darwin ]; then
        set -- '*.dmg' '*.app.tar.gz'
    else
        set -- '*.deb' '*.rpm' '*.AppImage'
    fi

    for _pat in "$@"; do
        _hit="$(zip_payload "$_d" "$_pat")"
        if [ -n "$_hit" ]; then
            install_local_path "$_hit"
            return 0
        fi
    done

    if [ "$(uname -s)" = Darwin ]; then
        _hit="$(zip_bundle "$_d")"
        if [ -n "$_hit" ]; then
            guard_not_running
            install_app_bundle "$_hit"
            return 0
        fi
        die "nothing this Mac can install inside $(basename "$_zip")
(looked for a .dmg, .app.tar.gz or .app)"
    fi
    die "nothing this system can install inside $(basename "$_zip")
(looked for a .deb, .rpm or .AppImage)"
}

install_macos() {
    case "$(uname -m)" in
    arm64 | aarch64)
        # Universal first, then this machine's own slice. An x64-only build would
        # run under Rosetta 2, so take it last rather than preferring it.
        set -- "/${APP}_[^/]*_universal\.dmg$" "/${APP}_[^/]*_aarch64\.dmg$" "/${APP}_[^/]*_x64\.dmg$"
        ;;
    x86_64)
        set -- "/${APP}_[^/]*_universal\.dmg$" "/${APP}_[^/]*_x64\.dmg$"
        ;;
    *) die "unsupported macOS architecture: $(uname -m)" ;;
    esac
    resolve_asset "$@"
    _f="$WORKDIR/$(basename "$ASSET_URL")"
    download "$ASSET_URL" "$_f"
    install_from_dmg "$_f"
}

# ------------------------------------------------------------------- Linux

# Run a command as root. Under `curl | sh` stdin is the script, so every child
# gets </dev/null and sudo is left to open the controlling terminal itself for
# its prompt. Returns 1 without prompting when there is no way to elevate, so
# the caller can print a command the user can run by hand.
run_root() {
    if [ "$(id -u)" = 0 ]; then
        "$@" </dev/null
        return $?
    fi
    have sudo || return 1
    if sudo -n true >/dev/null 2>&1 </dev/null; then
        sudo "$@" </dev/null
        return $?
    fi
    if [ -r /dev/tty ]; then
        log "sudo needs your password to install the package."
        sudo -p 'Password for %u: ' "$@" </dev/null
        return $?
    fi
    return 1
}

install_deb() {
    step "Installing $(basename "$1")"
    _ok=0
    # apt-get resolves the webkit2gtk/gtk dependencies; a bare `dpkg -i` leaves
    # the package unconfigured when they are missing.
    if have apt-get && run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y "$1"; then
        _ok=1
    fi
    if [ "$_ok" != 1 ] && have dpkg; then
        if run_root dpkg -i "$1"; then
            _ok=1
        elif have apt-get && run_root env DEBIAN_FRONTEND=noninteractive apt-get -f install -y; then
            _ok=1
        fi
    fi
    if [ "$_ok" != 1 ]; then
        log ""
        log "Could not install the package automatically (no sudo here, or apt failed)."
        log "The package is still at:"
        log "  $1"
        log "Finish the install with:"
        log "  sudo apt-get install -y '$1'"
        die "package not installed"
    fi

    # Read the control field rather than guessing how the product name was
    # kebab-cased, so the uninstall hint is always right.
    _pkg=""
    have dpkg-deb && _pkg="$(dpkg-deb -f "$1" Package 2>/dev/null || true)"
    log ""
    log "Installed $APP${RESOLVED_TAG:+ $RESOLVED_TAG}"
    log "  binary:   /usr/bin/$BIN"
    log "  launcher: $APP, in your application menu"
    log ""
    log "Run it:     $BIN"
    [ -n "$_pkg" ] && log "Uninstall:  sudo apt-get remove $_pkg"
    return 0
}

install_rpm() {
    step "Installing $(basename "$1")"
    _ok=0
    if have dnf && run_root dnf install -y "$1"; then
        _ok=1
    elif have zypper && run_root zypper --non-interactive install --allow-unsigned-rpm "$1"; then
        _ok=1
    elif have rpm && run_root rpm -Uvh "$1"; then
        _ok=1
    fi
    if [ "$_ok" != 1 ]; then
        log ""
        log "Could not install the package automatically. It is still at:"
        log "  $1"
        log "Finish the install with:"
        log "  sudo dnf install '$1'"
        die "package not installed"
    fi
    log ""
    log "Installed $APP${RESOLVED_TAG:+ $RESOLVED_TAG}"
    log "Run it:     $BIN"
    log "Uninstall:  sudo dnf remove $(rpm -qp --qf '%{NAME}' "$1" 2>/dev/null || echo sleap)"
    return 0
}

install_appimage() {
    _dir="${OPT_PREFIX:-$HOME/.local/bin}"
    mkdir -p "$_dir" || die "cannot create $_dir"
    [ -w "$_dir" ] || die "$_dir is not writable"
    _dest="$_dir/$CLI"
    step "Installing to $_dest"
    # Write a temp name in the same directory and rename, so an interrupted copy
    # cannot leave a half-written executable on PATH.
    cp "$1" "$_dest.new.$$" || die "could not write $_dest.new.$$"
    chmod +x "$_dest.new.$$"
    mv "$_dest.new.$$" "$_dest" || die "could not move the AppImage into place"

    log ""
    log "Installed $APP${RESOLVED_TAG:+ $RESOLVED_TAG} to $_dest"
    case ":$PATH:" in
    *":$_dir:"*) log "Run it:  $CLI" ;;
    *)
        log ""
        log "$_dir is not on your PATH. Add it:"
        log "  export PATH=\"$_dir:\$PATH\""
        log "or run it directly:  $_dest"
        ;;
    esac
    log ""
    log "AppImages need FUSE 2. If it exits with a libfuse.so.2 error:"
    log "  sudo apt-get install -y libfuse2      # libfuse2t64 on Ubuntu 24.04+"
    log "  $_dest --appimage-extract-and-run     # or bypass FUSE entirely"
    log ""
    log "Uninstall:  rm -f '$_dest'"
    return 0
}

install_linux() {
    case "$(uname -m)" in
    x86_64 | amd64)
        # Tauri names the .deb "amd64" and the .AppImage "amd64" on x86_64, but
        # they diverge on arm (_arm64.deb vs _aarch64.AppImage), so keep the two
        # patterns separate.
        _deb="/${APP}_[^/]*_amd64\.deb$"
        _img="/${APP}_[^/]*_amd64\.AppImage$"
        _rpm="/${APP}-[^/]*\.x86_64\.rpm$"
        ;;
    aarch64 | arm64)
        _deb="/${APP}_[^/]*_arm64\.deb$"
        _img="/${APP}_[^/]*_aarch64\.AppImage$"
        _rpm="/${APP}-[^/]*\.aarch64\.rpm$"
        ;;
    *) die "unsupported Linux architecture: $(uname -m).
  Build from source: https://github.com/$REPO" ;;
    esac

    # Prefer the AppImage: it is the only Linux payload the in-app updater can
    # replace without root, so a .deb install is a dead end for auto-update
    # unless the release also publishes a signed .deb (it may not).
    if have dpkg && [ -n "${SLEAP_PREFER_DEB:-}" ]; then
        set -- "$_deb" "$_img" "$_rpm"
    elif have rpm && ! have dpkg; then
        set -- "$_rpm" "$_img" "$_deb"
    else
        set -- "$_img" "$_deb" "$_rpm"
    fi
    resolve_asset "$@"

    case "$ASSET_URL" in
    *.deb | *.rpm)
        # Download outside the workdir that cleanup wipes: when elevation fails
        # we tell the user to run the package manager themselves, and that path
        # has to still exist afterwards.
        _cache="${XDG_CACHE_HOME:-$HOME/.cache}/sleap-install"
        mkdir -p "$_cache" || die "cannot create $_cache"
        _f="$_cache/$(basename "$ASSET_URL")"
        ;;
    *)
        _f="$WORKDIR/$(basename "$ASSET_URL")"
        ;;
    esac
    download "$ASSET_URL" "$_f"

    case "$ASSET_URL" in
    *.deb)
        install_deb "$_f"
        rm -f "$_f"
        ;;
    *.rpm)
        install_rpm "$_f"
        rm -f "$_f"
        ;;
    *) install_appimage "$_f" ;;
    esac
}

# ---------------------------------------------------------------- local files

install_local_path() {
    _f="$1"
    _os="$(uname -s)"
    case "$_f" in
    *.dmg | *.zip | *.tar.gz | *.tgz | *.app | *.app/)
        case "$_f" in
        *.zip) : ;;
        *)
            [ "$_os" = Darwin ] ||
                die "$(basename "$_f") is a macOS bundle; this is $_os"
            ;;
        esac
        ;;
    *.deb | *.AppImage | *.rpm)
        [ "$_os" = Linux ] ||
            die "$(basename "$_f") is a Linux package; this is $_os"
        ;;
    esac

    case "$_f" in
    *.dmg) install_from_dmg "$_f" ;;
    *.zip) install_from_zip "$_f" ;;
    *.tar.gz | *.tgz) install_from_tarball "$_f" ;;
    *.app | *.app/)
        [ -d "$_f" ] || die "not a bundle directory: $_f"
        unquarantine "${_f%/}"
        guard_not_running
        install_app_bundle "${_f%/}"
        ;;
    *.deb) install_deb "$_f" ;;
    *.rpm) install_rpm "$_f" ;;
    *.AppImage) install_appimage "$_f" ;;
    *) die "don't know how to install '$_f'.
  Supported: .dmg, .zip, .tar.gz, .app (macOS); .deb, .rpm, .AppImage (Linux)" ;;
    esac
}

install_local() {
    case "$1" in
    /*) _f="$1" ;;
    *) _f="$(pwd)/$1" ;;
    esac
    [ -e "$_f" ] || die "no such file: $1"
    install_local_path "$_f"
}

# ----------------------------------------------------------------------- main

main() {
    while [ $# -gt 0 ]; do
        case "$1" in
        -h | --help)
            usage
            exit 0
            ;;
        --pre) OPT_PRE=1 ;;
        --force) OPT_FORCE=1 ;;
        --tag)
            [ $# -ge 2 ] || die "--tag needs a value"
            OPT_TAG="$2"
            shift
            ;;
        --tag=*) OPT_TAG="${1#--tag=}" ;;
        --prefix)
            [ $# -ge 2 ] || die "--prefix needs a value"
            OPT_PREFIX="$2"
            shift
            ;;
        --prefix=*) OPT_PREFIX="${1#--prefix=}" ;;
        -*) die "unknown option: $1  (try --help)" ;;
        *)
            [ -z "$LOCAL_FILE" ] || die "only one file may be given"
            LOCAL_FILE="$1"
            ;;
        esac
        shift
    done

    trap cleanup EXIT
    trap on_signal HUP INT TERM

    _os="$(uname -s)"
    case "$_os" in
    Darwin | Linux) ;;
    *) die "unsupported operating system: $_os.
  macOS and Linux are supported here. On Windows, run install.ps1:
    irm https://app.sleap.ai/install.ps1 | iex" ;;
    esac

    WORKDIR="$(mktemp -d 2>/dev/null || mktemp -d -t sleap-install)"
    [ -d "$WORKDIR" ] || die "could not create a temporary directory"

    if [ -n "$LOCAL_FILE" ]; then
        install_local "$LOCAL_FILE"
    elif [ "$_os" = Darwin ]; then
        install_macos
    else
        install_linux
    fi

    [ -n "$APP_PATH" ] && report_macos
    cleanup
}

main "$@"
