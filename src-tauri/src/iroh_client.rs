//! iroh QUIC transport for the desktop app's protocol-v1 client (item 2.3).
//!
//! This is the dial-only counterpart to sleap-connect's worker-side iroh
//! endpoint (`sleap_rtc/protocol_v1/iroh_transport.py`, item 2.2): it never
//! accepts connections, it only opens one bidirectional QUIC stream to a
//! worker and forwards framed protocol-v1 envelope JSON to/from the
//! frontend's `WorkerClient` (`src/lib/protocolV1/client.ts`) unchanged.
//! Unlike `rtc.rs` (the legacy WebRTC role this replaces for iroh
//! connections), this module is a dumb byte pipe, not a second protocol
//! implementation: all hello/auth/job dispatch logic stays in TypeScript
//! and is shared unchanged between the browser (raw `WebSocket`) and desktop
//! (this module) transports, via `WorkerClient`'s injectable `createSocket`
//! (built for exactly this purpose in item 1.7).
//!
//! Wire framing must match `iroh_transport.py`'s `IrohStreamTransport`
//! exactly: a 4-byte big-endian length prefix, then that many bytes of
//! UTF-8 JSON, over a single `BiStream` for the connection's lifetime. The
//! ALPN must match too — a mismatched ALPN is a different application
//! entirely to iroh, not a malformed request.
//!
//! Identity: this endpoint intentionally does NOT reuse the app's
//! protocol-v1 Ed25519 identity (`src/lib/protocolV1/identity.ts`, which
//! also isn't guaranteed to be exportable out of the browser's IndexedDB/
//! WebCrypto storage) as its iroh `SecretKey`. The worker does this pairing
//! (item 2.2) because it's dialed *by* its `node_id`, so its transport-level
//! and application-level identities need to be the same key. This side only
//! ever dials out and is never addressed by its own iroh identity, so a
//! fresh, ephemeral iroh identity per connection (iroh's own default when no
//! `secret_key` is set) is simplest and correct — protocol-v1's own
//! hello/pairing/auth re-authenticates independently at the application
//! layer regardless of which transport carries it.
//!
//! Relay/discovery: uses iroh's own `N0` preset (n0's public relay +
//! discovery), mirroring what the worker's `runner.py` uses today with no
//! override (`iroh.EndpointOptions(secret_key=..., alpns=[ALPN])`, no custom
//! relay config). Pointing both ends at a self-hosted relay/DNS server
//! instead is item 2.5 (not started) — not bundled here.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use iroh::{
    endpoint::{presets, Connection, RecvStream, SendStream},
    Endpoint, EndpointAddr, PublicKey, RelayUrl,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::time::{timeout, Duration};

/// Must match the worker's `sleap_rtc/protocol_v1/iroh_transport.py::ALPN`
/// byte-for-byte.
const ALPN: &[u8] = b"sleap-connect/protocol-v1";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);

/// Everything needed to dial a worker over iroh. `node_id` is the same
/// base64url (no padding) raw Ed25519 public key already used throughout
/// protocol v1 (`hello.node_id`, `identity.ts`'s `ClientIdentity`) — item
/// 2.2 confirmed the worker's iroh `EndpointId` and its `node_id` are
/// byte-identical, so no separate iroh-specific ID encoding is needed here.
///
/// `relay_url`/`direct_addrs` are accepted as plain, explicit fields rather
/// than a single opaque "ticket" string on purpose: item 2.1 (how a live
/// worker's iroh reachability info gets embedded in a pairing ticket) is
/// still unimplemented and its wire format undecided, so this command
/// doesn't assume one. Whatever 2.1 eventually produces should be decoded
/// into these same fields before calling `iroh_connect`.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IrohDialTarget {
    node_id: String,
    relay_url: Option<String>,
    direct_addrs: Option<Vec<String>>,
}

/// Pushed to the frontend over the `on_message` IPC channel. Mirrors what a
/// real `WebSocket`'s `onmessage`/`onclose`/`onerror` callbacks distinguish
/// — `tauriIrohSocket.ts` dispatches on `kind` to drive its
/// `WebSocketLike` adapter.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum IrohClientEvent {
    Message { data: String },
    Closed,
    Error { message: String },
}

