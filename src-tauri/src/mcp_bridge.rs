//! Loopback MCP endpoint for the Claude connector (QC review prototype).
//!
//! Claude Code talks MCP's Streamable HTTP transport: one JSON-RPC message per
//! `POST /mcp`, the reply in the response body. This module only carries
//! bytes: it checks the request is from this machine and carries the token,
//! hands the body to the SLEAP window that owns the connector (an
//! `mcp:request {id, body, session}` event), and waits for that window's
//! `mcp_response {id, body, session}` to answer. The MCP server itself —
//! tools, schemas, instructions — runs in the window (src/automation/mcpServer.ts).
//!
//! Safety: off until the user turns on "Allow Claude to control SLEAP"; binds
//! 127.0.0.1 only; every request needs `Authorization: Bearer <token>`; a
//! `Host` or `Origin` that isn't loopback is refused (DNS rebinding).
//!
//! Token and port: the token is new every launch and kept only in memory and
//! in `~/.sleap-app/mcp-headers.json` (mode 600), which Claude Code reads with
//! a `headersHelper` on every connection — so the connect command is run once,
//! not once per launch. The port is picked once and saved in
//! `~/.sleap-app/mcp.json`; if it's taken later, starting fails with a clear
//! message instead of quietly moving (which would break the saved command).
//! Picking a new port is an explicit choice in the UI.

use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// How long a request waits for the window (render_flag decodes a frame).
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);
/// Largest request body accepted.
const MAX_BODY: u64 = 4 * 1024 * 1024;
/// Event the window listens for.
const REQUEST_EVENT: &str = "mcp:request";
/// The MCP session header (Streamable HTTP).
const SESSION_HEADER: &str = "Mcp-Session-Id";
/// Accept errors in a row before the listener gives up and reports it.
const MAX_ACCEPT_ERRORS: u32 = 50;

/// Where the endpoint listens.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct McpInfo {
    pub port: u16,
    pub url: String,
}

/// What `mcp_status` reports to the Environment panel.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct McpStatus {
    /// The endpoint is listening.
    pub running: bool,
    pub info: Option<McpInfo>,
    /// Label of the window that answers requests.
    pub owner: Option<String>,
    /// Whether that window is still open.
    pub owner_alive: bool,
    /// The last problem (the listener stopped, …), if any.
    pub error: Option<String>,
    /// The command that connects Claude Code (needs the headers file path).
    pub connect_command: Option<String>,
}

/// One request handed to the window.
#[derive(Serialize, Clone, Debug)]
pub struct RequestPayload {
    pub id: u64,
    pub body: String,
    /// The client's `Mcp-Session-Id`, if it sent one.
    pub session: Option<String>,
}

/// The window's answer: a body (empty = none) and, for `initialize`, a new session id.
#[derive(Debug)]
pub struct Reply {
    pub body: String,
    pub session: Option<String>,
}

/// How requests reach the window (a seam so the HTTP path can be tested without Tauri).
pub trait Deliver: Send + Sync + 'static {
    fn window_alive(&self, label: &str) -> bool;
    fn deliver(&self, label: &str, payload: RequestPayload) -> Result<(), String>;
}

struct TauriDeliver<R: Runtime>(AppHandle<R>);

impl<R: Runtime> Deliver for TauriDeliver<R> {
    fn window_alive(&self, label: &str) -> bool {
        self.0.get_webview_window(label).is_some()
    }
    fn deliver(&self, label: &str, payload: RequestPayload) -> Result<(), String> {
        // emit_to returns Ok even when no window has that label, hence window_alive.
        self.0.emit_to(label, REQUEST_EVENT, payload).map_err(|e| e.to_string())
    }
}

type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Reply>>>>;

struct Running {
    server: Arc<tiny_http::Server>,
    info: McpInfo,
    target: Arc<Mutex<String>>,
    stopped: Arc<AtomicBool>,
    /// Cleared when the listener thread exits.
    listening: Arc<AtomicBool>,
}

