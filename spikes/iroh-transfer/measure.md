# Measurement protocol

Run everything on the **same LAN**. Do the baselines first so you have a ceiling
to compare iroh against. Record everything in `results.md`.

## 0. Link ceiling — iperf3
- Windows desktop: `iperf3 -s`
- Mac: `iperf3 -c <windows-ip> -t 10`

Record Mbits/sec → the physical ceiling. (Gigabit ≈ 940 Mbps ≈ 118 MB/s;
2.5GbE ≈ 295 MB/s.) Install: `brew install iperf3` (Mac); a Windows build is on
the iperf3 site.

## 1. Familiar-mover baseline — scp
- Mac: `time scp /path/to/your.pkg.slp <user>@<windows-ip>:C:/tmp/`

Record MB/s (filesize ÷ seconds). (OpenSSH ships with Windows 10+; enable the
"OpenSSH Server" optional feature if scp refuses to connect.) This is the number
to beat — if iroh isn't at least in scp's ballpark, that's a finding.

## 2. iroh throughput (the spike)
- Mac: `python send.py /path/to/your.pkg.slp`   → copy the ticket
- Windows: `python receive.py <ticket> --out received`

Do this for BOTH sizes:
- a ~1–2 GB file (a smaller pkg.slp, or `head -c 1500000000 /dev/urandom > big.bin`)
- your real ~5–7 GB pkg.slp

Compare iroh MB/s vs the iperf3 ceiling and scp. **Target: iroh ≥ ~70–80% of the
ceiling and in scp's ballpark → iroh is not the bottleneck.**

## 3. Resume (the other half of "fast")
Re-run the SAME `receive.py <ticket>` command after each interruption — sendme
keeps partial data in its on-disk store and should continue, not restart:
- **a)** Ctrl-C / taskkill the receiver at ~50%, then re-run → confirm it resumes.
- **b)** Disable the Windows network adapter ~10 s mid-transfer, re-enable → confirm continue.
- **c)** Briefly sleep the Mac sender, wake → confirm the transfer resumes.

Record: did it resume? roughly how many bytes were re-sent (target ~0 beyond the
last verified chunk)? sendme's own progress output shows bytes transferred.

## 4. Integrity + handoff
`receive.py` opens the received file with sleap-io and prints frame/instance/video
counts. Confirm they match the source counts `send.py` printed. That closes the
**file → python → rust → wire → rust → python** loop.

## (Optional) Phase 2 — telemetry channel
Answers "would training logs bottleneck at the Rust↔Python boundary?" empirically.
Not needed for the throughput GO/NO-GO; see the plan doc for the design (a second
bi-directional QUIC stream carrying ~100 small JSON lines/sec; measure per-line
round-trip latency — expected ≈ LAN RTT, boundary overhead negligible).
