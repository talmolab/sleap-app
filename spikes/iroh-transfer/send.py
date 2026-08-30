#!/usr/bin/env python3
"""
Spike: iroh-blobs Case-B transfer -- SENDER side (run on the Mac laptop).

Flow proven here:  file -> python -> rust(sendme) -> wire

Python only hands sendme a *path* and reads its stdout for the ticket. The
gigabytes go disk -> sendme -> QUIC and never through this process -- which is
the whole point (the Rust<->Python boundary is never on the hot path).

Usage:
    python send.py /path/to/your.pkg.slp

Requires the pinned sendme binary (see scripts/get-sendme.sh):
    ./scripts/get-sendme.sh      # downloads ./bin/sendme
"""
import os
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent
SENDME = HERE / "bin" / "sendme"


def source_info(slp: Path) -> None:
    size = slp.stat().st_size
    print(f"[send] file: {slp}  ({size / 1e9:.2f} GB / {size:,} bytes)")
    try:
        import sleap_io as sio

        labels = sio.load_slp(str(slp))
        n_frames = len(labels.labeled_frames)
        n_inst = sum(len(lf.instances) for lf in labels.labeled_frames)
        print(
            f"[send] sleap-io: {n_frames} labeled frames, {n_inst} instances, "
            f"{len(labels.videos)} videos"
        )
        print("[send] ^ record these counts -- the receiver must match them.")
        print(f"[send]   receive.py ... --expect-frames {n_frames} --expect-instances {n_inst}")
    except Exception as e:  # noqa: BLE001 -- spike: any failure is just a skipped check
        print(f"[send] (sleap-io validation skipped: {e})")


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit("usage: python send.py /path/to/your.pkg.slp")
    slp = Path(sys.argv[1]).expanduser().resolve()
    if not slp.exists():
        sys.exit(f"no such file: {slp}")
    if not SENDME.exists():
        sys.exit(f"sendme not found at {SENDME} -- run ./scripts/get-sendme.sh first")

    source_info(slp)
    print(f"[send] starting sendme at {time.strftime('%H:%M:%S')} (Ctrl-C to stop serving) ...")

    # sendme prints a 'sendme receive <ticket>' line, then serves until Ctrl-C.
    proc = subprocess.Popen(
        [str(SENDME), "send", str(slp)],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env={**os.environ, "PYTHONUNBUFFERED": "1"},
    )
    ticket = None
    assert proc.stdout is not None
    for line in proc.stdout:
        sys.stdout.write(f"[sendme] {line}")
        sys.stdout.flush()
        m = re.search(r"sendme receive (\S+)", line)
        if m and not ticket:
            ticket = m.group(1)
            (HERE / "ticket.txt").write_text(ticket)
            print("\n" + "=" * 72)
            print("TICKET (copy to the Windows desktop):")
            print(ticket)
            print("(also written to ticket.txt)")
            print("=" * 72 + "\n", flush=True)
    proc.wait()


if __name__ == "__main__":
    main()