pub struct McpBridge {
    running: Mutex<Option<Running>>,
    pending: Pending,
    next_id: Arc<AtomicU64>,
    /// This launch's token (made on first start, never written to mcp.json).
    token: OnceLock<String>,
    last_error: Arc<Mutex<Option<String>>>,
    timeout: Duration,
}

impl Default for McpBridge {
    fn default() -> Self {
        Self::with_timeout(REQUEST_TIMEOUT)
    }
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
                "Unauthorized: missing or wrong token. SLEAP makes a new token each launch; Claude Code reads it with the headersHelper from SLEAP's connect command.",
            )
        }
    }
    if method != "POST" {
        // No server-to-client stream (GET) or session teardown (DELETE) in the prototype.
        return Verdict::Reject(405, "Method not allowed: send JSON-RPC with POST.");
    }
    Verdict::Forward
}

/// The port to bind: the saved one (exactly), or any free one when there is
/// none saved or the user asked for a new one.
pub fn choose_port(saved: Option<u16>, new_port: bool) -> Option<u16> {
    if new_port {
        None
    } else {
        saved
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

fn respond(req: tiny_http::Request, status: u16, body: String, json: bool, session: Option<&str>) {
    let mut resp = tiny_http::Response::from_string(body).with_status_code(status);
    let mut add = |k: &str, v: &str| {
        if let Ok(h) = tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()) {
            resp.add_header(h);
        }
    };
    if json {
        add("Content-Type", "application/json");
    }
    if status == 401 {
        add("WWW-Authenticate", "Bearer");
    }
    if let Some(s) = session {
        add(SESSION_HEADER, s);
    }
    let _ = req.respond(resp);
}

fn error_body(msg: &str) -> String {
    serde_json::json!({ "error": msg }).to_string()
}

struct HandleCtx {
    deliver: Arc<dyn Deliver>,
    token: String,
    target: Arc<Mutex<String>>,
    pending: Pending,
    next_id: Arc<AtomicU64>,
    timeout: Duration,
}

fn handle(ctx: &HandleCtx, mut req: tiny_http::Request) {
    let verdict = check_request(
        req.method().as_str(),
        req.url(),
        header(&req, "Host"),
        header(&req, "Origin"),
        header(&req, "Authorization"),
        &ctx.token,
    );
    if let Verdict::Reject(status, msg) = verdict {
        respond(req, status, error_body(msg), true, None);
        return;
    }
    let mut body = String::new();
    if req.as_reader().take(MAX_BODY + 1).read_to_string(&mut body).is_err() {
        respond(req, 400, error_body("Body must be UTF-8 JSON."), true, None);
        return;
    }
    if body.len() as u64 > MAX_BODY {
        respond(req, 413, error_body("Request too large."), true, None);
        return;
    }
    let label = ctx.target.lock().unwrap().clone();
    if !ctx.deliver.window_alive(&label) {
        respond(
            req,
            503,
            error_body(
                "The SLEAP window running the Claude connector was closed. Turn on \"Allow Claude to control SLEAP\" in an open SLEAP window.",
            ),
            true,
            None,
        );
        return;
    }

    let id = ctx.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let (tx, rx) = mpsc::channel();
    ctx.pending.lock().unwrap().insert(id, tx);
    let session = header(&req, SESSION_HEADER).map(str::to_string);
    if ctx.deliver.deliver(&label, RequestPayload { id, body, session }).is_err() {
        ctx.pending.lock().unwrap().remove(&id);
        respond(req, 503, error_body("The SLEAP window isn't available."), true, None);
        return;
    }
    match rx.recv_timeout(ctx.timeout) {
        Ok(reply) if reply.body.is_empty() => respond(req, 202, String::new(), false, reply.session.as_deref()),
        Ok(reply) => respond(req, 200, reply.body, true, reply.session.as_deref()),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            ctx.pending.lock().unwrap().remove(&id);
            respond(
                req,
                504,
                error_body("SLEAP didn't answer in time. Is the project window open and responsive?"),
                true,
                None,
            );
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            respond(req, 503, error_body("SLEAP stopped the Claude connector."), true, None);
        }
    }
}