/// Identifies one open connection. `iroh_connect` returns it, and every
/// later command for that connection names it — so connections from
/// different windows (each its own JS heap with its own `WorkerClient`s), or
/// to different workers from one window, never share a stream.
pub type ConnId = u32;

/// One worker connection: the endpoint it was dialed from, the control
/// stream's send half, and its blob stream slot. The send half and blob slot
/// each sit behind their own lock, so a slow write or blob read on one
/// connection never stalls another, and a blob read never stalls `iroh_send`
/// on its own connection.
struct IrohConn {
    /// Label of the webview that opened it — closed when that webview
    /// reloads or its window is destroyed ([`IrohClients::close_owned_by`]).
    owner: String,
    endpoint: Endpoint,
    connection: Connection,
    send: Arc<Mutex<SendStream>>,
    blob: Arc<Mutex<IrohBlobState>>,
}

impl IrohConn {
    async fn close(self) {
        self.connection.close(0u32.into(), b"client disconnect");
        self.endpoint.close().await;
    }
}

#[derive(Default)]
struct Registry {
    next_id: ConnId,
    conns: HashMap<ConnId, IrohConn>,
}

/// Every open iroh connection in the app, keyed by [`ConnId`]. Tauri-managed
/// and shared by all windows; cheap to clone (the reader task holds a clone
/// so it can drop its own connection when the stream ends).
#[derive(Clone, Default)]
pub struct IrohClients(Arc<Mutex<Registry>>);

impl IrohClients {
    async fn add(
        &self,
        owner: String,
        endpoint: Endpoint,
        connection: Connection,
        send: SendStream,
    ) -> ConnId {
        let mut r = self.0.lock().await;
        r.next_id = r.next_id.wrapping_add(1);
        let id = r.next_id;
        r.conns.insert(
            id,
            IrohConn {
                owner,
                endpoint,
                connection,
                send: Arc::new(Mutex::new(send)),
                blob: Arc::new(Mutex::new(IrohBlobState::default())),
            },
        );
        id
    }

    /// Clones what `f` picks out of connection `id` while holding the
    /// registry lock only that long.
    async fn with_conn<T>(&self, id: ConnId, f: impl FnOnce(&IrohConn) -> T) -> Result<T, String> {
        let r = self.0.lock().await;
        r.conns
            .get(&id)
            .map(f)
            .ok_or_else(|| "Not connected to a worker over iroh".to_string())
    }

    async fn send(&self, id: ConnId, msg: &str) -> Result<(), String> {
        let send = self.with_conn(id, |c| c.send.clone()).await?;
        let mut send = send.lock().await;
        write_frame(&mut send, msg).await
    }

    /// Removes and closes connection `id`. A no-op if it's already gone.
    async fn close(&self, id: ConnId) {
        let conn = self.0.lock().await.conns.remove(&id);
        if let Some(conn) = conn {
            conn.close().await;
        }
    }

    /// Closes every connection opened by webview `owner` — its JS side is
    /// gone (reload or window closed), so nothing will ever disconnect them.
    pub async fn close_owned_by(&self, owner: &str) {
        let owned: Vec<IrohConn> = {
            let mut r = self.0.lock().await;
            let ids: Vec<ConnId> = r
                .conns
                .iter()
                .filter(|(_, c)| c.owner == owner)
                .map(|(id, _)| *id)
                .collect();
            ids.iter().filter_map(|id| r.conns.remove(id)).collect()
        };
        for conn in owned {
            conn.close().await;
        }
    }
}

/// State for one connection's blob-reading stream (item 2.4), kept
/// **separate** from the control stream behind its own lock — a blob read in
/// progress (which can take a while over a slow/relayed path) must never
/// block `iroh_send`/`iroh_disconnect`, or vice versa. One blob stream per
/// connection: today's remote-merge flow fetches one job result at a time,
/// sequentially, so a single slot matches actual usage. A second
/// `iroh_blob_open` before `iroh_blob_close` replaces the slot outright,
/// dropping whatever stream was open before.
#[derive(Debug, Default)]
pub struct IrohBlobState {
    #[allow(dead_code)] // kept for debugging/future multi-slot support, not read today
    sha256: Option<String>,
    send: Option<SendStream>,
    recv: Option<RecvStream>,
}

