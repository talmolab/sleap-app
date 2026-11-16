//! Loopback MCP endpoint for the Claude connector (QC review prototype).
//!
//! Claude Code talks MCP's Streamable HTTP transport: one JSON-RPC message per
//! `POST /mcp`, the reply in the response body. This module only carries
//! bytes: it checks the request is from this machine and carries the token,
//! hands the body to the SLEAP window that turned the connector on (an
//! `mcp:request {id, body}` event), and waits for the window's
//! `mcp_response {id, body}` to answer. The MCP server itself — tools,
//! schemas, instructions — runs in the window (src/automation/mcpServer.ts).
//!
//! Safety: off until the user turns on "Allow Claude to control SLEAP"; binds
//! 127.0.0.1 only; every request needs `Authorization: Bearer <token>`; a
//! `Host` or `Origin` that isn't loopback is refused (DNS rebinding). The port
//! and token are kept in `~/.sleap-app/mcp.json` (mode 600 on Unix) so the
//! `claude mcp add` command keeps working across launches.

use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// How long a request waits for the window (render_flag decodes a frame).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Largest request body accepted.
const MAX_BODY: u64 = 4 * 1024 * 1024;
/// Event the window listens for.
const REQUEST_EVENT: &str = "mcp:request";

/// What the Environment panel shows and the `claude mcp add` command needs.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct McpInfo {
    pub port: u16,
    pub token: String,
    pub url: String,
}

struct Running {
    server: Arc<tiny_http::Server>,
    info: McpInfo,
    /// Label of the window that answers requests (the last to call mcp_start).
    target: Arc<Mutex<String>>,
}

#[derive(Default)]
pub struct McpBridge {
    running: Mutex<Option<Running>>,
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<String>>>>,
    next_id: Arc<AtomicU64>,
}

#[derive(Serialize, Clone)]
struct RequestPayload {
    id: u64,
    body: String,
}

/// What to do with a request, decided from its line and headers alone.
#[derive(Debug, PartialEq)]
pub enum Verdict {
    Forward,
    Reject(u16, &'static str),
}

/// `host[:port]` → host, for a Host header or an Origin's authority.
fn host_part(authority: &str) -> &str {
    if let Some(rest) = authority.strip_prefix('[') {
        // [::1]:port
        return rest.split(']').next().unwrap_or("");
    }
    authority.split(':').next().unwrap_or("")
}

fn is_loopback_host(host: &str) -> bool {
    matches!(host, "127.0.0.1" | "localhost" | "::1")
}

/// Constant-time string comparison, so the token can't be guessed byte by byte.
fn same_secret(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Check a request: the path, a loopback Host (and Origin, if any), the token,
/// then the method. Pure, for tests.
pub fn check_request(
    method: &str,
    path: &str,
    host: Option<&str>,
    origin: Option<&str>,
    auth: Option<&str>,
    token: &str,
) -> Verdict {
    let path_only = path.split('?').next().unwrap_or("");
    if path_only != "/mcp" && path_only != "/mcp/" {
        return Verdict::Reject(404, "Not found. The SLEAP MCP endpoint is /mcp.");
    }
    match host {
        Some(h) if is_loopback_host(host_part(h)) => {}
        _ => return Verdict::Reject(403, "Forbidden: Host must be 127.0.0.1 or localhost."),
    }
    if let Some(o) = origin {
        let authority = o
            .strip_prefix("http://")
            .or_else(|| o.strip_prefix("https://"))
            .unwrap_or("");
        if !is_loopback_host(host_part(authority)) {
            return Verdict::Reject(403, "Forbidden: requests from web pages aren't allowed.");
        }
    }
    let bearer = auth.and_then(|a| a.strip_prefix("Bearer ")).map(str::trim);
    match bearer {
        Some(t) if same_secret(t, token) => {}
        _ => {
            return Verdict::Reject(
                401,
                "Unauthorized: missing or wrong token. Copy the command again from SLEAP's Environment panel.",
            )
        }
    }
    if method != "POST" {
        // No server-to-client stream (GET) or sessions (DELETE) in the prototype.
        return Verdict::Reject(405, "Method not allowed: send JSON-RPC with POST.");
    }
    Verdict::Forward
}

fn config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".sleap-app").join("mcp.json"))
}

fn read_config() -> Option<McpInfo> {
    let text = std::fs::read_to_string(config_path()?).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_config(info: &McpInfo) {
    let Some(path) = config_path() else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(text) = serde_json::to_string_pretty(info) else { return };
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    if let Ok(mut f) = opts.open(&path) {
        use std::io::Write;
        let _ = f.write_all(text.as_bytes());
        // An older file may predate mode 600.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
        }
    }
}

fn new_token() -> Result<String, String> {
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).map_err(|e| format!("Couldn't make a token: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

fn header<'a>(req: &'a tiny_http::Request, name: &str) -> Option<&'a str> {
    req.headers()
        .iter()
        .find(|h| h.field.as_str().as_str().eq_ignore_ascii_case(name))
        .map(|h| h.value.as_str())
}

