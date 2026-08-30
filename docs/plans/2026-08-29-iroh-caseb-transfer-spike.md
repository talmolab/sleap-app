# iroh-blobs Case-B transfer spike (Mac → Windows, LAN)

**Purpose (one line):** Prove that an `iroh-blobs` transport can move a multi-GB `pkg.slp` from a
laptop to a remote GPU-worker desktop **fast** and **resumably**, then hand a valid file to Python —
de-risking a revival of SLEAP's remote-training feature (sleap-connect).

**Status:** Scaffolded, not yet run. Code lives at `spikes/iroh-transfer/` on branch
`spike/iroh-transfer` (worktree `../sleap-app-iroh-spike`). This doc is the plan; run it on two
machines and record numbers in `spikes/iroh-transfer/results.md`.

**Scope discipline:** This is a *throwaway* spike. It answers exactly one question and is then
deleted or folded into a productionization ticket. Resist scope creep — the non-goals in §9 are
non-goals on purpose.

---

## 1. The one question & success criteria

> Can `iroh-blobs` move a multi-GB `pkg.slp` from Mac → Windows **fast** (iroh isn't the
> bottleneck) and **resumably** (survives a kill / network drop with ~0 bytes re-sent), then hand a
> valid file to Python?

**Success is defined concretely — all three must hold for a GO:**

- **Fast.** Measured iroh throughput is **≥ ~70–80% of the iperf3 link ceiling** *and* in the same
  ballpark as `scp` on the identical link. (iperf3 = physical ceiling; scp = a familiar,
  battle-tested mover. Beating neither is fine; being far *below* either is the finding.)
- **Resumable.** All three interruption scenarios (§8) resume and complete, each re-sending
  **~0 bytes** beyond the last verified chunk — not restarting from zero.
- **Integrity / handoff.** `sleap-io` opens the received file on the Windows side and its
  frame / instance / video counts **match the source counts** that `send.py` printed. This closes
  the full `file → python → rust → wire → rust → python` loop.

Anything else (NAT, auth, real training) is out of scope — see §9.

---

## 2. Why Case B, and why "fast + resumable" is THE unknown

**Case B = desktop app ↔ remote lab/institution GPU worker.** Case A (browser + local worker) was
explicitly deprioritized: browser users get steered to install the desktop app, and iroh's browser
support is alpha / relay-only, so keeping it off the critical path is deliberate.

**Why this is the unknown worth spending a spike on:**

- There is **zero app-side upload path today**. sleap-connect's client/server upload half was never
  implemented app-side, so we cannot assume any transport works at scale.
- The prior verdict on the old WebRTC data-channel path (aiortc) was "**~20–80 Mbps, too slow**" for
  multi-GB projects. iroh-blobs runs over **QUIC** with BLAKE3-verified streaming and native resume.
  This spike **re-tests that "too slow" verdict on a modern transport** — that is the crux.

Everything downstream (auth, NAT traversal, sleap-RTC integration, training orchestration) is only
worth building if bulk transfer is fast and resumable. So we test that first, in isolation.

---

## 3. Architecture under test

```
[Mac laptop = SENDER]                        [Windows desktop = RECEIVER]
 send.py   (python)                           receive.py (python)
   | hands a *path* + prints ticket              ^ reads the *finished file*, validates
   v                                             |
 sendme   (rust / iroh-blobs) ==QUIC / LAN==>  sendme.exe (rust / iroh-blobs)
   file --------------------- disk → wire → disk --------------------- pkg.slp
```

**The load-bearing property:** the gigabytes go **disk → sendme → QUIC → sendme → disk** and
**never pass through Python**. Python only moves a *path* and a *ticket*, then reads the *finished*
file. That is precisely why the Rust↔Python boundary cannot bottleneck the transfer — the boundary
is off the hot path by construction.

**Product mapping (what each spike piece stands in for):**