fn decode_node_id(node_id: &str) -> Result<PublicKey, String> {
    let bytes = URL_SAFE_NO_PAD
        .decode(node_id)
        .map_err(|e| format!("Invalid node_id (not base64url): {e}"))?;
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|v: Vec<u8>| format!("node_id must decode to 32 bytes, got {}", v.len()))?;
    PublicKey::from_bytes(&arr).map_err(|e| format!("Invalid node_id (not an Ed25519 key): {e}"))
}

fn build_endpoint_addr(target: &IrohDialTarget) -> Result<EndpointAddr, String> {
    let id = decode_node_id(&target.node_id)?;
    let mut addr = EndpointAddr::new(id);
    if let Some(relay) = &target.relay_url {
        let relay_url: RelayUrl = relay
            .parse()
            .map_err(|e| format!("Invalid relay_url '{relay}': {e}"))?;
        addr = addr.with_relay_url(relay_url);
    }
    for a in target.direct_addrs.iter().flatten() {
        let sock: SocketAddr = a
            .parse()
            .map_err(|e| format!("Invalid direct address '{a}': {e}"))?;
        addr = addr.with_ip_addr(sock);
    }
    Ok(addr)
}

// ── Connect Command ──────────────────────────────────────────────

/// Binds a fresh endpoint under `preset` and dials `endpoint_addr`, opening
/// one bidirectional stream. Parameterized over the preset so tests can
/// dial with `presets::Minimal` (no relay/DNS, no external network
/// dependency) while the real command uses `presets::N0` — mirrors the
/// worker's own `iroh_preset` test-override in `runner.py`.
async fn dial(
    endpoint_addr: EndpointAddr,
    preset: impl iroh::endpoint::presets::Preset,
) -> Result<(Endpoint, Connection, SendStream, RecvStream), String> {
    let endpoint = Endpoint::bind(preset)
        .await
        .map_err(|e| format!("Failed to bind iroh endpoint: {e}"))?;

    let connection = match timeout(CONNECT_TIMEOUT, endpoint.connect(endpoint_addr, ALPN)).await {
        Ok(Ok(conn)) => conn,
        Ok(Err(e)) => {
            endpoint.close().await;
            return Err(format!("iroh connect failed: {e}"));
        }
        Err(_) => {
            endpoint.close().await;
            return Err("iroh connect timed out (20s)".to_string());
        }
    };

    let (send, recv) = match connection.open_bi().await {
        Ok(streams) => streams,
        Err(e) => {
            endpoint.close().await;
            return Err(format!("Failed to open iroh stream: {e}"));
        }
    };

    Ok((endpoint, connection, send, recv))
}

/// Dials a worker and returns the new connection's [`ConnId`], which the
/// caller passes to every later command for it. Each call is its own
/// connection — it never replaces another window's (or another worker's).
#[tauri::command]
pub async fn iroh_connect<R: tauri::Runtime>(
    target: IrohDialTarget,
    on_message: tauri::ipc::Channel<IrohClientEvent>,
    webview: tauri::Webview<R>,
    clients: tauri::State<'_, IrohClients>,
) -> Result<ConnId, String> {
    let endpoint_addr = build_endpoint_addr(&target)?;
    let (endpoint, connection, send, recv) = dial(endpoint_addr, presets::N0).await?;

    // Registered before the reader starts, so a stream that ends at once
    // still finds (and drops) its own entry.
    let id = clients
        .add(webview.label().to_string(), endpoint, connection, send)
        .await;
    spawn_reader(recv, on_message, clients.inner().clone(), id);
    Ok(id)
}

/// Writes one length-prefixed frame: a 4-byte big-endian length, then that
/// many UTF-8 bytes. Must match `iroh_transport.py`'s `IrohStreamTransport`
/// exactly — shared by the real `iroh_send` command and tests.
async fn write_frame(send: &mut SendStream, text: &str) -> Result<(), String> {
    let payload = text.as_bytes();
    send.write_all(&(payload.len() as u32).to_be_bytes())
        .await
        .map_err(|e| format!("iroh send (length prefix) failed: {e}"))?;
    send.write_all(payload)
        .await
        .map_err(|e| format!("iroh send failed: {e}"))
}

