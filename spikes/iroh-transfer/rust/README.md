# (Optional, later) Our own Rust transport component

The spike uses prebuilt `sendme` as the transport engine so the Windows side needs
zero toolchain. When we productionize, the receiver becomes a Rust component inside
the **sleap-RTC worker**, and the sender becomes the **Tauri app's existing Rust
layer** (`src-tauri/src/rtc.rs`). Neither change touches the Python harness —
Python still just hands a path / reads the finished file.

Current iroh-blobs API (transcribed from the `sendme` source; pin exact versions in
`Cargo.toml` and re-verify, this API churns):

**Sender**
- `Endpoint::builder(presets::N0).alpns(vec![iroh_blobs::protocol::ALPN.to_vec()]).bind()`, wrapped in a `Router` with the blobs handler
- `FsStore` → `store.add_path_with_opts({ path, ImportMode::TryReference, BlobFormat::Raw })` (references the file in place — no multi-GB copy)
- `BlobTicket::new(endpoint.addr(), hash, BlobFormat::HashSeq)` (HashSeq = collection; carries the filename)

**Receiver**
- `endpoint.connect(ticket.addr(), iroh_blobs::protocol::ALPN)`
- `store.remote().execute_get(conn, local.missing())` — **`local.missing()` is the resume mechanism** (only the not-yet-received ranges are fetched; gated by `local.is_complete()`)
- `store.export_with_opts({ hash, target, ExportMode::Copy })`

**Telemetry channel (training logs)** — a separate bi-directional QUIC stream on the
SAME connection (`Connection::open_bi` / `accept_bi`). Tiny volume, latency-bound,
never a bottleneck. Design rule: keep bulk bytes in Rust/on disk; only small control
messages cross the language boundary.

**Imports**
```rust
use iroh::{Endpoint, EndpointAddr, RelayMode};
use iroh_blobs::{
    api::{Store, TempTag, blobs::{AddPathOptions, ImportMode}},
    ticket::BlobTicket,
    BlobFormat,
};
```

**Cross-compile caveat:** building a Windows binary from macOS is unreliable
(crypto crates: aws-lc-sys / ring). Build natively on each OS, or keep using the
prebuilt `sendme` until the component is worth productionizing.