| Spike piece      | Future production component                                            |
|------------------|-----------------------------------------------------------------------|
| `send.py` + sendme (Mac)     | Tauri app's existing Rust layer (`src-tauri/src/rtc.rs`)   |
| `receive.py` + sendme.exe (Win) | sleap-RTC worker's Rust transport component + Python handoff |
| `sendme` binary  | Stand-in transport engine; later replaced by our own iroh-blobs Rust component (§6, `rust/README.md`) |

Python's job in production stays identical to the spike: hand a path in, read a finished file out.

---

## 4. Two data flows — the bottleneck analysis (the owner's explicit question)

There are **two distinct flows** on this link and they must not be conflated:

**Flow 1 — Bulk file (`pkg.slp`).** GB-scale, one-shot, **throughput-bound**. Handled entirely by
iroh-blobs (BLAKE3-verified streaming, resumable). Bytes stay in Rust / on disk and never touch
Python. This is what the spike measures.

**Flow 2 — Training logs / telemetry (loss, progress from sleap-nn).** ~KB/s, continuous,
**latency-bound**. In production this rides a **separate bi-directional QUIC stream on the same
connection** (`Connection::open_bi` / `accept_bi`). Volume is tiny, so **neither iroh nor the
Rust↔Python interface can bottleneck it**.

**The design rule that keeps the boundary off every hot path:** *keep bulk bytes in Rust / on disk;
only small control messages cross the language boundary.* Under that rule, neither flow bottlenecks
at the Rust/Python interface — the bulk flow because bytes never cross it, the telemetry flow because
its volume is negligible.

**The one real telemetry gotcha is not iroh — it's Python stdio buffering.** If sleap-nn's log lines
sit in a pipe buffer they arrive late in bursts. Fix: `PYTHONUNBUFFERED=1` / `print(..., flush=True)`,
or use **ZMQ**, which is what sleap-nn already emits. This is a Phase-2 concern (§12), not part of the
throughput GO/NO-GO.

---

## 5. Engine decision: prebuilt `sendme` v0.36.0 on both ends

**Decision:** use the prebuilt **`sendme` v0.36.0** binary as the transport engine on *both*
machines, pinned to the same version.

**Why sendme, why prebuilt, why pinned:**

- It is the **canonical iroh-blobs file-transfer tool** — the reference implementation of exactly the
  send/receive-a-file-over-iroh-blobs behavior we're testing. Testing it *is* testing iroh-blobs.
- It ships a **`windows-x86_64.zip`** → **zero Rust toolchain on Windows**, which is the owner's
  priority for "easy receiving" on the lab desktop.
- **Same pinned version on both ends guarantees protocol compatibility** (the iroh-blobs wire /
  ticket format is not yet frozen across versions).

**Critical off-the-shelf finding — no pure-Python native blobs receiver exists.** The official iroh
Python bindings (iroh-ffi, `pip install iroh`, **1.0.0rc1**) **deliberately exclude iroh-blobs** —
higher-level protocols that aren't yet 1.0 are out of scope for the bindings. So you *cannot* build a
native-Python blobs receiver off the shelf. Our architecture sidesteps this entirely: **Rust owns
transport on both ends; Python only orchestrates + validates.** We never need Python blobs bindings.

