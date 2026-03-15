# Distributing a Tauri/Rust Binary via PyPI Wheels

## Design notes for `sleap-app`

---

## Overview

This document describes how to package a Tauri-based GUI application as a set of
platform-specific Python wheels and distribute it through PyPI, so that end users
can install the SLEAP GUI with:

```bash
pip install sleap-app
# or
pip install sleap[gui]
# or
uvx sleap-app
```

The approach follows the pattern described by Simon Willison's `go-to-wheel` project,
adapted for Rust/Tauri binaries.

---

## 1. Package Architecture

```
sleap (existing)            sleap-app (new)
├── sleap/                  ├── sleap_app/
│   ├── nn/                 │   ├── __init__.py    ← get_binary_path(), main()
│   ├── io/                 │   ├── __main__.py    ← python -m sleap_app
│   ├── gui.py   ← NEW     │   └── bin/
│   └── ...                 │       └── sleap-app  ← compiled Tauri binary
├── pyproject.toml          ├── pyproject.toml
└── ...                     └── ...

sleap-app-src/ (Tauri project, NOT published to PyPI)
├── src-tauri/
│   ├── src/
│   │   └── main.rs
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/                    ← frontend (Svelte/React/Vue/etc.)
├── package.json
└── ...
```

The key insight: `sleap-app` on PyPI contains ONLY the compiled binary and a
thin Python wrapper. The Tauri source lives in its own repo (or a subdirectory
of the SLEAP monorepo). The wheel-building step is a post-compilation packaging
step, not a build system.

---

## 2. Platform Target Mapping

Rust target triples need to be mapped to Python wheel platform tags.

| Rust Target Triple           | Wheel Platform Tag       | Notes                      |
| ---------------------------- | ------------------------ | -------------------------- |
| `x86_64-unknown-linux-gnu`   | `manylinux_2_17_x86_64`  | Most Linux distros         |
| `aarch64-unknown-linux-gnu`  | `manylinux_2_17_aarch64` | ARM64 Linux (Jetson, etc.) |
| `x86_64-unknown-linux-musl`  | `musllinux_1_2_x86_64`   | Alpine, static linking     |
| `aarch64-unknown-linux-musl` | `musllinux_1_2_aarch64`  | Alpine ARM64               |
| `x86_64-apple-darwin`        | `macosx_10_9_x86_64`     | Intel Mac (10.9+ compat)   |
| `aarch64-apple-darwin`       | `macosx_11_0_arm64`      | Apple Silicon              |
| `x86_64-pc-windows-msvc`     | `win_amd64`              | Windows x64                |
| `aarch64-pc-windows-msvc`    | `win_arm64`              | Windows ARM64              |

### Which targets to prioritize for SLEAP

For the initial release, you probably only need:

- `x86_64-unknown-linux-gnu` — lab workstations, HPC
- `aarch64-unknown-linux-gnu` — Jetson, ARM servers
- `aarch64-apple-darwin` — Apple Silicon laptops (labeling)
- `x86_64-apple-darwin` — older Macs
- `x86_64-pc-windows-msvc` — Windows workstations

The musl and Windows ARM64 targets can come later.

---

## 3. The Wheel-Building Script: `tauri-to-wheel`

This is the core tool. It takes compiled binaries and produces correctly-named
`.whl` files.

### 3a. Wheel file format primer

A `.whl` file is just a ZIP archive with a specific naming convention:

```
{package}-{version}-{python}-{abi}-{platform}.whl
```

For a pure binary wrapper with no compiled Python extensions:

```
sleap_app-0.1.0-py3-none-macosx_11_0_arm64.whl
```

