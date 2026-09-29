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
use std::net::SocketAddr;
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

pub struct IrohClientState {
    endpoint: Option<Endpoint>,
    connection: Option<Connection>,
    send: Option<SendStream>,
}

impl IrohClientState {
    pub fn new() -> Self {
        Self {
            endpoint: None,
            connection: None,
            send: None,
        }
    }
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

#[tauri::command]
pub async fn iroh_connect(
    target: IrohDialTarget,
    on_message: tauri::ipc::Channel<IrohClientEvent>,
    state: tauri::State<'_, tokio::sync::Mutex<IrohClientState>>,
) -> Result<(), String> {
    let endpoint_addr = build_endpoint_addr(&target)?;
    let (endpoint, connection, send, recv) = dial(endpoint_addr, presets::N0).await?;

    spawn_reader(recv, on_message);

    let mut s = state.lock().await;
    // Defensive: a stale entry here (e.g. a caller that reconnects without
    // disconnecting first) must never leak a previous QUIC endpoint.
    if let Some(old) = s.endpoint.take() {
        old.close().await;
    }
    s.endpoint = Some(endpoint);
    s.connection = Some(connection);
    s.send = Some(send);
    Ok(())
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

fn spawn_reader(mut recv: RecvStream, on_message: tauri::ipc::Channel<IrohClientEvent>) {
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
        let _ = on_message.send(IrohClientEvent::Closed);
    });
}

// ── Send Command ─────────────────────────────────────────────────

#[tauri::command]
pub async fn iroh_send(
    msg: String,
    state: tauri::State<'_, tokio::sync::Mutex<IrohClientState>>,
) -> Result<(), String> {
    let mut s = state.lock().await;
    let send = s
        .send
        .as_mut()
        .ok_or("Not connected to a worker over iroh")?;
    write_frame(send, &msg).await
}

// ── Disconnect Command ────────────────────────────────────────────

#[tauri::command]
pub async fn iroh_disconnect(
    state: tauri::State<'_, tokio::sync::Mutex<IrohClientState>>,
) -> Result<(), String> {
    let mut s = state.lock().await;
    s.send = None;
    if let Some(conn) = s.connection.take() {
        conn.close(0u32.into(), b"client disconnect");
    }
    if let Some(endpoint) = s.endpoint.take() {
        endpoint.close().await;
    }
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
}
