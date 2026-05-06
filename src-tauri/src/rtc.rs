use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{
    stream::{SplitSink, SplitStream},
    SinkExt, StreamExt,
};
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio::sync::Mutex as TokioMutex;
use tokio::time::{timeout, Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::MediaEngine;
use webrtc::api::APIBuilder;
use webrtc::data_channel::data_channel_message::DataChannelMessage;
use webrtc::data_channel::RTCDataChannel;
use webrtc::ice_transport::ice_candidate::RTCIceCandidateInit;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::peer_connection::RTCPeerConnection;

// ── Constants ───────────────────────────────────────────────────

const SIGNALING_WS: &str = "wss://signaling.sleap.ai/ws";

// ── WebSocket types ─────────────────────────────────────────────

type WsSink = SplitSink<WebSocketStream<MaybeTlsStream<TcpStream>>, Message>;
type WsStream = SplitStream<WebSocketStream<MaybeTlsStream<TcpStream>>>;

// ── Types ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerInfo {
    pub peer_id: String,
    pub name: String,
    pub status: String,
    pub gpu: Option<GpuInfo>,
    pub mounts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub model: String,
    pub memory_mb: u64,
    pub cuda_version: String,
}

#[derive(Debug, Clone)]
pub struct Credentials {
    pub jwt: String,
    pub username: String,
    pub private_key_bytes: [u8; 32],
}

struct FileReceiveState {
    file: std::fs::File,
    path: std::path::PathBuf,
    filename: String,
    expected_size: usize,
    bytes_written: usize,
}

// ── Managed State ────────────────────────────────────────────────

pub struct RtcState {
    pub credentials: Option<Credentials>,
    pub room_id: Option<String>,
    pub ice_servers: Vec<serde_json::Value>,
    pub ws_sink: Option<WsSink>,
    pub ws_stream: Option<WsStream>,
    pub pc: Option<Arc<RTCPeerConnection>>,
    pub dc: Option<Arc<RTCDataChannel>>,
}

impl RtcState {
    pub fn new() -> Self {
        Self {
            credentials: None,
            room_id: None,
            ice_servers: Vec::new(),
            ws_sink: None,
            ws_stream: None,
            pc: None,
            dc: None,
        }
    }
}

// ── Credential loading ───────────────────────────────────────────

#[derive(Deserialize)]
struct CredentialsFile {
    jwt: Option<String>,
    private_key: Option<String>,
    user: Option<UserInfo>,
}

#[derive(Deserialize)]
struct UserInfo {
    username: Option<String>,
}

pub fn load_credentials() -> Result<Credentials, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    let cred_path = home.join(".sleap-rtc").join("credentials.json");

    let contents = std::fs::read_to_string(&cred_path)
        .map_err(|e| format!("Failed to read {}: {}", cred_path.display(), e))?;

    let file: CredentialsFile = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse credentials.json: {}", e))?;

    let jwt = file.jwt.ok_or("No JWT in credentials.json")?;
    let username = file
        .user
        .and_then(|u| u.username)
        .ok_or("No username in credentials.json")?;
    let private_key_b64 = file.private_key.ok_or("No private_key in credentials.json")?;

    let key_bytes = URL_SAFE_NO_PAD
        .decode(&private_key_b64)
        .map_err(|e| format!("Failed to decode private_key: {}", e))?;

    if key_bytes.len() != 32 {
        return Err(format!(
            "private_key must be 32 bytes, got {}",
            key_bytes.len()
        ));
    }

    let mut private_key_bytes = [0u8; 32];
    private_key_bytes.copy_from_slice(&key_bytes);

    Ok(Credentials {
        jwt,
        username,
        private_key_bytes,
    })
}

// ── Join Room Command ───────────────────────────────────────────