impl McpBridge {
    pub fn with_timeout(timeout: Duration) -> Self {
        Self {
            running: Mutex::new(None),
            pending: Arc::default(),
            next_id: Arc::default(),
            token: OnceLock::new(),
            last_error: Arc::default(),
            timeout,
        }
    }

    /// This launch's token (made once per process).
    pub fn token(&self) -> Result<String, String> {
        if let Some(t) = self.token.get() {
            return Ok(t.clone());
        }
        let t = new_token()?;
        Ok(self.token.get_or_init(|| t).clone())
    }

    /// Start listening on `port` (exactly) or any free port (`None`), with
    /// requests going to window `owner`. Already running: just re-target.
    pub fn start(&self, deliver: Arc<dyn Deliver>, owner: &str, port: Option<u16>) -> Result<McpInfo, String> {
        let mut running = self.running.lock().unwrap();
        if let Some(r) = running.as_ref() {
            if r.listening.load(Ordering::SeqCst) {
                *r.target.lock().unwrap() = owner.to_string();
                return Ok(r.info.clone());
            }
            // The listener died: start over.
            running.take();
        }
        let token = self.token()?;
        let server = match port {
            Some(p) => tiny_http::Server::http(("127.0.0.1", p)).map_err(|e| {
                format!(
                    "PORT_IN_USE: Port {p} (where Claude Code expects SLEAP) is in use by another program ({e}). Close that program, or choose a new port and run the connect command again."
                )
            })?,
            None => tiny_http::Server::http("127.0.0.1:0").map_err(|e| format!("Couldn't start the Claude connector: {e}"))?,
        };
        let port = server.server_addr().to_ip().map(|a| a.port()).ok_or("Couldn't read the connector's port")?;
        let info = McpInfo { port, url: format!("http://127.0.0.1:{port}/mcp") };
        *self.last_error.lock().unwrap() = None;

        let server = Arc::new(server);
        let target = Arc::new(Mutex::new(owner.to_string()));
        let stopped = Arc::new(AtomicBool::new(false));
        let listening = Arc::new(AtomicBool::new(true));
        let ctx = Arc::new(HandleCtx {
            deliver,
            token,
            target: target.clone(),
            pending: self.pending.clone(),
            next_id: self.next_id.clone(),
            timeout: self.timeout,
        });
        {
            let (server, stopped, listening, last_error) =
                (server.clone(), stopped.clone(), listening.clone(), self.last_error.clone());
            std::thread::Builder::new()
                .name("sleap-mcp".into())
                .spawn(move || {
                    let mut errors = 0u32;
                    loop {
                        match server.recv() {
                            Ok(req) => {
                                errors = 0;
                                let ctx = ctx.clone();
                                std::thread::spawn(move || handle(&ctx, req));
                            }
                            Err(_) if stopped.load(Ordering::SeqCst) => break,
                            Err(e) => {
                                // A passing accept error: keep listening, but don't spin.
                                errors += 1;
                                log::warn!("Claude connector: accept error: {e}");
                                if errors >= MAX_ACCEPT_ERRORS {
                                    *last_error.lock().unwrap() =
                                        Some(format!("The Claude connector stopped listening: {e}. Turn it off and on again."));
                                    break;
                                }
                                std::thread::sleep(Duration::from_millis(50));
                            }
                        }
                    }
                    listening.store(false, Ordering::SeqCst);
                })
                .map_err(|e| format!("Couldn't start the Claude connector: {e}"))?;
        }
        *running = Some(Running { server, info: info.clone(), target, stopped, listening });
        Ok(info)
    }

    pub fn stop(&self) {
        if let Some(r) = self.running.lock().unwrap().take() {
            r.stopped.store(true, Ordering::SeqCst);
            r.server.unblock();
        }
        // Requests in flight get "stopped" (their senders drop).
        self.pending.lock().unwrap().clear();
    }

