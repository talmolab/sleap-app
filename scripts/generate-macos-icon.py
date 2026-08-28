#!/usr/bin/env python3
"""Regenerate the macOS app icon (src-tauri/icons/icon.icns) as a rounded-square
"squircle" with the standard macOS safe-area padding, from the full-bleed
app-icon.png master.

Why: the repo's app-icon.png is a full-bleed square with no alpha/rounding. On
macOS < Tahoe the OS renders the .icns verbatim, so the Dock/Finder icon is a
large SHARP square. macOS 26 (Tahoe) auto-masks it into a squircle, which is why
it only looks right there. Baking the standard rounded-square grid (content in an
~824/1024 safe area with rounded corners) fixes the sharp square on < Tahoe.

Scope: ONLY icon.icns is regenerated. Windows icon.ico and the Linux PNGs stay
full-bleed on purpose (the reported bug is macOS-only). Re-run this whenever
app-icon.png changes; do NOT `tauri icon` from app-icon.png alone or the fixed
.icns will be overwritten with a full-bleed square again.

Usage: python3 scripts/generate-macos-icon.py [--preview OUT.png]
"""
import argparse
import os
import subprocess
import tempfile
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "app-icon.png")
OUT_ICNS = os.path.join(ROOT, "src-tauri", "icons", "icon.icns")

CANVAS = 1024            # full icon canvas
CONTENT = 824            # rounded body size (macOS icon grid, ~80.5% of canvas)
RADIUS = 185             # corner radius (~22.4% of content), approximates the squircle
SS = 4                   # supersample factor for smooth mask edges


def build_master() -> Image.Image:
    base = Image.open(SRC).convert("RGBA").resize((CONTENT, CONTENT), Image.LANCZOS)
    mask = Image.new("L", (CONTENT * SS, CONTENT * SS), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, CONTENT * SS - 1, CONTENT * SS - 1], radius=RADIUS * SS, fill=255
    )
    base.putalpha(mask.resize((CONTENT, CONTENT), Image.LANCZOS))
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    off = (CANVAS - CONTENT) // 2
    canvas.paste(base, (off, off), base)
    return canvas


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--preview", help="also write the padded master PNG here for review")
    args = ap.parse_args()

    master = build_master()
    if args.preview:
        master.save(args.preview)

    specs = [(16, 1), (16, 2), (32, 1), (32, 2), (128, 1), (128, 2),
             (256, 1), (256, 2), (512, 1), (512, 2)]
    with tempfile.TemporaryDirectory() as tmp:
        iconset = os.path.join(tmp, "icon.iconset")
        os.makedirs(iconset)
        for size, scale in specs:
            px = size * scale
            suffix = "@2x" if scale == 2 else ""
            master.resize((px, px), Image.LANCZOS).save(
                os.path.join(iconset, f"icon_{size}x{size}{suffix}.png")
            )
        subprocess.run(["iconutil", "-c", "icns", "-o", OUT_ICNS, iconset], check=True)
    print("wrote", OUT_ICNS)


if __name__ == "__main__":
    main()