/// Parse the `mounts` field which can be either an array of strings
/// or an array of objects with a `path` field.
fn parse_mounts(value: Option<&serde_json::Value>) -> Vec<String> {
    match value {
        Some(serde_json::Value::Array(arr)) => arr
            .iter()
            .filter_map(|v| match v {
                serde_json::Value::String(s) => Some(s.clone()),
                serde_json::Value::Object(obj) => obj
                    .get("path")
                    .and_then(|p| p.as_str())
                    .map(|s| s.to_string()),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

/// Parse a single peer from the `peer_list` response into a `WorkerInfo`.
fn parse_worker(peer: &serde_json::Value) -> Option<WorkerInfo> {
    let peer_id = peer.get("peer_id")?.as_str()?.to_string();
    let props = peer
        .get("metadata")
        .and_then(|m| m.get("properties"));

    let name = props
        .and_then(|p| p.get("worker_name"))
        .and_then(|v| v.as_str())
        .unwrap_or(&peer_id)
        .to_string();

    let status = props
        .and_then(|p| p.get("status"))
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    let gpu = props.and_then(|p| {
        let model = p.get("gpu_model")?.as_str()?.to_string();
        let memory_mb = p.get("gpu_memory_mb")?.as_u64()?;
        let cuda_version = p
            .get("cuda_version")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        Some(GpuInfo {
            model,
            memory_mb,
            cuda_version,
        })
    });

    let mounts = parse_mounts(props.and_then(|p| p.get("mounts")));

    Some(WorkerInfo {
        peer_id,
        name,
        status,
        gpu,
        mounts,
    })
}

fn uuid_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let d = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!("{:x}_{:x}", d.as_millis(), d.subsec_nanos())
}

#[tauri::command]
pub async fn rtc_join_room(
    room_id: String,
    state: tauri::State<'_, tokio::sync::Mutex<RtcState>>,
) -> Result<Vec<WorkerInfo>, String> {
    // 1. Load credentials from disk
    let creds = load_credentials()?;

    // 2. Open WebSocket to signaling server with JWT in URL
    let ws_url = format!(
        "{}?token={}",
        SIGNALING_WS,
        urlencoding::encode(&creds.jwt)
    );

    let (ws_stream, _response) = timeout(Duration::from_secs(10), connect_async(&ws_url))
        .await
        .map_err(|_| "WebSocket connection timed out".to_string())?
        .map_err(|e| format!("WebSocket connection failed: {}", e))?;

    let (mut sink, mut stream) = ws_stream.split();

    // 3. Send register message
    let register_msg = serde_json::json!({
        "type": "register",
        "peer_id": creds.username,
        "room_id": room_id,
        "role": "app",
        "jwt": creds.jwt,
        "metadata": {
            "tags": ["sleap-app-tauri"],
            "properties": { "platform": "sleap-app-tauri" }
        }
    });

    sink.send(Message::Text(register_msg.to_string().into()))
        .await
        .map_err(|e| format!("Failed to send register message: {}", e))?;

    // 4. Wait for `registered_auth` response (with timeout)
    let ice_servers = timeout(Duration::from_secs(10), async {
        while let Some(msg) = stream.next().await {
            let msg = msg.map_err(|e| format!("WebSocket read error: {}", e))?;
            let text = match msg {
                Message::Text(t) => t,
                Message::Close(_) => return Err("WebSocket closed during registration".to_string()),
                _ => continue,
            };
            let parsed: serde_json::Value = serde_json::from_str(&text)
                .map_err(|e| format!("Invalid JSON from server: {}", e))?;

            if parsed.get("type").and_then(|t| t.as_str()) == Some("registered_auth") {
                let servers = parsed
                    .get("ice_servers")
                    .cloned()
                    .and_then(|v| v.as_array().cloned())
                    .unwrap_or_default();
                return Ok(servers);
            }
        }
        Err("WebSocket closed before receiving registered_auth".to_string())
    })
    .await
    .map_err(|_| "Timed out waiting for registered_auth response".to_string())??;

    // 5. Send discover_peers request
    let discover_msg = serde_json::json!({
        "type": "discover_peers",
        "from_peer_id": creds.username,
        "filters": { "role": "worker" }
    });

    sink.send(Message::Text(discover_msg.to_string().into()))
        .await
        .map_err(|e| format!("Failed to send discover_peers message: {}", e))?;

    // 6. Wait for `peer_list` response (with timeout)
    let workers = timeout(Duration::from_secs(10), async {
        while let Some(msg) = stream.next().await {
            let msg = msg.map_err(|e| format!("WebSocket read error: {}", e))?;
            let text = match msg {
                Message::Text(t) => t,
                Message::Close(_) => {
                    return Err("WebSocket closed during peer discovery".to_string())
                }
                _ => continue,
            };
            let parsed: serde_json::Value = serde_json::from_str(&text)
                .map_err(|e| format!("Invalid JSON from server: {}", e))?;

            if parsed.get("type").and_then(|t| t.as_str()) == Some("peer_list") {
                let peers = parsed
                    .get("peers")
                    .and_then(|p| p.as_array())
                    .map(|arr| arr.iter().filter_map(parse_worker).collect::<Vec<_>>())
                    .unwrap_or_default();
                return Ok(peers);
            }
        }
        Err("WebSocket closed before receiving peer_list".to_string())
    })
    .await
    .map_err(|_| "Timed out waiting for peer_list response".to_string())??;

    // 7. Store state
    let mut rtc = state.lock().await;
    rtc.credentials = Some(creds);
    rtc.room_id = Some(room_id);
    rtc.ice_servers = ice_servers;
    rtc.ws_sink = Some(sink);
    rtc.ws_stream = Some(stream);

    // 8. Return worker list
    Ok(workers)
}

// ── ICE Server Helper ───────────────────────────────────────────

/// Convert the JSON ice_servers array from the signaling server into webrtc-rs format.
/// Falls back to Google STUN if empty.
fn build_ice_servers(ice_servers_json: &[serde_json::Value]) -> Vec<RTCIceServer> {
    if ice_servers_json.is_empty() {
        return vec![RTCIceServer {
            urls: vec!["stun:stun.l.google.com:19302".to_string()],
            ..Default::default()
        }];
    }

    ice_servers_json
        .iter()
        .filter_map(|server| {
            let urls = match server.get("urls") {
                Some(serde_json::Value::Array(arr)) => arr
                    .iter()
                    .filter_map(|u| u.as_str().map(String::from))
                    .collect::<Vec<_>>(),
                Some(serde_json::Value::String(s)) => vec![s.clone()],
                _ => return None,
            };
            if urls.is_empty() {
                return None;
            }
            let username = server
                .get("username")
                .and_then(|u| u.as_str())
                .unwrap_or("")
                .to_string();
            let credential = server
                .get("credential")
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .to_string();

            Some(RTCIceServer {
                urls,
                username,
                credential,
                ..Default::default()
            })
        })
        .collect()
}

// ── Connect Worker Command ──────────────────────────────────────

#[tauri::command]
pub async fn rtc_connect_worker(
    worker_id: String,
    on_message: tauri::ipc::Channel<String>,
    state: tauri::State<'_, tokio::sync::Mutex<RtcState>>,
) -> Result<(), String> {
    // 1. Validate state — take ws_sink/ws_stream and credentials from state
    let (creds, ice_servers_json, ws_sink, ws_stream) = {
        let mut rtc = state.lock().await;
        let creds = rtc
            .credentials
            .clone()
            .ok_or("Not connected: call rtc_join_room first")?;
        let ice_servers_json = rtc.ice_servers.clone();
        let ws_sink = rtc
            .ws_sink
            .take()
            .ok_or("No WebSocket connection: call rtc_join_room first")?;
        let ws_stream = rtc
            .ws_stream
            .take()
            .ok_or("No WebSocket stream: call rtc_join_room first")?;
        (creds, ice_servers_json, ws_sink, ws_stream)
    };

    // 2. Build ICE configuration
    let ice_servers = build_ice_servers(&ice_servers_json);
    let config = RTCConfiguration {
        ice_servers,
        ..Default::default()
    };

    // 3. Create PeerConnection
    let mut m = MediaEngine::default();
    m.register_default_codecs()
        .map_err(|e| format!("Failed to register codecs: {}", e))?;
    let mut registry = Registry::new();
    registry = register_default_interceptors(registry, &mut m)
        .map_err(|e| format!("Failed to register interceptors: {}", e))?;
    let api = APIBuilder::new()
        .with_media_engine(m)
        .with_interceptor_registry(registry)
        .build();
    let pc = Arc::new(
        api.new_peer_connection(config)
            .await
            .map_err(|e| format!("Failed to create PeerConnection: {}", e))?,
    );

    // 4. Set up ICE candidate handler — send candidates via signaling WS
    let shared_sink = Arc::new(TokioMutex::new(ws_sink));
    let sink_for_ice = Arc::clone(&shared_sink);
    let sender_for_ice = creds.username.clone();
    let target_for_ice = worker_id.clone();

    pc.on_ice_candidate(Box::new(move |candidate| {
        let sink = Arc::clone(&sink_for_ice);
        let sender = sender_for_ice.clone();
        let target = target_for_ice.clone();
        Box::pin(async move {
            if let Some(candidate) = candidate {
                if let Ok(candidate_init) = candidate.to_json() {
                    let msg = serde_json::json!({
                        "type": "candidate",
                        "sender": sender,
                        "target": target,
                        "candidate": candidate_init,
                    });
                    let mut s = sink.lock().await;
                    let _ = s.send(Message::Text(msg.to_string().into())).await;
                }
            }
        })
    }));

    // 5. Create data channel
    let dc = pc
        .create_data_channel("sleap-app", None)
        .await
        .map_err(|e| format!("Failed to create data channel: {}", e))?;

    // 6. Create and send SDP offer
    let offer = pc
        .create_offer(None)
        .await
        .map_err(|e| format!("Failed to create offer: {}", e))?;
    pc.set_local_description(offer.clone())
        .await
        .map_err(|e| format!("Failed to set local description: {}", e))?;

    let offer_msg = serde_json::json!({
        "type": "offer",
        "sender": creds.username,
        "target": worker_id,
        "sdp": offer.sdp,
        "role": "app",
    });
    {
        let mut s = shared_sink.lock().await;
        s.send(Message::Text(offer_msg.to_string().into()))
            .await
            .map_err(|e| format!("Failed to send offer: {}", e))?;
    }

    // 7. Process signaling messages — spawn background task for WS messages
    let pc_clone = Arc::clone(&pc);
    let ws_task = tokio::spawn(async move {
        let mut stream = ws_stream;
        while let Some(msg) = stream.next().await {
            let msg = match msg {
                Ok(m) => m,
                Err(_) => break,
            };
            let text = match msg {
                Message::Text(t) => t,
                Message::Close(_) => break,
                _ => continue,
            };
            let parsed: serde_json::Value = match serde_json::from_str(&text) {
                Ok(v) => v,
                Err(_) => continue,
            };

            let msg_type = parsed
                .get("type")
                .and_then(|t| t.as_str())
                .unwrap_or("");

            match msg_type {
                "answer" => {
                    if let Some(sdp) = parsed.get("sdp").and_then(|s| s.as_str()) {
                        let answer = RTCSessionDescription::answer(sdp.to_string());
                        if let Ok(answer) = answer {
                            let _ = pc_clone.set_remote_description(answer).await;
                        }
                    }
                }
                "candidate" | "ice_candidate" => {
                    // The candidate field may be the RTCIceCandidateInit directly
                    // or nested under a "candidate" key
                    let candidate_value = parsed
                        .get("candidate")
                        .cloned()
                        .unwrap_or(parsed.clone());

                    if let Ok(candidate_init) =
                        serde_json::from_value::<RTCIceCandidateInit>(candidate_value)
                    {
                        let _ = pc_clone.add_ice_candidate(candidate_init).await;
                    }
                }
                _ => {
                    // Ignore pings, keepalive, etc.
                }
            }
        }
    });

    // 8. Wait for data channel to open (15s timeout)
    let (open_tx, open_rx) = tokio::sync::oneshot::channel::<()>();
    let open_tx = Arc::new(std::sync::Mutex::new(Some(open_tx)));

    dc.on_open(Box::new(move || {
        let tx = Arc::clone(&open_tx);
        Box::pin(async move {
            if let Some(tx) = tx.lock().unwrap().take() {
                let _ = tx.send(());
            }
        })
    }));

    timeout(Duration::from_secs(15), open_rx)
        .await
        .map_err(|_| "Data channel open timed out (15s)".to_string())?
        .map_err(|_| "Data channel open signal dropped".to_string())?;

    // 9. Ed25519 auth handshake
    // Set up a message receiver for auth messages
    let (auth_tx, mut auth_rx) = tokio::sync::mpsc::channel::<String>(16);

    let dc_for_auth = Arc::clone(&dc);
    dc_for_auth.on_message(Box::new(move |msg: DataChannelMessage| {
        let tx = auth_tx.clone();
        Box::pin(async move {
            let text = String::from_utf8_lossy(&msg.data).to_string();
            let _ = tx.send(text).await;
        })
    }));

    // Wait for AUTH_CHALLENGE
    let challenge_nonce = timeout(Duration::from_secs(10), async {
        while let Some(msg) = auth_rx.recv().await {
            if let Some(nonce) = msg.strip_prefix("AUTH_CHALLENGE::") {
                return Ok(nonce.to_string());
            }
        }
        Err("Connection closed before receiving AUTH_CHALLENGE".to_string())
    })
    .await
    .map_err(|_| "Timed out waiting for AUTH_CHALLENGE (10s)".to_string())??;

    // Sign the nonce with Ed25519
    let signing_key = SigningKey::from_bytes(&creds.private_key_bytes);
    let signature = signing_key.sign(challenge_nonce.as_bytes());
    let sig_b64 = URL_SAFE_NO_PAD.encode(signature.to_bytes());

    // Send AUTH_RESPONSE
    dc.send_text(format!("AUTH_RESPONSE::{}", sig_b64))
        .await
        .map_err(|e| format!("Failed to send AUTH_RESPONSE: {}", e))?;

    // Wait for AUTH_SUCCESS or AUTH_FAILURE
    let auth_result = timeout(Duration::from_secs(10), async {
        while let Some(msg) = auth_rx.recv().await {
            if msg.starts_with("AUTH_SUCCESS") {
                return Ok(());
            } else if msg.starts_with("AUTH_FAILURE") {
                return Err(format!("Authentication failed: {}", msg));
            }
        }
        Err("Connection closed before receiving auth result".to_string())
    })
    .await
    .map_err(|_| "Timed out waiting for auth result (10s)".to_string())??;

    // Auth succeeded — abort the signaling WS task (no longer needed)
    ws_task.abort();

    // 10. Switch to message forwarding — binary-aware handler
    let file_state: Arc<TokioMutex<Option<FileReceiveState>>> =
        Arc::new(TokioMutex::new(None));
    let file_state_for_handler = Arc::clone(&file_state);

    dc.on_message(Box::new(move |msg: DataChannelMessage| {
        let channel = on_message.clone();
        let fs = Arc::clone(&file_state_for_handler);
        Box::pin(async move {
            if msg.is_string {
                // Text message
                let text = String::from_utf8_lossy(&msg.data).to_string();

                if text.starts_with("FILE_META::") {
                    // Parse: FILE_META::<filename>:<size>:<hint>
                    let meta = &text["FILE_META::".len()..];
                    let parts: Vec<&str> = meta.splitn(3, ':').collect();
                    if parts.len() >= 2 {
                        let filename = parts[0].to_string();
                        let expected_size: usize = parts[1].parse().unwrap_or(0);

                        // Extract file extension for temp file suffix
                        let ext = std::path::Path::new(&filename)
                            .extension()
                            .map(|e| format!(".{}", e.to_string_lossy()))
                            .unwrap_or_default();

                        let temp_path = std::env::temp_dir()
                            .join(format!("sleap_pred_{}{}", uuid_simple(), ext));

                        match std::fs::File::create(&temp_path) {
                            Ok(file) => {
                                log::info!(
                                    "[rtc] FILE_META: {} ({} bytes) → {:?}",
                                    filename, expected_size, temp_path
                                );
                                let mut fs_lock = fs.lock().await;
                                *fs_lock = Some(FileReceiveState {
                                    file,
                                    path: temp_path,
                                    filename,
                                    expected_size,
                                    bytes_written: 0,
                                });
                            }
                            Err(e) => {
                                log::error!("[rtc] Failed to create temp file: {}", e);
                            }
                        }
                    }
                    // Consumed — don't forward to frontend
                } else if text == "END_OF_FILE" {
                    let mut fs_lock = fs.lock().await;
                    if let Some(recv) = fs_lock.take() {
                        // File handle is dropped here (closes the file)
                        let path_str = recv.path.to_string_lossy().to_string();
                        log::info!(
                            "[rtc] END_OF_FILE: {} ({} bytes written) → {}",
                            recv.filename, recv.bytes_written, path_str
                        );
                        let _ = channel.send(format!("__FILE_RECEIVED__::{}", path_str));
                    }
                    // Consumed — don't forward to frontend
                } else if text == "KEEP_ALIVE" {
                    // Silently ignore text KEEP_ALIVE
                } else {
                    // Regular text message — forward to frontend
                    let _ = channel.send(text);
                }
            } else {
                // Binary message
                let mut fs_lock = fs.lock().await;
                if let Some(ref mut recv) = *fs_lock {
                    // Write binary chunk to file
                    if let Err(e) = recv.file.write_all(&msg.data) {
                        log::error!("[rtc] Failed to write chunk: {}", e);
                    } else {
                        recv.bytes_written += msg.data.len();
                    }
                }
                // If no active transfer, silently drop (KEEP_ALIVE bytes, etc.)
            }
        })
    }));

    // 11. Store PC and DC in state
    {
        let mut rtc = state.lock().await;
        rtc.pc = Some(pc);
        rtc.dc = Some(dc);
    }

    Ok(auth_result)
}

// ── Send Command ────────────────────────────────────────────────

#[tauri::command]
pub async fn rtc_send(
    msg: String,
    state: tauri::State<'_, tokio::sync::Mutex<RtcState>>,
) -> Result<(), String> {
    let s = state.lock().await;
    let dc = s.dc.as_ref().ok_or("Not connected to worker")?;
    dc.send_text(msg)
        .await
        .map_err(|e| format!("Send failed: {}", e))?;
    Ok(())
}

// ── Disconnect Worker Command ───────────────────────────────────

#[tauri::command]
pub async fn rtc_disconnect_worker(
    state: tauri::State<'_, tokio::sync::Mutex<RtcState>>,
) -> Result<(), String> {
    let mut s = state.lock().await;
    if let Some(dc) = s.dc.take() {
        dc.close()
            .await
            .map_err(|e| format!("DC close failed: {}", e))?;
    }
    if let Some(pc) = s.pc.take() {
        pc.close()
            .await
            .map_err(|e| format!("PC close failed: {}", e))?;
    }
    Ok(())
}

// ── Leave Room Command ──────────────────────────────────────────

#[tauri::command]
pub async fn rtc_leave_room(
    state: tauri::State<'_, tokio::sync::Mutex<RtcState>>,
) -> Result<(), String> {
    let mut s = state.lock().await;
    // Close worker connection if active
    if let Some(dc) = s.dc.take() {
        let _ = dc.close().await;
    }
    if let Some(pc) = s.pc.take() {
        let _ = pc.close().await;
    }
    // Close signaling WebSocket
    if let Some(mut sink) = s.ws_sink.take() {
        let _ = sink.close().await;
    }
    s.ws_stream = None;
    s.credentials = None;
    s.room_id = None;
    s.ice_servers.clear();
    Ok(())
}