fn respond(req: tiny_http::Request, status: u16, body: String, json: bool) {
    let mut resp = tiny_http::Response::from_string(body).with_status_code(status);
    if json {
        if let Ok(h) = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]) {
            resp.add_header(h);
        }
    }
    if status == 401 {
        if let Ok(h) = tiny_http::Header::from_bytes(&b"WWW-Authenticate"[..], &b"Bearer"[..]) {
            resp.add_header(h);
        }
    }
    let _ = req.respond(resp);
}

fn error_body(msg: &str) -> String {
    serde_json::json!({ "error": msg }).to_string()
}

fn handle<R: Runtime>(
    app: AppHandle<R>,
    mut req: tiny_http::Request,
    token: String,
    target: Arc<Mutex<String>>,
    pending: Arc<Mutex<HashMap<u64, mpsc::Sender<String>>>>,
    next_id: Arc<AtomicU64>,
) {
    let verdict = check_request(
        req.method().as_str(),
        req.url(),
        header(&req, "Host"),
        header(&req, "Origin"),
        header(&req, "Authorization"),
        &token,
    );
    if let Verdict::Reject(status, msg) = verdict {
        respond(req, status, error_body(msg), true);
        return;
    }
    let mut body = String::new();
    if req.as_reader().take(MAX_BODY + 1).read_to_string(&mut body).is_err() {
        respond(req, 400, error_body("Body must be UTF-8 JSON."), true);
        return;
    }
    if body.len() as u64 > MAX_BODY {
        respond(req, 413, error_body("Request too large."), true);
        return;
    }

    let id = next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, rx) = mpsc::channel();
    pending.lock().unwrap().insert(id, tx);
    let label = target.lock().unwrap().clone();
    if app.emit_to(label.as_str(), REQUEST_EVENT, RequestPayload { id, body }).is_err() {
        pending.lock().unwrap().remove(&id);
        respond(req, 503, error_body("The SLEAP window isn't available."), true);
        return;
    }
    match rx.recv_timeout(REQUEST_TIMEOUT) {
        Ok(reply) if reply.is_empty() => respond(req, 202, String::new(), false),
        Ok(reply) => respond(req, 200, reply, true),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            pending.lock().unwrap().remove(&id);
            respond(
                req,
                504,
                error_body("SLEAP didn't answer in time. Is the project window open and responsive?"),
                true,
            );
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            respond(req, 503, error_body("SLEAP stopped the Claude connector."), true);
        }
    }
}

fn bridge<R: Runtime>(app: &AppHandle<R>) -> tauri::State<'_, McpBridge> {
    if app.try_state::<McpBridge>().is_none() {
        app.manage(McpBridge::default());
    }
    app.state::<McpBridge>()
}