- `py3` = works with any Python 3
- `none` = no ABI dependency (we're not a C extension)
- `macosx_11_0_arm64` = platform tag

Inside the wheel:

```
sleap_app/
    __init__.py
    __main__.py
    bin/
        sleap-app           ← the actual binary (or sleap-app.exe on Windows)
sleap_app-0.1.0.dist-info/
    METADATA                ← package metadata (name, version, deps, etc.)
    WHEEL                   ← wheel format metadata
    RECORD                  ← SHA256 hashes of every file
    entry_points.txt        ← console_scripts entry point
```

### 3b. The build script

```python
#!/usr/bin/env python3
"""
tauri_to_wheel.py

Packages pre-compiled Tauri/Rust binaries into platform-specific Python wheels.

Usage:
    python tauri_to_wheel.py \
        --binary-dir ./target/release-artifacts \
        --package-name sleap-app \
        --version 0.1.0 \
        --output-dir ./dist

Expects binary-dir to contain subdirectories named by Rust target triple:
    ./target/release-artifacts/
        x86_64-unknown-linux-gnu/sleap-app
        aarch64-apple-darwin/sleap-app
        x86_64-pc-windows-msvc/sleap-app.exe
        ...
"""

import argparse
import csv
import hashlib
import io
import os
import stat
import sys
import zipfile
from base64 import urlsafe_b64encode
from pathlib import Path

# ── Target mapping ──────────────────────────────────────────────────────────

TARGET_MAP = {
    "x86_64-unknown-linux-gnu":     "manylinux_2_17_x86_64",
    "aarch64-unknown-linux-gnu":    "manylinux_2_17_aarch64",
    "x86_64-unknown-linux-musl":    "musllinux_1_2_x86_64",
    "aarch64-unknown-linux-musl":   "musllinux_1_2_aarch64",
    "x86_64-apple-darwin":          "macosx_10_9_x86_64",
    "aarch64-apple-darwin":         "macosx_11_0_arm64",
    "x86_64-pc-windows-msvc":       "win_amd64",
    "aarch64-pc-windows-msvc":      "win_arm64",
}


# ── Wheel construction ─────────────────────────────────────────────────────

def sha256_digest_b64(data: bytes) -> str:
    """Return the URL-safe base64-encoded SHA256 digest (no padding)."""
    digest = hashlib.sha256(data).digest()
    return urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def make_metadata(
    package_name: str,
    version: str,
    summary: str = "",
    author: str = "",
    home_page: str = "",
    license_name: str = "",
    requires_python: str = ">=3.8",
) -> str:
    """Generate the METADATA file content."""
    lines = [
        "Metadata-Version: 2.1",
        f"Name: {package_name}",
        f"Version: {version}",
    ]
    if summary:
        lines.append(f"Summary: {summary}")
    if author:
        lines.append(f"Author: {author}")
    if home_page:
        lines.append(f"Home-page: {home_page}")
    if license_name:
        lines.append(f"License: {license_name}")
    lines.append(f"Requires-Python: {requires_python}")
    return "\n".join(lines) + "\n"


def make_wheel_metadata() -> str:
    """Generate the WHEEL file content."""
    return "\n".join([
        "Wheel-Version: 1.0",
        "Generator: tauri-to-wheel",
        "Root-Is-Purelib: false",
        "Tag: py3-none-{platform}",  # Placeholder; actual tag is in filename
    ]) + "\n"


def make_entry_points(package_name: str, binary_name: str) -> str:
    """Generate the entry_points.txt file."""
    # The console script name should match the binary name
    module = package_name.replace("-", "_")
    return f"[console_scripts]\n{binary_name} = {module}:main\n"


def make_init_py(binary_name: str) -> str:
    """Generate the __init__.py that locates and execs the binary."""
    return f'''"""
Thin wrapper to locate and execute the bundled binary.
"""
import os
import stat
import subprocess
import sys


__all__ = ["get_binary_path", "main"]

BINARY_NAME = "{binary_name}"


def get_binary_path() -> str:
    """Return the absolute path to the bundled binary.

    This is useful when using sleap-app as a dependency — you can call
    this function to get the path and then subprocess.run() it yourself.
    """
    if sys.platform == "win32":
        name = BINARY_NAME + ".exe"
    else:
        name = BINARY_NAME

    binary = os.path.join(os.path.dirname(__file__), "bin", name)

    if not os.path.exists(binary):
        raise FileNotFoundError(
            f"Bundled binary not found at {{binary}}. "
            f"This may indicate a packaging error or unsupported platform."
        )

    # Ensure the binary is executable on Unix
    if sys.platform != "win32":
        current_mode = os.stat(binary).st_mode
        if not (current_mode & stat.S_IXUSR):
            os.chmod(
                binary,
                current_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH,
            )

    return binary


def main():
    """Execute the bundled binary, forwarding all arguments and exit code."""
    binary = get_binary_path()

    if sys.platform == "win32":
        # On Windows, subprocess handles signals properly
        sys.exit(subprocess.call([binary] + sys.argv[1:]))
    else:
        # On Unix, exec replaces the Python process entirely.
        # This is important for signal handling — SIGINT, SIGTERM, etc.
        # go directly to the binary process, not intercepted by Python.
        os.execvp(binary, [binary] + sys.argv[1:])
'''


def make_main_py(package_name: str) -> str:
    """Generate __main__.py for `python -m sleap_app` support."""
    module = package_name.replace("-", "_")
    return f'from {module} import main\nmain()\n'


def build_wheel(
    binary_path: Path,
    rust_target: str,
    package_name: str,
    binary_name: str,
    version: str,
    output_dir: Path,
    metadata_kwargs: dict,
) -> Path:
    """Build a single platform-specific wheel.

    Args:
        binary_path:     Path to the compiled binary for this target.
        rust_target:     Rust target triple (e.g. "aarch64-apple-darwin").
        package_name:    Python package name (e.g. "sleap-app").
        binary_name:     CLI binary name (e.g. "sleap-app").
        version:         Semantic version string (e.g. "0.1.0").
        output_dir:      Directory to write the .whl file into.
        metadata_kwargs: Extra kwargs passed to make_metadata().

    Returns:
        Path to the created .whl file.
    """
    platform_tag = TARGET_MAP[rust_target]
    module_name = package_name.replace("-", "_")
    dist_info = f"{module_name}-{version}.dist-info"

    wheel_filename = f"{module_name}-{version}-py3-none-{platform_tag}.whl"
    wheel_path = output_dir / wheel_filename

    # Determine the binary filename inside the wheel
    if "windows" in rust_target or "msvc" in rust_target:
        bin_filename = binary_name + ".exe"
    else:
        bin_filename = binary_name

    # Collect all files to put in the wheel as (archive_path, data_bytes)
    files: list[tuple[str, bytes]] = []

    # 1. The binary itself
    binary_data = binary_path.read_bytes()
    files.append((f"{module_name}/bin/{bin_filename}", binary_data))

    # 2. Python wrapper files
    init_py = make_init_py(binary_name).encode("utf-8")
    files.append((f"{module_name}/__init__.py", init_py))

    main_py = make_main_py(package_name).encode("utf-8")
    files.append((f"{module_name}/__main__.py", main_py))

    # 3. dist-info files
    metadata = make_metadata(
        package_name=package_name,
        version=version,
        **metadata_kwargs,
    ).encode("utf-8")
    files.append((f"{dist_info}/METADATA", metadata))

    wheel_meta = make_wheel_metadata().encode("utf-8")
    files.append((f"{dist_info}/WHEEL", wheel_meta))

    entry_points = make_entry_points(package_name, binary_name).encode("utf-8")
    files.append((f"{dist_info}/entry_points.txt", entry_points))

    # 4. Build the RECORD (hash manifest)
    record_lines = []
    for archive_path, data in files:
        digest = sha256_digest_b64(data)
        size = len(data)
        record_lines.append(f"{archive_path},sha256={digest},{size}")
    # RECORD itself is listed with no hash
    record_lines.append(f"{dist_info}/RECORD,,")
    record_data = "\n".join(record_lines).encode("utf-8")

    # 5. Write the zip
    output_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(wheel_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for archive_path, data in files:
            zf.writestr(archive_path, data)
        zf.writestr(f"{dist_info}/RECORD", record_data)

    size_mb = wheel_path.stat().st_size / (1024 * 1024)
    print(f"  ✓ {wheel_filename} ({size_mb:.1f} MB)")
    return wheel_path


# ── CLI ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Package Tauri/Rust binaries into Python wheels."
    )
    parser.add_argument(
        "--binary-dir",
        type=Path,
        required=True,
        help=(
            "Directory containing subdirectories named by Rust target triple, "
            "each containing the compiled binary."
        ),
    )
    parser.add_argument("--package-name", required=True)
    parser.add_argument("--binary-name", help="CLI name (defaults to package-name)")
    parser.add_argument("--version", required=True)
    parser.add_argument("--output-dir", type=Path, default=Path("dist"))
    parser.add_argument("--summary", default="")
    parser.add_argument("--author", default="")
    parser.add_argument("--home-page", default="")
    parser.add_argument("--license", default="")

    args = parser.parse_args()
    binary_name = args.binary_name or args.package_name

    metadata_kwargs = {
        "summary": args.summary,
        "author": args.author,
        "home_page": args.home_page,
        "license_name": args.license,
    }

    print(f"Building wheels for {args.package_name} v{args.version}")
    print(f"Looking for binaries in: {args.binary_dir}")

    built = []
    for target_dir in sorted(args.binary_dir.iterdir()):
        if not target_dir.is_dir():
            continue
        rust_target = target_dir.name
        if rust_target not in TARGET_MAP:
            print(f"  ⚠ Skipping unknown target: {rust_target}")
            continue

        # Find the binary
        if "windows" in rust_target or "msvc" in rust_target:
            binary_path = target_dir / (binary_name + ".exe")
        else:
            binary_path = target_dir / binary_name

        if not binary_path.exists():
            print(f"  ⚠ Binary not found for {rust_target}: {binary_path}")
            continue

        whl = build_wheel(
            binary_path=binary_path,
            rust_target=rust_target,
            package_name=args.package_name,
            binary_name=binary_name,
            version=args.version,
            output_dir=args.output_dir,
            metadata_kwargs=metadata_kwargs,
        )
        built.append(whl)

    print(f"\nBuilt {len(built)} wheels in {args.output_dir}/")
    print("Upload with: uvx twine upload dist/*")


if __name__ == "__main__":
    main()
```

---

## 4. GitHub Actions CI Pipeline

This is the CI workflow that compiles the Tauri app for each platform, then
packages and publishes the wheels.

```yaml
# .github/workflows/release.yml
name: Release

on:
  push:
    tags:
      - "v*"

permissions:
  contents: write  # For creating GitHub releases

env:
  PACKAGE_NAME: sleap-app
  BINARY_NAME: sleap-app

jobs:
  # ── Step 1: Build the Tauri binary for each platform ──────────────────
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - os: ubuntu-22.04
            rust-target: x86_64-unknown-linux-gnu
          - os: ubuntu-22.04-arm
            rust-target: aarch64-unknown-linux-gnu
          - os: macos-13        # Intel runner
            rust-target: x86_64-apple-darwin
          - os: macos-14        # Apple Silicon runner
            rust-target: aarch64-apple-darwin
          - os: windows-latest
            rust-target: x86_64-pc-windows-msvc

    runs-on: ${{ matrix.os }}

    steps:
      - uses: actions/checkout@v4

      - name: Install Rust
        uses: dtolnay/rust-toolchain@stable
        with:
          targets: ${{ matrix.rust-target }}

      - name: Install system dependencies (Linux)
        if: runner.os == 'Linux'
        run: |
          sudo apt-get update
          sudo apt-get install -y \
            libwebkit2gtk-4.1-dev \
            libappindicator3-dev \
            librsvg2-dev \
            patchelf

      - name: Install Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install frontend dependencies
        run: npm ci

      # ── Build option A: Full Tauri build ──
      # This produces the bundled app (.deb, .dmg, .msi, etc.)
      # We extract just the binary from the build artifacts.
      #
      # - name: Build Tauri app
      #   uses: tauri-apps/tauri-action@v0
      #   with:
      #     tauriScript: npx tauri

      # ── Build option B: Cargo build (just the binary) ──
      # Simpler, produces just the raw binary. This is what we want for
      # the wheel — the Python wrapper handles launching.
      - name: Build binary
        run: |
          cd src-tauri
          cargo build --release --target ${{ matrix.rust-target }}

      - name: Stage binary for packaging
        shell: bash
        run: |
          mkdir -p artifacts/${{ matrix.rust-target }}
          if [[ "${{ matrix.rust-target }}" == *"windows"* ]]; then
            cp src-tauri/target/${{ matrix.rust-target }}/release/${BINARY_NAME}.exe \
               artifacts/${{ matrix.rust-target }}/
          else
            cp src-tauri/target/${{ matrix.rust-target }}/release/${BINARY_NAME} \
               artifacts/${{ matrix.rust-target }}/
          fi

      # ── macOS code signing (optional but recommended) ──
      - name: Sign binary (macOS)
        if: runner.os == 'macOS'
        env:
          APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
          APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
          APPLE_ID: ${{ secrets.APPLE_ID }}
          APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
          APPLE_PASSWORD: ${{ secrets.APPLE_APP_PASSWORD }}
        run: |
          # Import certificate
          echo "$APPLE_CERTIFICATE" | base64 --decode > certificate.p12
          security create-keychain -p "" build.keychain
          security import certificate.p12 -k build.keychain \
            -P "$APPLE_CERTIFICATE_PASSWORD" -T /usr/bin/codesign
          security set-key-partition-list -S apple-tool:,apple: \
            -s -k "" build.keychain

          # Sign
          codesign --force --options runtime \
            --sign "Developer ID Application: Your Name ($APPLE_TEAM_ID)" \
            artifacts/${{ matrix.rust-target }}/${BINARY_NAME}

          # Notarize
          zip -j binary.zip artifacts/${{ matrix.rust-target }}/${BINARY_NAME}
          xcrun notarytool submit binary.zip \
            --apple-id "$APPLE_ID" \
            --team-id "$APPLE_TEAM_ID" \
            --password "$APPLE_PASSWORD" \
            --wait

      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: binary-${{ matrix.rust-target }}
          path: artifacts/

  # ── Step 2: Package into wheels and publish ───────────────────────────
  publish:
    needs: build
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Download all binary artifacts
        uses: actions/download-artifact@v4
        with:
          path: artifacts/
          merge-multiple: true

      - name: Show artifact layout
        run: find artifacts/ -type f | head -20

      - name: Install Python
        uses: actions/setup-python@v5
        with:
          python-version: "3.12"

      - name: Build wheels
        run: |
          python tauri_to_wheel.py \
            --binary-dir ./artifacts \
            --package-name ${{ env.PACKAGE_NAME }} \
            --binary-name ${{ env.BINARY_NAME }} \
            --version ${GITHUB_REF_NAME#v} \
            --summary "SLEAP GUI — pose estimation labeling and analysis" \
            --author "Talmo Pereira" \
            --home-page "https://github.com/talmolab/sleap" \
            --license "BSD-3-Clause"

      - name: Publish to PyPI
        env:
          TWINE_USERNAME: __token__
          TWINE_PASSWORD: ${{ secrets.PYPI_TOKEN }}
        run: |
          pip install twine
          twine upload dist/*

      # Also create a GitHub Release with the wheels attached
      - name: Create GitHub Release
        uses: softprops/action-gh-release@v2
        with:
          files: dist/*.whl
          generate_release_notes: true
```

---

## 5. Integration with the `sleap` Package

### 5a. pyproject.toml for `sleap`

```toml
[project]
name = "sleap"
# ... existing config ...

[project.optional-dependencies]
gui = ["sleap-app>=0.1.0"]

[project.scripts]
# Existing CLI entry points stay the same
sleap-train = "sleap.training:main"
sleap-track = "sleap.tracking:main"
# ...

# New: launch the Tauri GUI
sleap-label = "sleap.gui:launch"
```

### 5b. sleap/gui.py — the bridge module

```python
"""
Bridge between the sleap Python package and the sleap-app Tauri binary.

This module provides the launch() function that is called by the
`sleap-label` console script entry point.
"""
import os
import subprocess
import sys


def _find_binary() -> str:
    """Locate the sleap-app binary.

    Resolution order:
    1. SLEAP_APP_BINARY environment variable (for development)
    2. The sleap-app Python package (installed via pip)
    3. `sleap-app` on PATH (manual install)
    """
    # 1. Env override
    env_path = os.environ.get("SLEAP_APP_BINARY")
    if env_path and os.path.isfile(env_path):
        return env_path

    # 2. The sleap-app package
    try:
        from sleap_app import get_binary_path
        return get_binary_path()
    except ImportError:
        pass

    # 3. PATH fallback
    import shutil
    path = shutil.which("sleap-app")
    if path:
        return path

    raise RuntimeError(
        "Could not find the SLEAP GUI binary.\n\n"
        "Install it with:\n"
        "  pip install sleap[gui]\n\n"
        "Or set the SLEAP_APP_BINARY environment variable to the path "
        "of a manually compiled sleap-app binary."
    )


def launch():
    """Launch the SLEAP GUI application.

    Called by the `sleap-label` console script entry point.
    Forwards all CLI arguments to the Tauri binary.
    """
    binary = _find_binary()

    # You can pass configuration to the Tauri app via CLI args or env vars.
    # For example, tell it where to find the Python backend:
    env = os.environ.copy()
    env.setdefault("SLEAP_PYTHON", sys.executable)

    if sys.platform == "win32":
        sys.exit(subprocess.call([binary] + sys.argv[1:], env=env))
    else:
        os.execvpe(binary, [binary] + sys.argv[1:], env)
```

---

## 6. pyproject.toml for `sleap-app`

This file is NOT used during wheel building (the wheel builder generates
its own METADATA). But it's useful to have in the repo for documentation
and for editable installs during development.

```toml
[project]
name = "sleap-app"
dynamic = ["version"]
description = "SLEAP GUI — pose estimation labeling and analysis"
license = "BSD-3-Clause"
requires-python = ">=3.8"
authors = [{ name = "Talmo Pereira" }]

[project.urls]
Homepage = "https://sleap.ai"
Repository = "https://github.com/talmolab/sleap"

[project.scripts]
sleap-app = "sleap_app:main"
```

---

## 7. Important Details and Gotchas

### Binary size and PyPI limits

- PyPI default per-file limit: **100 MB**
- Tauri binary (release, stripped): ~15–40 MB depending on frontend assets
- 5 platforms × 30 MB = **~150 MB total** per release
- If you exceed 100 MB per wheel, you can request a limit increase from PyPI,
  or strip the binary more aggressively.

Stripping the binary:

```toml
# In src-tauri/Cargo.toml
[profile.release]
strip = true          # Strip debug symbols
lto = true            # Link-time optimization
codegen-units = 1     # Better optimization (slower compile)
opt-level = "z"       # Optimize for size over speed
```

You can also `upx --best` the binary post-compilation (controversial but effective).

### macOS .app bundles vs raw binaries

**Raw binary (recommended to start):**
- Simpler packaging, same as Linux/Windows
- Works fine for Tauri — the webview still opens
- No dock icon, no proper Cmd+Q, menu bar shows "sleap-app" not "SLEAP"
- Users launch via terminal: `sleap-label` or `sleap-app`

**Full .app bundle (upgrade later):**
- Requires shipping a tarball inside the wheel, expanding on first run
- Or: provide a separate `sleap-app-install` command that downloads and
  installs the .app from GitHub Releases into /Applications
- Better native UX but more complexity
- Consider doing this only for the macOS wheels

Tauri's `cargo tauri build` produces both — you can extract the raw binary
from `target/release/sleap-app` without using the bundled `.app` at all.

### Code signing

**macOS:** Without signing, users get the "unidentified developer" dialog.
With signing + notarization, it Just Works. Cost: $99/year Apple Developer
Program. The CI workflow above includes the signing step.

**Windows:** Similar story with SmartScreen. An EV code signing certificate
eliminates the warning. More expensive (~$200-400/year) but worth it for
broad distribution. You can skip this initially.

**Linux:** No code signing needed.

### The `manylinux` compatibility question

The `manylinux_2_17` tag promises that the binary works on any Linux with
glibc ≥ 2.17 (CentOS 7+). For a Tauri binary, you need to be careful:

- Tauri depends on WebKitGTK, which is a *system* dependency
- The binary dynamically links against `libwebkit2gtk-4.1.so`
- This means the `manylinux` tag is technically a lie — the binary needs
  WebKitGTK installed on the target system

Options:
1. **Accept it.** Document that `sudo apt install libwebkit2gtk-4.1-dev` is
   required. This is already the case for any Tauri app on Linux.
2. **Use a custom platform tag** like `linux_x86_64` instead of `manylinux`.
   More honest but pip may refuse to install it in some configurations.
3. **Have the Python wrapper check for the dependency** and print a helpful
   error message if it's missing.

Option 3 is pragmatic. Add this to `sleap_app/__init__.py`:

```python
def _check_linux_deps():
    """Check for required system libraries on Linux."""
    if sys.platform != "linux":
        return
    import ctypes
    try:
        ctypes.cdll.LoadLibrary("libwebkit2gtk-4.1.so.0")
    except OSError:
        print(
            "Error: WebKitGTK is required but not installed.\n"
            "Install it with:\n"
            "  Ubuntu/Debian: sudo apt install libwebkit2gtk-4.1-dev\n"
            "  Fedora:        sudo dnf install webkit2gtk4.1-devel\n"
            "  Arch:          sudo pacman -S webkit2gtk-4.1\n",
            file=sys.stderr,
        )
        sys.exit(1)
```

### Version synchronization

You'll want `sleap`, `sleap-app`, and the Tauri/Cargo version to stay in sync
(or at least be compatible). Options:

- **Single version source:** Read the version from a shared file or environment
  variable in CI. The tag `v0.5.0` drives everything.
- **Compatibility ranges:** `sleap[gui]` depends on `sleap-app>=0.5,<0.6`
  so minor versions must match.
- **Protocol versioning:** If the IPC interface between Python and Tauri is
  versioned separately, the packages can evolve more independently.

### Testing the wheels locally

```bash
# Build a wheel for your current platform
python tauri_to_wheel.py \
  --binary-dir ./artifacts \
  --package-name sleap-app \
  --version 0.0.1.dev0 \
  --output-dir ./dist

# Test it in an isolated environment
uv run --with dist/sleap_app-0.0.1.dev0-py3-none-macosx_11_0_arm64.whl \
  sleap-app --version

# Or install it into a venv
python -m venv .venv && source .venv/bin/activate
pip install dist/sleap_app-0.0.1.dev0-py3-none-macosx_11_0_arm64.whl
sleap-app --version
```

### Using TestPyPI first

Always test with TestPyPI before publishing to the real PyPI:

```bash
uvx twine upload --repository testpypi dist/*

# Then test installation from TestPyPI
pip install --index-url https://test.pypi.org/simple/ sleap-app
```

---

## 8. Migration Path from Current SLEAP GUI

1. **Phase 0 (now):** Build the Tauri app, get it compiling for all platforms.
   Distribute via GitHub Releases only.

2. **Phase 1:** Set up `tauri_to_wheel.py` and the CI pipeline. Publish
   `sleap-app` to PyPI. Add `sleap[gui]` optional dependency. Keep the
   existing Qt GUI working in parallel.

3. **Phase 2:** Make `sleap-label` point to the Tauri app by default, with
   `SLEAP_USE_QT=1` env var to fall back to the old GUI. Deprecation
   warnings in the Qt GUI.

4. **Phase 3:** Remove the Qt GUI. `sleap-label` is now Tauri-only.
   The `sleap` package drops its heavy Qt/PySide dependencies from the
   default install, making it much lighter for headless/server use.

This last point is a big win — the Qt dependency tree is one of the most
painful parts of installing SLEAP today. Moving the GUI to a standalone
binary means `pip install sleap` becomes fast and conflict-free.

---

## 9. Alternative Approaches Considered

### maturin `bin` mode

[maturin](https://www.maturin.rs/bindings.html#bin) already supports packaging
Rust binaries as Python wheels. You could use it directly:

```bash
maturin build --bindings bin --target x86_64-unknown-linux-gnu
```

**Pros:** Mature, well-tested, handles edge cases.
**Cons:** Designed for `cargo` projects — may be awkward with Tauri's build
pipeline which also involves a Node.js frontend build step. Worth evaluating.

### Distributing via conda-forge

Many SLEAP users already use conda. You could publish the Tauri binary as a
conda package. Conda handles platform-specific binaries natively and doesn't
have the `manylinux` lying problem.

**Cons:** Slower review process, more complex recipe, two distribution channels.

### Just use GitHub Releases + a download script

The simplest approach: `sleap-label` downloads the binary from GitHub Releases
on first run and caches it locally.

**Cons:** Requires network on first run, version management is manual,
doesn't work offline, can't leverage pip/uv dependency resolution.

---

## Summary

The `go-to-wheel` pattern works for Tauri binaries with minimal adaptation.
The main new concerns are macOS .app bundles (skip for now, ship raw binary),
code signing (do it in CI), and Linux WebKitGTK dependencies (check at runtime).
The payoff is huge: `pip install sleap[gui]` gives users a native GUI without
them ever thinking about Rust, Tauri, or platform-specific downloads.