/// Reads one length-prefixed frame (the read-side counterpart of
/// [`write_frame`]). `Ok(None)` means the stream ended cleanly or abruptly —
/// per `iroh_transport.py`'s doc comment, iroh doesn't reliably distinguish
/// those and this protocol doesn't need to.
async fn read_frame(recv: &mut RecvStream) -> Result<Option<String>, String> {
    let mut header = [0u8; 4];
    if recv.read_exact(&mut header).await.is_err() {
        return Ok(None);
    }
    let len = u32::from_be_bytes(header) as usize;
    let mut payload = vec![0u8; len];
    if recv.read_exact(&mut payload).await.is_err() {
        return Ok(None);
    }
    String::from_utf8(payload)
        .map(Some)
        .map_err(|e| format!("Received non-UTF-8 frame: {e}"))
}

/// Forwards frames to the frontend until the stream ends (or the frontend
/// stops listening), then drops connection `id` so a worker-side close
/// doesn't leave its endpoint open.
fn spawn_reader(
    mut recv: RecvStream,
    on_message: tauri::ipc::Channel<IrohClientEvent>,
    clients: IrohClients,
    id: ConnId,
) {
    tokio::spawn(async move {
        loop {
            match read_frame(&mut recv).await {
                Ok(Some(text)) => {
                    if on_message
                        .send(IrohClientEvent::Message { data: text })
                        .is_err()
                    {
                        break;
                    }
                }
                Ok(None) => break,
                Err(message) => {
                    let _ = on_message.send(IrohClientEvent::Error { message });
                    break;
                }
            }
        }
        clients.close(id).await;
        let _ = on_message.send(IrohClientEvent::Closed);
    });
}

// ── Send Command ─────────────────────────────────────────────────

#[tauri::command]
pub async fn iroh_send(
    conn_id: ConnId,
    msg: String,
    clients: tauri::State<'_, IrohClients>,
) -> Result<(), String> {
    clients.send(conn_id, &msg).await
}

// ── Disconnect Command ────────────────────────────────────────────

#[tauri::command]
pub async fn iroh_disconnect(
    conn_id: ConnId,
    clients: tauri::State<'_, IrohClients>,
) -> Result<(), String> {
    clients.close(conn_id).await;
    Ok(())
}

// ── Blob Commands (item 2.4) ────────────────────────────────────────
//
// A blob is a job-result file (today, only a track job's `predictions.slp`)
// fetched by range — never the whole thing at once, see
// `docs/plans/2026-09-30-item-2-4-blob-over-iroh-design.md`. This module
// stays a dumb byte pipe here too: chunk-alignment and hash verification
// belong to the TypeScript caller (`tauriIrohBlob.ts`), which knows about
// `VERIFY_CHUNK_SIZE`/`chunkHashes` — these commands don't.