/// Start the endpoint (or, if it's running, make this window the one that answers).
#[tauri::command]
pub fn mcp_start<R: Runtime>(app: AppHandle<R>, window: tauri::Window<R>) -> Result<McpInfo, String> {
    let state = bridge(&app);
    let mut running = state.running.lock().unwrap();
    if let Some(r) = running.as_ref() {
        *r.target.lock().unwrap() = window.label().to_string();
        return Ok(r.info.clone());
    }

    // Reuse the saved port and token so `claude mcp add` keeps working.
    let saved = read_config();
    let token = match saved.as_ref() {
        Some(s) if s.token.len() >= 32 => s.token.clone(),
        _ => new_token()?,
    };
    let server = saved
        .as_ref()
        .and_then(|s| tiny_http::Server::http(("127.0.0.1", s.port)).ok())
        .map(Ok)
        .unwrap_or_else(|| tiny_http::Server::http("127.0.0.1:0"))
        .map_err(|e| format!("Couldn't start the Claude connector: {e}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or("Couldn't read the connector's port")?;
    let info = McpInfo {
        port,
        url: format!("http://127.0.0.1:{port}/mcp"),
        token: token.clone(),
    };
    write_config(&info);

    let server = Arc::new(server);
    let target = Arc::new(Mutex::new(window.label().to_string()));
    {
        let server = server.clone();
        let target = target.clone();
        let pending = state.pending.clone();
        let next_id = state.next_id.clone();
        let app = app.clone();
        std::thread::Builder::new()
            .name("sleap-mcp".into())
            .spawn(move || {
                // recv() errors once mcp_stop unblocks the server.
                while let Ok(req) = server.recv() {
                    let (app, token, target, pending, next_id) =
                        (app.clone(), token.clone(), target.clone(), pending.clone(), next_id.clone());
                    std::thread::spawn(move || handle(app, req, token, target, pending, next_id));
                }
            })
            .map_err(|e| format!("Couldn't start the Claude connector: {e}"))?;
    }
    *running = Some(Running { server, info: info.clone(), target });
    Ok(info)
}

/// Stop the endpoint. Claude's next call fails to connect.
#[tauri::command]
pub fn mcp_stop<R: Runtime>(app: AppHandle<R>) {
    let state = bridge(&app);
    if let Some(r) = state.running.lock().unwrap().take() {
        r.server.unblock();
    }
    // Requests in flight get "stopped" (their senders drop).
    state.pending.lock().unwrap().clear();
}

/// Whether the endpoint is running, and its address and token.
#[tauri::command]
pub fn mcp_status<R: Runtime>(app: AppHandle<R>) -> Option<McpInfo> {
    bridge(&app).running.lock().unwrap().as_ref().map(|r| r.info.clone())
}

/// The window's reply to request `id` (empty = no response body).
#[tauri::command]
pub fn mcp_response<R: Runtime>(app: AppHandle<R>, id: u64, body: String) {
    if let Some(tx) = bridge(&app).pending.lock().unwrap().remove(&id) {
        let _ = tx.send(body);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "0123456789abcdef0123456789abcdef";
    const AUTH: &str = "Bearer 0123456789abcdef0123456789abcdef";

    fn check(method: &str, host: Option<&str>, origin: Option<&str>, auth: Option<&str>) -> Verdict {
        check_request(method, "/mcp", host, origin, auth, TOKEN)
    }

    // Why: the endpoint must only answer this machine's Claude, with the token.
    #[test]
    fn forwards_a_good_request() {
        assert_eq!(check("POST", Some("127.0.0.1:5555"), None, Some(AUTH)), Verdict::Forward);
        assert_eq!(check("POST", Some("localhost:5555"), None, Some(AUTH)), Verdict::Forward);
        assert_eq!(check("POST", Some("[::1]:5555"), None, Some(AUTH)), Verdict::Forward);
    }

    // Why: no token, no access — even from this machine.
    #[test]
    fn refuses_a_missing_or_wrong_token() {
        assert!(matches!(check("POST", Some("127.0.0.1:1"), None, None), Verdict::Reject(401, _)));
        assert!(matches!(
            check("POST", Some("127.0.0.1:1"), None, Some("Bearer nope")),
            Verdict::Reject(401, _)
        ));
        assert!(matches!(check("POST", Some("127.0.0.1:1"), None, Some(TOKEN)), Verdict::Reject(401, _)));
    }

    // Why: a web page that rebinds its domain to 127.0.0.1 still sends its own Host/Origin.
    #[test]
    fn refuses_a_non_loopback_host_or_origin() {
        assert!(matches!(check("POST", Some("evil.com"), None, Some(AUTH)), Verdict::Reject(403, _)));
        assert!(matches!(check("POST", Some("evil.com:5555"), None, Some(AUTH)), Verdict::Reject(403, _)));
        assert!(matches!(check("POST", None, None, Some(AUTH)), Verdict::Reject(403, _)));
        assert!(matches!(
            check("POST", Some("127.0.0.1:1"), Some("https://evil.com"), Some(AUTH)),
            Verdict::Reject(403, _)
        ));
        assert!(matches!(
            check("POST", Some("127.0.0.1:1"), Some("null"), Some(AUTH)),
            Verdict::Reject(403, _)
        ));
        assert_eq!(
            check("POST", Some("127.0.0.1:1"), Some("http://localhost:1420"), Some(AUTH)),
            Verdict::Forward
        );
    }

    // Why: only POST /mcp is served.
    #[test]
    fn refuses_other_paths_and_methods() {
        assert!(matches!(
            check_request("POST", "/other", Some("127.0.0.1:1"), None, Some(AUTH), TOKEN),
            Verdict::Reject(404, _)
        ));
        assert!(matches!(check("GET", Some("127.0.0.1:1"), None, Some(AUTH)), Verdict::Reject(405, _)));
        assert_eq!(
            check_request("POST", "/mcp?x=1", Some("127.0.0.1:1"), None, Some(AUTH), TOKEN),
            Verdict::Forward
        );
    }

    // Why: tokens must be long and random.
    #[test]
    fn makes_long_random_tokens() {
        let a = new_token().unwrap();
        let b = new_token().unwrap();
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
        assert!(same_secret(&a, &a.clone()));
        assert!(!same_secret(&a, &b));
    }

    // Why: the real server must refuse a request without the token, end to end.
    #[test]
    fn real_server_refuses_without_token() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = server.server_addr().to_ip().unwrap().port();
        let t = std::thread::spawn(move || {
            let req = server.recv().unwrap();
            let verdict = check_request(
                req.method().as_str(),
                req.url(),
                header(&req, "Host"),
                header(&req, "Origin"),
                header(&req, "Authorization"),
                TOKEN,
            );
            if let Verdict::Reject(status, msg) = verdict {
                respond(req, status, error_body(msg), true);
            }
        });
        use std::io::{Read as _, Write as _};
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(
            s,
            "POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
        )
        .unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        t.join().unwrap();
        assert!(out.starts_with("HTTP/1.1 401"), "{out}");
        assert!(out.contains("WWW-Authenticate: Bearer"));
    }
}