    /// The window's reply to request `id`.
    pub fn respond(&self, id: u64, body: String, session: Option<String>) {
        if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
            let _ = tx.send(Reply { body, session });
        }
    }

    pub fn status(&self, deliver: &dyn Deliver) -> McpStatus {
        let running = self.running.lock().unwrap();
        let r = running.as_ref();
        let listening = r.is_some_and(|r| r.listening.load(Ordering::SeqCst));
        let owner = r.map(|r| r.target.lock().unwrap().clone());
        McpStatus {
            running: listening,
            info: r.map(|r| r.info.clone()),
            owner_alive: owner.as_deref().is_some_and(|o| deliver.window_alive(o)),
            owner,
            error: self.last_error.lock().unwrap().clone(),
            connect_command: r.and_then(|r| connect_command(&r.info)),
        }
    }
}

// ---- files under ~/.sleap-app ----

fn sleap_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".sleap-app"))
}

fn config_path() -> Option<PathBuf> {
    sleap_dir().map(|d| d.join("mcp.json"))
}

fn headers_path() -> Option<PathBuf> {
    sleap_dir().map(|d| d.join("mcp-headers.json"))
}

fn read_saved_port() -> Option<u16> {
    let text = std::fs::read_to_string(config_path()?).ok()?;
    serde_json::from_str::<McpInfo>(&text).ok().map(|i| i.port)
}

/// Write `text` to `path`, readable only by this user on Unix.
fn write_private(path: &PathBuf, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(path).map_err(|e| e.to_string())?;
    use std::io::Write;
    f.write_all(text.as_bytes()).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    Ok(())
}

/// The headers Claude Code sends, as its headersHelper prints them.
pub fn headers_json(token: &str) -> String {
    serde_json::json!({ "Authorization": format!("Bearer {token}") }).to_string()
}

/// `claude mcp add-json` with a headersHelper that reads this launch's token.
pub fn connect_command(info: &McpInfo) -> Option<String> {
    let headers = headers_path()?;
    let config = serde_json::json!({
        "type": "http",
        "url": info.url,
        "headersHelper": format!("cat '{}'", headers.display()),
    });
    Some(format!("claude mcp add-json --scope user sleap '{config}'"))
}

fn bridge<R: Runtime>(app: &AppHandle<R>) -> tauri::State<'_, McpBridge> {
    if app.try_state::<McpBridge>().is_none() {
        app.manage(McpBridge::default());
    }
    app.state::<McpBridge>()
}

/// Start the endpoint, owned by the calling window (or make it the owner if
/// running). `new_port`: give up the saved port and pick a free one (the
/// connect command must then be run again).
#[tauri::command]
pub fn mcp_start<R: Runtime>(
    app: AppHandle<R>,
    window: tauri::Window<R>,
    new_port: Option<bool>,
) -> Result<McpStatus, String> {
    let state = bridge(&app);
    let deliver: Arc<dyn Deliver> = Arc::new(TauriDeliver(app.clone()));
    let port = choose_port(read_saved_port(), new_port.unwrap_or(false));
    let info = state.start(deliver.clone(), window.label(), port)?;
    let token = state.token()?;
    let headers = headers_path().ok_or("Couldn't find the home folder")?;
    write_private(&headers, &headers_json(&token)).map_err(|e| format!("Couldn't write {}: {e}", headers.display()))?;
    let config = config_path().ok_or("Couldn't find the home folder")?;
    write_private(&config, &serde_json::to_string_pretty(&info).unwrap_or_default())
        .map_err(|e| format!("Couldn't write {}: {e}", config.display()))?;
    Ok(state.status(deliver.as_ref()))
}

/// Stop the endpoint. Claude's next call fails to connect.
#[tauri::command]
pub fn mcp_stop<R: Runtime>(app: AppHandle<R>) {
    bridge(&app).stop();
}

/// Whether the endpoint is running, which window owns it, and the connect command.
#[tauri::command]
pub fn mcp_status<R: Runtime>(app: AppHandle<R>) -> McpStatus {
    let deliver = TauriDeliver(app.clone());
    bridge(&app).status(&deliver)
}

