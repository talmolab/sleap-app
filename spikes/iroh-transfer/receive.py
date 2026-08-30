#!/usr/bin/env python3
"""
Spike: iroh-blobs Case-B transfer -- RECEIVER side (run on the Windows desktop).

Flow proven here:  wire -> rust(sendme) -> python

sendme writes the file to disk; this process only reads the *finished* file via
sleap-io. The gigabytes never pass through Python.

Usage:
    python receive.py <ticket> [--out DIR] [--expect-frames N] [--expect-instances M]

One-time setup (easy -- no Rust toolchain):
    powershell -ExecutionPolicy Bypass -File scripts\\get-sendme.ps1   # -> .\\bin\\sendme.exe
    pip install sleap-io

Resume test: just re-run this SAME command after interrupting -- sendme keeps
partial data in its on-disk store and continues instead of restarting.
"""
import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent
SENDME = HERE / "bin" / ("sendme.exe" if os.name == "nt" else "sendme")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("ticket")
    ap.add_argument("--out", default="received")
    ap.add_argument("--expect-frames", type=int, default=None)
    ap.add_argument("--expect-instances", type=int, default=None)
    args = ap.parse_args()

    if not SENDME.exists():
        sys.exit(f"sendme not found at {SENDME} -- run scripts/get-sendme.ps1 first")
    out = Path(args.out)
    out.mkdir(exist_ok=True)

    print(f"[recv] downloading into {out.resolve()} ...", flush=True)
    t0 = time.time()
    r = subprocess.run([str(SENDME), "receive", args.ticket], cwd=str(out))
    elapsed = time.time() - t0
    if r.returncode != 0:
        sys.exit(f"[recv] sendme exited {r.returncode}")

    # Find the received file (largest .slp, else largest new file).
    slps = sorted(out.glob("*.slp"), key=lambda p: p.stat().st_size, reverse=True)
    files = slps or sorted(
        (p for p in out.iterdir() if p.is_file()),
        key=lambda p: p.stat().st_size,
        reverse=True,
    )
    if not files:
        sys.exit("[recv] no received file found")
    got = files[0]
    size = got.stat().st_size
    print(
        f"[recv] received {got.name}  ({size / 1e9:.2f} GB) in {elapsed:.1f}s "
        f"=> {size / 1e6 / elapsed:.1f} MB/s (wall-clock; see sendme's own stats too)",
        flush=True,
    )

    try:
        import sleap_io as sio

        labels = sio.load_slp(str(got))
        n_frames = len(labels.labeled_frames)
        n_inst = sum(len(lf.instances) for lf in labels.labeled_frames)
        print(
            f"[recv] sleap-io OK: {n_frames} labeled frames, {n_inst} instances, "
            f"{len(labels.videos)} videos"
        )
        if args.expect_frames is not None:
            print(f"[recv] frames match:    {n_frames == args.expect_frames} "
                  f"({n_frames} vs {args.expect_frames})")
        if args.expect_instances is not None:
            print(f"[recv] instances match: {n_inst == args.expect_instances} "
                  f"({n_inst} vs {args.expect_instances})")
    except Exception as e:  # noqa: BLE001 -- spike: surface but don't crash the run
        print(f"[recv] sleap-io validation FAILED: {e}")


if __name__ == "__main__":
    main()