/// Shape of every `{ok, ...}` / `{ok:false, error}` JSON header the worker
/// sends on the blob stream (open response and each read response) — see
/// the design doc §6.1. Fields not present in a given response are `None`.
#[derive(Deserialize)]
struct BlobHeader {
    ok: bool,
    size: Option<u64>,
    error: Option<String>,
    #[serde(rename = "chunkSize")]
    chunk_size: Option<u64>,
    #[serde(rename = "chunkHashes")]
    chunk_hashes: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
pub struct IrohBlobOpenResult {
    size: u64,
    #[serde(rename = "chunkSize")]
    chunk_size: u64,
    #[serde(rename = "chunkHashes")]
    chunk_hashes: Vec<String>,
}

/// Core of `iroh_blob_open`, taking a plain `Connection` handle instead of
/// `tauri::State` — directly testable (mirrors [`dial`]'s role for
/// `iroh_connect`).
async fn open_blob_stream(
    connection: Connection,
    sha256: String,
) -> Result<(IrohBlobOpenResult, IrohBlobState), String> {
    let (mut send, mut recv) = connection
        .open_bi()
        .await
        .map_err(|e| format!("Failed to open blob stream: {e}"))?;

    write_frame(&mut send, &serde_json::json!({ "sha256": sha256 }).to_string()).await?;
    let header_text = read_frame(&mut recv)
        .await?
        .ok_or("Worker closed the blob stream before replying")?;
    let header: BlobHeader = serde_json::from_str(&header_text)
        .map_err(|e| format!("Malformed blob response header: {e}"))?;
    if !header.ok {
        return Err(header.error.unwrap_or_else(|| "blob open failed".into()));
    }
    let size = header.size.ok_or("Response missing size")?;
    let chunk_size = header.chunk_size.ok_or("Response missing chunkSize")?;
    let chunk_hashes = header.chunk_hashes.ok_or("Response missing chunkHashes")?;

    let result = IrohBlobOpenResult {
        size,
        chunk_size,
        chunk_hashes,
    };
    let state = IrohBlobState {
        sha256: Some(sha256),
        send: Some(send),
        recv: Some(recv),
    };
    Ok((result, state))
}

/// Opens a fresh stream on connection `conn_id` dedicated to reading one
/// blob, and replaces whatever blob stream that connection previously had
/// open (§1/§5 of the design doc scope this to one blob stream at a time).
#[tauri::command]
pub async fn iroh_blob_open(
    conn_id: ConnId,
    sha256: String,
    clients: tauri::State<'_, IrohClients>,
) -> Result<IrohBlobOpenResult, String> {
    // Only clone the handles under the registry lock — opening the new
    // stream and the read/write that follows must not hold it, or every
    // other connection's iroh_send would stall for the whole round trip.
    let (connection, blob) = clients
        .with_conn(conn_id, |c| (c.connection.clone(), c.blob.clone()))
        .await?;
    let (result, state) = open_blob_stream(connection, sha256).await?;
    *blob.lock().await = state;
    Ok(result)
}

/// Core of `iroh_blob_read_range`, taking a plain `&mut IrohBlobState`
/// instead of `tauri::State` — directly testable.
async fn read_blob_range(
    state: &mut IrohBlobState,
    offset: u64,
    length: u64,
) -> Result<Vec<u8>, String> {
    // Destructure both fields out of the same `&mut IrohBlobState` at once —
    // taking two sequential `.as_mut()` calls on a field borrows the whole
    // struct twice, which the borrow checker rejects even though the two
    // underlying fields never alias.
    let IrohBlobState { send, recv, .. } = state;
    let send = send
        .as_mut()
        .ok_or("No blob stream open — call iroh_blob_open first")?;
    let recv = recv.as_mut().ok_or("No blob stream open — call iroh_blob_open first")?;

    write_frame(
        send,
        &serde_json::json!({ "offset": offset, "length": length }).to_string(),
    )
    .await?;
    let header_text = read_frame(recv)
        .await?
        .ok_or("Worker closed the blob stream mid-read")?;
    let header: BlobHeader = serde_json::from_str(&header_text)
        .map_err(|e| format!("Malformed blob response header: {e}"))?;
    if !header.ok {
        return Err(header.error.unwrap_or_else(|| "blob read failed".into()));
    }
    let mut buf = vec![0u8; header.size.ok_or("Response missing size")? as usize];
    recv.read_exact(&mut buf)
        .await
        .map_err(|e| format!("Failed to read blob body: {e}"))?;
    Ok(buf)
}

/// Reads exactly `[offset, offset + length)` off the currently-open blob
/// stream — a dumb pipe, same as [`iroh_send`]: it forwards whatever
/// `offset`/`length` it's given verbatim and does no chunk-alignment or
/// hash verification itself (see this section's own header comment). The
/// caller is responsible for having called [`iroh_blob_open`] first.
#[tauri::command]
pub async fn iroh_blob_read_range(
    conn_id: ConnId,
    offset: u64,
    length: u64,
    clients: tauri::State<'_, IrohClients>,
) -> Result<Vec<u8>, String> {
    let blob = clients.with_conn(conn_id, |c| c.blob.clone()).await?;
    let mut b = blob.lock().await;
    read_blob_range(&mut b, offset, length).await
}

/// Ends connection `conn_id`'s open blob stream, if any. A no-op (not an
/// error) if nothing was open or the connection is already gone — mirrors
/// `dispose()`'s no-op-when-never-opened contract on the TypeScript side.
#[tauri::command]
pub async fn iroh_blob_close(
    conn_id: ConnId,
    clients: tauri::State<'_, IrohClients>,
) -> Result<(), String> {
    let Ok(blob) = clients.with_conn(conn_id, |c| c.blob.clone()).await else {
        return Ok(());
    };
    let mut b = blob.lock().await;
    if let Some(mut send) = b.send.take() {
        let _ = send.finish();
    }
    b.recv = None;
    b.sha256 = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    //! Real iroh endpoints, real QUIC streams, `presets::Minimal` (relay
    //! disabled, direct addresses only) on both sides — no external network
    //! dependency, mirroring `sleap-connect`'s own
    //! `tests/protocol_v1/test_iroh_transport.py` (item 2.2). These exist to
    //! hands-on-verify the exact Rust API (this crate renamed
    //! Node*->Endpoint* vs. the Python bindings' node-language `iroh` 1.1.0
    //! — a real API divergence between the two, not just cosmetic) and this
    //! module's framing, not to re-test iroh itself.
    use super::*;
    use iroh::endpoint::presets::Minimal;
    use tokio::time::sleep;

    /// Polls until `endpoint.addr()` reports a direct address. Stands in
    /// for `online()`, which hangs forever with the relay disabled (it
    /// specifically waits for a usable relay, which `Minimal` has none of).
    async fn wait_for_direct_address(endpoint: &Endpoint) -> EndpointAddr {
        loop {
            let addr = endpoint.addr();
            if addr.ip_addrs().next().is_some() {
                return addr;
            }
            sleep(Duration::from_millis(20)).await;
        }
    }

    /// Spins up a fake worker: a real iroh endpoint that accepts one
    /// connection, opens the same protocol-v1 ALPN, reads one framed
    /// message, and echoes it back prefixed with `"echo:"`.
    async fn spawn_fake_worker() -> EndpointAddr {
        let endpoint = Endpoint::builder(Minimal)
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .expect("fake worker endpoint bind");
        let addr = timeout(Duration::from_secs(5), wait_for_direct_address(&endpoint))
            .await
            .expect("fake worker never reported a direct address");

        tokio::spawn(async move {
            let incoming = endpoint.accept().await.expect("no incoming connection");
            let connecting = incoming.accept().expect("incoming.accept()");
            let conn = connecting.await.expect("connection handshake");
            let (mut send, mut recv) = conn.accept_bi().await.expect("accept_bi");

            let text = read_frame(&mut recv)
                .await
                .expect("read_frame")
                .expect("stream closed before a frame arrived");
            write_frame(&mut send, &format!("echo:{text}"))
                .await
                .expect("write_frame");

            // Keep the endpoint (and thus the connection) alive until the
            // test's own client side has read the reply and torn down.
            sleep(Duration::from_millis(500)).await;
            endpoint.close().await;
        });

        addr
    }

    #[tokio::test]
    async fn dials_a_real_worker_and_exchanges_one_framed_message() {
        let worker_addr = spawn_fake_worker().await;

        let (client_endpoint, _connection, mut send, mut recv) =
            dial(worker_addr, Minimal).await.expect("dial");

        write_frame(&mut send, "hello").await.expect("write_frame");
        let reply = read_frame(&mut recv)
            .await
            .expect("read_frame")
            .expect("worker closed without replying");

        assert_eq!(reply, "echo:hello");
        client_endpoint.close().await;
    }

    /// Two windows (owners) each hold a connection to their own worker: each
    /// connection's sends reach only its own worker, and closing one owner's
    /// connections leaves the other's open — the bug this registry fixes was
    /// a second `iroh_connect` closing the first window's connection.
    #[tokio::test]
    async fn connections_from_two_owners_stay_independent() {
        let clients = IrohClients::default();
        let (ep_a, conn_a, send_a, mut recv_a) =
            dial(spawn_fake_worker().await, Minimal).await.expect("dial a");
        let (ep_b, conn_b, send_b, mut recv_b) =
            dial(spawn_fake_worker().await, Minimal).await.expect("dial b");
        let id_a = clients.add("main".into(), ep_a, conn_a, send_a).await;
        let id_b = clients.add("window-2".into(), ep_b, conn_b, send_b).await;
        assert_ne!(id_a, id_b);

        clients.send(id_b, "from-b").await.expect("send b");
        clients.send(id_a, "from-a").await.expect("send a");
        assert_eq!(read_frame(&mut recv_a).await.unwrap().unwrap(), "echo:from-a");
        assert_eq!(read_frame(&mut recv_b).await.unwrap().unwrap(), "echo:from-b");

        clients.close_owned_by("main").await;
        assert!(clients.send(id_a, "x").await.is_err(), "main's connection should be gone");
        assert!(clients.with_conn(id_b, |_| ()).await.is_ok(), "window-2's connection should remain");

        clients.close(id_b).await;
        assert!(clients.with_conn(id_b, |_| ()).await.is_err());
    }

    #[tokio::test]
    async fn decode_node_id_round_trips_a_real_endpoint_id() {
        let endpoint = Endpoint::builder(Minimal)
            .bind()
            .await
            .expect("endpoint bind");
        let id = endpoint.id();
        let encoded = URL_SAFE_NO_PAD.encode(id.as_bytes());

        let decoded = decode_node_id(&encoded).expect("decode_node_id");

        assert_eq!(decoded, id);
        endpoint.close().await;
    }

    #[test]
    fn decode_node_id_rejects_the_wrong_byte_length() {
        let short = URL_SAFE_NO_PAD.encode([0u8; 16]);
        let err = decode_node_id(&short).unwrap_err();
        assert!(err.contains("32 bytes"), "unexpected error: {err}");
    }

    #[test]
    fn build_endpoint_addr_parses_relay_and_direct_addrs() {
        // An arbitrary 32-byte pattern isn't necessarily a valid point on
        // the curve `PublicKey` wraps — generate a real key instead.
        let node_id = URL_SAFE_NO_PAD.encode(iroh::SecretKey::generate().public().as_bytes());
        let target = IrohDialTarget {
            node_id,
            relay_url: Some("https://relay.example.com".to_string()),
            direct_addrs: Some(vec!["127.0.0.1:4000".to_string()]),
        };

        let addr = build_endpoint_addr(&target).expect("build_endpoint_addr");

        assert_eq!(addr.ip_addrs().count(), 1);
        assert_eq!(addr.relay_urls().count(), 1);
    }

    // ── Blob commands (item 2.4) ─────────────────────────────────────
    //
    // A fake worker that serves each incoming `BiStream` as one blob-fetch
    // session (open frame, then read frames until the client finishes its
    // send side) against a single known file's bytes — enough to hands-on
    // verify this module's own open/read logic without needing a real
    // Python worker (that cross-language proof is a separate step, item
    // 2.4's §11).

    const TEST_CHUNK_SIZE: u64 = 4; // tiny on purpose, to exercise multiple chunks

    // A real sha256 isn't needed here — this module never verifies
    // `chunkHashes` itself (that's TS-side, §8/§9 of the design doc); this
    // test only needs a deterministic, chunk-unique stand-in to prove the
    // field round-trips from the fake worker's open response through to the
    // caller unchanged, without adding a new crate dependency just for that.
    fn test_chunk_hashes(bytes: &[u8]) -> Vec<String> {
        bytes
            .chunks(TEST_CHUNK_SIZE as usize)
            .map(|c| c.iter().map(|b| format!("{b:02x}")).collect())
            .collect()
    }

    async fn spawn_fake_blob_worker(bytes: &'static [u8]) -> EndpointAddr {
        let endpoint = Endpoint::builder(Minimal)
            .alpns(vec![ALPN.to_vec()])
            .bind()
            .await
            .expect("fake worker endpoint bind");
        let addr = timeout(Duration::from_secs(5), wait_for_direct_address(&endpoint))
            .await
            .expect("fake worker never reported a direct address");

        tokio::spawn(async move {
            let incoming = endpoint.accept().await.expect("no incoming connection");
            let connecting = incoming.accept().expect("incoming.accept()");
            let conn = connecting.await.expect("connection handshake");

            loop {
                let (mut send, mut recv) = match conn.accept_bi().await {
                    Ok(streams) => streams,
                    Err(_) => break, // connection closed
                };
                let bytes = bytes;
                tokio::spawn(async move {
                    let open_req = match read_frame(&mut recv).await {
                        Ok(Some(t)) => t,
                        _ => return,
                    };
                    let sha256 = serde_json::from_str::<serde_json::Value>(&open_req)
                        .ok()
                        .and_then(|v| v.get("sha256").and_then(|s| s.as_str().map(String::from)))
                        .unwrap_or_default();
                    if sha256 != "knownblob" {
                        let _ = write_frame(
                            &mut send,
                            &serde_json::json!({"ok": false, "error": "not_found"}).to_string(),
                        )
                        .await;
                        let _ = send.finish();
                        return;
                    }
                    let _ = write_frame(
                        &mut send,
                        &serde_json::json!({
                            "ok": true,
                            "size": bytes.len(),
                            "chunkSize": TEST_CHUNK_SIZE,
                            "chunkHashes": test_chunk_hashes(bytes),
                        })
                        .to_string(),
                    )
                    .await;

                    loop {
                        let req = match read_frame(&mut recv).await {
                            Ok(Some(t)) => t,
                            _ => break, // client finished its send side
                        };
                        let r: serde_json::Value = serde_json::from_str(&req).expect("valid request json");
                        let offset = r["offset"].as_u64().unwrap() as usize;
                        let length = r["length"].as_u64().unwrap() as usize;
                        let end = (offset + length).min(bytes.len());
                        let slice = &bytes[offset..end];
                        let _ = write_frame(
                            &mut send,
                            &serde_json::json!({"ok": true, "size": slice.len()}).to_string(),
                        )
                        .await;
                        let _ = send.write_all(slice).await;
                    }
                    let _ = send.finish();
                });
            }
            sleep(Duration::from_millis(500)).await;
            endpoint.close().await;
        });

        addr
    }

    const TEST_BLOB_BYTES: &[u8] = b"0123456789abcdefghij"; // 20 bytes = 5 chunks of 4

    #[tokio::test]
    async fn iroh_blob_open_and_multiple_range_reads_on_the_same_stream() {
        let worker_addr = spawn_fake_blob_worker(TEST_BLOB_BYTES).await;
        let (client_endpoint, connection, _send, _recv) = dial(worker_addr, Minimal).await.expect("dial");

        let (opened, mut state) = open_blob_stream(connection, "knownblob".to_string())
            .await
            .expect("open_blob_stream");
        assert_eq!(opened.size, TEST_BLOB_BYTES.len() as u64);
        assert_eq!(opened.chunk_size, TEST_CHUNK_SIZE);
        assert_eq!(opened.chunk_hashes, test_chunk_hashes(TEST_BLOB_BYTES));

        // First read: entirely inside chunk 0.
        let a = read_blob_range(&mut state, 0, 4).await.expect("read a");
        assert_eq!(a, TEST_BLOB_BYTES[0..4]);

        // Second read on the SAME stream/state, starting mid-file, spanning
        // a chunk boundary — proves session reuse, not just one request.
        let b = read_blob_range(&mut state, 6, 8).await.expect("read b");
        assert_eq!(b, TEST_BLOB_BYTES[6..14]);

        // Third read reaching past EOF — clamped, not an error.
        let c = read_blob_range(&mut state, 18, 10).await.expect("read c");
        assert_eq!(c, TEST_BLOB_BYTES[18..20]);

        client_endpoint.close().await;
    }

    #[tokio::test]
    async fn iroh_blob_open_reports_not_found_for_an_unknown_sha256() {
        let worker_addr = spawn_fake_blob_worker(TEST_BLOB_BYTES).await;
        let (client_endpoint, connection, _send, _recv) = dial(worker_addr, Minimal).await.expect("dial");

        let err = open_blob_stream(connection, "nope".to_string())
            .await
            .expect_err("should fail for unknown sha256");
        assert!(err.contains("not_found"), "unexpected error: {err}");

        client_endpoint.close().await;
    }

    #[tokio::test]
    async fn iroh_blob_open_replaces_a_previously_open_stream() {
        let worker_addr = spawn_fake_blob_worker(TEST_BLOB_BYTES).await;
        let (client_endpoint, connection, _send, _recv) = dial(worker_addr, Minimal).await.expect("dial");

        let (_opened1, state1) = open_blob_stream(connection.clone(), "knownblob".to_string())
            .await
            .expect("first open_blob_stream");
        // Re-open on the SAME connection before closing the first — this is
        // exactly what the `iroh_blob_open` command does (assigns a fresh
        // `IrohBlobState` into the same slot, dropping the old one).
        let (_opened2, mut state) = open_blob_stream(connection, "knownblob".to_string())
            .await
            .expect("second open_blob_stream");
        drop(state1); // the slot this represented has been replaced

        let bytes = read_blob_range(&mut state, 0, 5).await.expect("read after replace");
        assert_eq!(bytes, TEST_BLOB_BYTES[0..5]);

        client_endpoint.close().await;
    }
}
