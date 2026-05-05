use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};

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
}

impl RtcState {
    pub fn new() -> Self {
        Self {
            credentials: None,
            room_id: None,
            ice_servers: Vec::new(),
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
