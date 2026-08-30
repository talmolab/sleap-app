# Spike: iroh-blobs Case-B transfer (Mac → Windows, LAN)

**The one question this spike answers (and nothing more):**
Can an iroh-blobs transport move a multi-GB `pkg.slp` from this laptop to a
desktop **fast** (iroh isn't the bottleneck) and **resumably** (survives a kill /
network drop with ~0 bytes re-sent), then hand a valid file to Python?

Throwaway de-risking spike for **Case B** = *desktop app ↔ remote GPU worker*.
Full plan: [`docs/plans/2026-08-29-iroh-caseb-transfer-spike.md`](../../docs/plans/2026-08-29-iroh-caseb-transfer-spike.md).

## Architecture under test

```
[Mac laptop = SENDER]                    [Windows desktop = RECEIVER]
 send.py  (python)                        receive.py (python)
   | hands a *path*                          ^ reads the *finished file*
   v                                         |
 sendme (rust / iroh-blobs) ==QUIC/LAN==>  sendme.exe (rust / iroh-blobs)
   file ------------------ disk -> wire -> disk ------------------ pkg.slp
```

The gigabytes go **disk → sendme → wire → sendme → disk** — they never pass
through Python. Python only moves a path, a ticket, and reads the final file.
That is exactly why the Rust↔Python boundary cannot bottleneck the transfer.

**Engine:** prebuilt [`sendme`](https://github.com/n0-computer/sendme) **v0.36.0**
— the canonical iroh-blobs file-transfer tool — pinned to the same version on
both machines. No Rust toolchain required (especially on Windows). If/when we
build our own transport component, it drops in behind the same Python harness
(see [`rust/README.md`](rust/README.md)).

## Quick start

### On the Windows desktop (RECEIVER) — one-time setup, no Rust needed
```powershell
powershell -ExecutionPolicy Bypass -File scripts\get-sendme.ps1   # -> .\bin\sendme.exe
pip install sleap-io                                               # light: numpy/h5py/attrs, no torch
```

### On this Mac (SENDER)
```bash
./scripts/get-sendme.sh                     # -> ./bin/sendme
python send.py /path/to/your.pkg.slp        # prints a TICKET (also -> ticket.txt)
```

### Back on Windows (RECEIVER) — paste the ticket
```powershell
python receive.py <TICKET> --out received --expect-frames <N> --expect-instances <M>
```
`send.py` prints the source `<N>`/`<M>` counts to compare against.

## What to measure

See [`measure.md`](measure.md); record results in [`results.md`](results.md). In short:
- **Baselines:** `iperf3` (link ceiling) and `scp` (a familiar mover) on the same link.
- **Throughput:** run for ~1–2 GB and your ~5–7 GB `pkg.slp`; compare iroh MB/s vs scp vs ceiling.
- **Resume:** kill the receiver at ~50% and re-run the same command; drop Windows
  networking ~10 s mid-transfer; briefly sleep the Mac. Each should resume with
  ~0 bytes re-sent.

## Non-goals (future spikes)
NAT traversal / relay / real WAN · dial-by-key replacing OAuth+Ed25519 · wiring
into the real Tauri app + sleap-RTC · cloud-staging comparison · *building* the
`pkg.slp` (assume it's on disk — the desktop streaming builder already does that).