**Cross-compile caveat (why we don't build our own binary yet).** Building a Windows binary from
macOS is unreliable because of the crypto crates (`aws-lc-sys` / `ring`). Build natively per-OS, or
keep using prebuilt `sendme`. Our own Rust sender/receiver is a **later** productionization step
(§6), not part of this spike.

---

## 6. Our own Rust component (future — recorded, not built here)

When we productionize, the receiver becomes a Rust component inside the **sleap-RTC worker** and the
sender becomes the **Tauri app's existing Rust layer**; the Python harness is unchanged. The current
iroh-blobs API (transcribed from the `sendme` source — **pin exact versions in `Cargo.toml` and
re-verify, this API churns**):

**Sender**
- `Endpoint::builder(presets::N0).alpns([iroh_blobs::protocol::ALPN]).bind()`, wrapped in a `Router`
  with the blobs handler; `FsStore`.
- `store.add_path_with_opts({ path, ImportMode::TryReference, BlobFormat::Raw })` — references the
  file **in place**, no multi-GB copy.
- `BlobTicket::new(endpoint.addr(), hash, BlobFormat::HashSeq)` (HashSeq = collection; carries the
  filename).

**Receiver**
- `endpoint.connect(ticket.addr(), iroh_blobs::protocol::ALPN)`.
- `store.remote().execute_get(conn, local.missing())` — **`local.missing()` IS the resume mechanism**
  (only the not-yet-received ranges are fetched; gated by `local.is_complete()`).
- `store.export_with_opts({ hash, target, ExportMode::Copy })`.

Full API notes + imports live in `spikes/iroh-transfer/rust/README.md`.

---

## 7. How to run

Two machines on the same LAN. **This Mac = sender/provider; the owner's Windows desktop = receiver.**

**Windows desktop (RECEIVER) — one-time setup, no Rust needed:**
```powershell
powershell -ExecutionPolicy Bypass -File scripts\get-sendme.ps1   # -> .\bin\sendme.exe (pins v0.36.0)
pip install sleap-io                                               # light: numpy/h5py/attrs, no torch
```

**This Mac (SENDER):**
```bash
./scripts/get-sendme.sh                     # -> ./bin/sendme (pins v0.36.0)
python send.py /path/to/your.pkg.slp        # prints a TICKET (also -> ticket.txt) + source N/M counts
```

**Back on Windows (RECEIVER) — paste the ticket:**
```powershell
python receive.py <TICKET> --out received --expect-frames <N> --expect-instances <M>
```
`send.py` prints the source `<N>` frames / `<M>` instances to pass to `--expect-*`; `receive.py`
re-opens the received file with sleap-io and asserts the counts match.

All four scripts (`send.py`, `receive.py`, `scripts/get-sendme.sh`, `scripts/get-sendme.ps1`) are
already scaffolded under `spikes/iroh-transfer/`.

---

## 8. Measurement protocol (summary — full detail in `measure.md`, log in `results.md`)

Do the baselines **first** so you have a ceiling to compare against.

0. **Link ceiling — iperf3.** Win: `iperf3 -s`; Mac: `iperf3 -c <win-ip> -t 10`. Record Mbps.
   (GbE ≈ 940 Mbps ≈ 118 MB/s; 2.5GbE ≈ 295 MB/s.)
1. **Familiar-mover baseline — scp.** `time scp your.pkg.slp <user>@<win-ip>:C:/tmp/`. Record MB/s.
   This is the number to be "in the ballpark" of.
2. **iroh throughput (the spike).** Run `send.py` → `receive.py` for **both** a ~1–2 GB file and the
   real **~5–7 GB** `pkg.slp`. Compare iroh MB/s vs the iperf3 ceiling and scp. **Target: iroh ≥
   ~70–80% of ceiling and in scp's ballpark ⇒ iroh is not the bottleneck.**
3. **Resume (the other half of "fast").** Re-run the **same** `receive.py <ticket>` after each
   interruption; sendme keeps partial data in its on-disk store and should *continue*:
   - **(a)** Ctrl-C / taskkill the receiver at ~50%, then re-run → resumes.
   - **(b)** Disable the Windows network adapter ~10 s mid-transfer, re-enable → continues.
   - **(c)** Briefly sleep the Mac sender, wake → resumes.
   Record for each: did it resume? roughly how many bytes were re-sent (target ~0)? sendme's progress
   output shows bytes transferred.
4. **Integrity + handoff.** `receive.py` prints frame/instance/video counts from the received file;
   confirm they match the source. Closes the `file → python → rust → wire → rust → python` loop.

---

## 9. Non-goals (explicitly deferred to future spikes)

- **NAT traversal / relay / real WAN.** This is a **LAN test** — it validates *throughput + resume
  mechanics only*. NAT/relay/WAN behavior is a separate follow-up spike.
- **Auth / identity.** Dial-by-key vs OAuth + Ed25519 — deferred.
- **App + sleap-RTC integration.** Wiring into the real Tauri app and the sleap-RTC worker.
- **Cloud-staging comparison** (e.g. transfer via an intermediary bucket).
- **Building the `pkg.slp`.** Assume it's on disk; the desktop streaming builder already produces it.
- **End-to-end training.** No sleap-nn run; telemetry is Phase 2 only.

---

## 10. Risks & gotchas

- **QUIC single-stream throughput on high-BDP links.** On a LAN this is a non-issue, but a single
  QUIC stream can under-fill a high bandwidth-delay-product (long-fat) WAN pipe. **Flag for the WAN
  follow-up**, not this spike — but note it now so a great LAN number isn't over-read as a WAN
  guarantee.
- **A LAN cannot reveal NAT problems.** Success here says nothing about connectivity across
  institutional firewalls / NAT. That's deliberate (§9) — don't conflate "fast on LAN" with
  "connects in the wild."
- **macOS firewall prompt for inbound.** The Mac sender listens for an inbound QUIC connection; macOS
  may pop an "allow incoming connections" prompt for the sendme process. Allow it, or the receiver
  can't dial in.
- **sendme store / resume behavior must be verified, not assumed.** Resume depends on sendme keeping
  partial data in its on-disk store between runs. Confirm the store location persists across a
  killed run and that re-running the same ticket continues rather than restarts (that's exactly what
  scenario 3a tests).
- **Python stdio buffering (telemetry only).** Not a throughput risk; relevant only in Phase 2.
  `PYTHONUNBUFFERED=1` / `flush=True` / ZMQ.
- **Version skew.** Both ends must be sendme **v0.36.0**; a mismatch can fail on ticket/wire format.
  The `get-sendme` scripts pin the version — don't hand-swap one side.

---

## 11. GO / NO-GO and next step

**GO** — iroh ≥ ~70–80% of ceiling *and* in scp's ballpark, all three resume scenarios continue with
~0 bytes re-sent, and counts match:
> iroh-blobs is a viable Case-B bulk transport. **Next:** the **NAT / relay / WAN follow-up spike**
> (two machines on different networks), then design the auth model and the sleap-RTC + Tauri
> integration. The prior "too slow" (aiortc) verdict is overturned for QUIC.

**NO-GO** — iroh is far below scp/ceiling, or resume re-sends large amounts, or integrity fails:
> Capture *where* it fell down. If **throughput** is the problem, investigate QUIC/iroh tuning
> (congestion control, stream config) before abandoning; re-baseline. If **resume** is the problem,
> dig into sendme's store semantics — it may be a usage/config issue, not a protocol limit. If
> integrity fails, that's a blocker independent of speed. A NO-GO likely reopens the transport
> question (revisit alternatives), but only after the failure mode is understood.

---

## 12. Optional Phase 2 — telemetry latency (brief)

Answers "would training logs bottleneck at the Rust↔Python boundary?" **empirically**, not by
argument. Not required for the throughput GO/NO-GO.

- Open a **second bi-directional QUIC stream** on the same connection carrying ~100 small JSON
  lines/sec (stand-in for sleap-nn loss/progress).
- Measure **per-line round-trip latency**. Expectation: ≈ LAN RTT, with boundary overhead negligible
  — confirming the §4 analysis that small control messages crossing the language boundary don't
  bottleneck.
- Exercise the stdio-buffering fix (`PYTHONUNBUFFERED=1` / `flush=True` / ZMQ) so lines arrive
  promptly rather than in buffered bursts.