/// The window's reply to request `id` (empty body = none; `session` = a new
/// session id to return, on `initialize`).
#[tauri::command]
pub fn mcp_response<R: Runtime>(app: AppHandle<R>, id: u64, body: String, session: Option<String>) {
    bridge(&app).respond(id, body, session);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write as _;

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
        assert!(matches!(check("POST", Some("127.0.0.1:1"), None, Some("Bearer nope")), Verdict::Reject(401, _)));
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
        assert!(matches!(check("POST", Some("127.0.0.1:1"), Some("null"), Some(AUTH)), Verdict::Reject(403, _)));
        assert_eq!(check("POST", Some("127.0.0.1:1"), Some("http://localhost:1420"), Some(AUTH)), Verdict::Forward);
    }

    // Why: only POST /mcp is served.
    #[test]
    fn refuses_other_paths_and_methods() {
        assert!(matches!(
            check_request("POST", "/other", Some("127.0.0.1:1"), None, Some(AUTH), TOKEN),
            Verdict::Reject(404, _)
        ));
        assert!(matches!(check("GET", Some("127.0.0.1:1"), None, Some(AUTH)), Verdict::Reject(405, _)));
        assert_eq!(check_request("POST", "/mcp?x=1", Some("127.0.0.1:1"), None, Some(AUTH), TOKEN), Verdict::Forward);
    }

    // Why: the token is new each launch (per bridge) and long and random; the port is never silently changed.
    #[test]
    fn tokens_are_per_launch_and_ports_stay_put() {
        let a = McpBridge::default();
        let b = McpBridge::default();
        assert_eq!(a.token().unwrap().len(), 64);
        assert_eq!(a.token().unwrap(), a.token().unwrap());
        assert_ne!(a.token().unwrap(), b.token().unwrap());
        assert_eq!(choose_port(Some(5555), false), Some(5555));
        assert_eq!(choose_port(Some(5555), true), None);
        assert_eq!(choose_port(None, false), None);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&headers_json("t")).unwrap()["Authorization"],
            "Bearer t"
        );
    }

    /// A fake window: answers each request with `reply(body)` (None = never answers).
    struct FakeWindow {
        bridge: Mutex<Option<Arc<McpBridge>>>,
        alive: AtomicBool,
        reply: fn(&RequestPayload) -> Option<Reply>,
        seen: Mutex<Vec<RequestPayload>>,
    }
    impl Deliver for FakeWindow {
        fn window_alive(&self, label: &str) -> bool {
            label == "main" && self.alive.load(Ordering::SeqCst)
        }
        fn deliver(&self, _label: &str, payload: RequestPayload) -> Result<(), String> {
            self.seen.lock().unwrap().push(payload.clone());
            if let Some(r) = (self.reply)(&payload) {
                let bridge = self.bridge.lock().unwrap().clone().unwrap();
                std::thread::spawn(move || bridge.respond(payload.id, r.body, r.session));
            }
            Ok(())
        }
    }

    fn setup(reply: fn(&RequestPayload) -> Option<Reply>) -> (Arc<McpBridge>, Arc<FakeWindow>, McpInfo) {
        let bridge = Arc::new(McpBridge::with_timeout(Duration::from_millis(300)));
        let win = Arc::new(FakeWindow {
            bridge: Mutex::new(Some(bridge.clone())),
            alive: AtomicBool::new(true),
            reply,
            seen: Mutex::new(Vec::new()),
        });
        let info = bridge.start(win.clone(), "main", None).unwrap();
        (bridge, win, info)
    }

    /// Send a raw HTTP request; returns the whole response text.
    fn post(port: u16, host: &str, auth: Option<&str>, extra: &str, body: &str) -> String {
        let mut s = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        let auth = auth.map(|a| format!("Authorization: {a}\r\n")).unwrap_or_default();
        write!(
            s,
            "POST /mcp HTTP/1.1\r\nHost: {host}\r\n{auth}{extra}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .unwrap();
        let mut out = String::new();
        s.read_to_string(&mut out).unwrap();
        out
    }

    fn echo(p: &RequestPayload) -> Option<Reply> {
        let session = if p.body.contains("initialize") { Some("s-1".to_string()) } else { None };
        let body = if p.body.contains("notifications/") { String::new() } else { format!("{{\"echo\":{}}}", p.body) };
        Some(Reply { body, session })
    }

    // Why: end to end through the real server, handle() and the window seam: a good request is answered.
    #[test]
    fn answers_through_the_window_and_returns_the_session() {
        let (bridge, win, info) = setup(echo);
        let token = bridge.token().unwrap();
        let host = format!("127.0.0.1:{}", info.port);
        let auth = format!("Bearer {token}");
        let out = post(info.port, &host, Some(&auth), "", r#"{"method":"initialize"}"#);
        assert!(out.starts_with("HTTP/1.1 200"), "{out}");
        assert!(out.contains(r#"{"echo":{"method":"initialize"}}"#));
        assert!(out.contains("Mcp-Session-Id: s-1"));
        // The client's session reaches the window; a notification gets 202.
        let out = post(info.port, &host, Some(&auth), "Mcp-Session-Id: s-1\r\n", r#"{"method":"notifications/x"}"#);
        assert!(out.starts_with("HTTP/1.1 202"), "{out}");
        assert_eq!(win.seen.lock().unwrap()[1].session.as_deref(), Some("s-1"));
        bridge.stop();
    }

    // Why: the token, Host and window checks must hold on the real server, not only in check_request.
    #[test]
    fn real_server_refuses_bad_requests_and_a_closed_window() {
        let (bridge, win, info) = setup(echo);
        let auth = format!("Bearer {}", bridge.token().unwrap());
        let host = format!("127.0.0.1:{}", info.port);
        let out = post(info.port, &host, None, "", "{}");
        assert!(out.starts_with("HTTP/1.1 401"), "{out}");
        assert!(out.contains("WWW-Authenticate: Bearer"));
        assert!(post(info.port, "evil.com", Some(&auth), "", "{}").starts_with("HTTP/1.1 403"));
        assert!(win.seen.lock().unwrap().is_empty());
        // The owner window closes: fail fast with 503, don't wait for the timeout.
        win.alive.store(false, Ordering::SeqCst);
        let t = std::time::Instant::now();
        let out = post(info.port, &host, Some(&auth), "", "{}");
        assert!(out.starts_with("HTTP/1.1 503"), "{out}");
        assert!(t.elapsed() < Duration::from_millis(250));
        assert!(!bridge.status(win.as_ref()).owner_alive);
        bridge.stop();
    }

    // Why: a window that never answers must not hang Claude forever.
    #[test]
    fn times_out_when_the_window_doesnt_answer() {
        let (bridge, _win, info) = setup(|_| None);
        let auth = format!("Bearer {}", bridge.token().unwrap());
        let out = post(info.port, &format!("127.0.0.1:{}", info.port), Some(&auth), "", "{}");
        assert!(out.starts_with("HTTP/1.1 504"), "{out}");
        bridge.stop();
    }

    // Why: a taken port must fail with a clear message, not move somewhere Claude Code doesn't know.
    #[test]
    fn a_taken_port_fails_visibly() {
        let taken = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = taken.local_addr().unwrap().port();
        let bridge = McpBridge::default();
        let win: Arc<dyn Deliver> = Arc::new(FakeWindow {
            bridge: Mutex::new(None),
            alive: AtomicBool::new(true),
            reply: |_| None,
            seen: Mutex::new(Vec::new()),
        });
        let err = bridge.start(win, "main", Some(port)).unwrap_err();
        assert!(err.starts_with("PORT_IN_USE"), "{err}");
        assert!(err.contains(&port.to_string()));
    }

    // Why: once stopped, Claude's next call must fail to connect; starting again re-targets the owner.
    #[test]
    fn stop_closes_the_port_and_start_retargets() {
        let (bridge, win, info) = setup(echo);
        let again = bridge.start(win.clone(), "main-2", None).unwrap();
        assert_eq!(again, info);
        assert_eq!(bridge.status(win.as_ref()).owner.as_deref(), Some("main-2"));
        bridge.stop();
        std::thread::sleep(Duration::from_millis(50));
        assert!(std::net::TcpStream::connect(("127.0.0.1", info.port)).is_err());
        assert!(!bridge.status(win.as_ref()).running);
    }
}
