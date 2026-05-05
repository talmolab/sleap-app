use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use futures_util::{
    stream::{SplitSink, SplitStream},
    SinkExt, StreamExt,
};
use serde::{Deserialize, Serialize};
use tokio::net::TcpStream;
use tokio::time::{timeout, Duration};
use tokio_tungstenite::{connect_async, tungstenite::Message, MaybeTlsStream, WebSocketStream};

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

// ── Managed State ────────────────────────────────────────────────

pub struct RtcState {
    pub credentials: Option<Credentials>,
    pub room_id: Option<String>,
    pub ice_servers: Vec<serde_json::Value>,
    pub ws_sink: Option<WsSink>,
    pub ws_stream: Option<WsStream>,
}

impl RtcState {
    pub fn new() -> Self {
        Self {
            credentials: None,
            room_id: None,
            ice_servers: Vec::new(),
            ws_sink: None,
            ws_stream: None,
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
