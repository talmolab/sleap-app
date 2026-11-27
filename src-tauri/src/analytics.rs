//! Usage analytics: the desktop app's network transport, and the OS facts the
//! WebView cannot read for itself.
//!
//! The frontend decides WHAT is sent and WHETHER anything is sent at all
//! (`src/lib/analytics/`; the user's Help ▸ Share Usage Data setting lives
//! there). This module only carries a finished JSON body to the analytics
//! service and reports the HTTP status back.
//!
//! WHY NATIVE, when the WebView has `fetch`. The service's original endpoint,
//! `POST /ping`, answers no CORS preflight -- on purpose, so that no web page
//! can make its visitors' browsers post pings. A WebView is a browser, so it
//! cannot reach `/ping` either. Native code is not subject to CORS, which is
//! what lets the desktop app report a launch to a service that has not yet
//! been upgraded with `/v2/events`. Posting everything from here also means
//! the desktop app never depends on the service's origin allow-list.
//!
//! WHY THE FRONTEND SENDS A PATH AND NOT A URL. Same rule as
//! `update_channels.rs`, where the frontend sends a channel name: the host is
//! fixed here, and the path must be one of two known endpoints, so this
//! command cannot be used to make the app post to anywhere else.

use std::sync::OnceLock;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_shell::ShellExt;

const DEFAULT_BASE_URL: &str = "https://analytics.sleap.ai";

/// Overrides the service URL, for running against a local
/// talmolab/sleap-analytics-service (`uvicorn app.main:app`).
/// In release builds, only loopback overrides (`http://127.0.0.1`,
/// `http://localhost`, `http://[::1]`) are honored so an ambient environment
/// variable cannot redirect analytics to an arbitrary third-party host.
const BASE_URL_ENV: &str = "SLEAP_ANALYTICS_URL";

/// The only paths this command will post to.
const ALLOWED_PATHS: [&str; 2] = ["/v2/events", "/ping"];

/// The service rejects anything larger (`MAX_BODY_BYTES` in its `app/events.py`).
const MAX_BODY_BYTES: usize = 64 * 1024;

/// Generous for a request this small, short enough that a dead network never
/// leaves a request hanging for the life of the window.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(15);

static HTTP_CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();

fn http_client() -> Result<&'static reqwest::Client, String> {
    let entry = HTTP_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent("sleap-app")
            .timeout(NETWORK_TIMEOUT)
            // Never follow redirects: prevents a 307/308 from forwarding the
            // analytics body to another host.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| e.to_string())
    });
    entry.as_ref().map_err(Clone::clone)
}

fn is_loopback_url(url: &str) -> bool {
    let rest = match url
        .strip_prefix("http://")
        .or_else(|| url.strip_prefix("https://"))
    {
        Some(r) => r,
        None => return false,
    };
    let authority = rest.split('/').next().unwrap_or("");
    if authority.contains('@') {
        return false;
    }
    if let Some(after) = authority.strip_prefix("[::1]") {
        return after.is_empty() || after.starts_with(':');
    }
    let host = authority.split(':').next().unwrap_or("");
    host == "localhost" || host == "127.0.0.1"
}

fn resolve_base_url(override_raw: Option<&str>, allow_non_loopback: bool) -> String {
    override_raw
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| value.starts_with("https://") || value.starts_with("http://"))
        .filter(|value| allow_non_loopback || is_loopback_url(value))
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
}

fn base_url() -> String {
    let raw = std::env::var(BASE_URL_ENV).ok();
    resolve_base_url(raw.as_deref(), cfg!(debug_assertions))
}

fn endpoint(base: &str, path: &str) -> Result<String, String> {
    if ALLOWED_PATHS.contains(&path) {
        Ok(format!("{base}{path}"))
    } else {
        Err(format!("not an analytics endpoint: {path}"))
    }
}

/// POST a JSON body to the analytics service and return the HTTP status.
///
/// An `Err` means no answer came back at all (offline, DNS, timeout); the
/// frontend treats that the same as a 5xx and retries later. Any status the
/// service did return, including 4xx, is an `Ok`: what to do about it is the
/// frontend's decision (`classifyStatus` in `src/lib/analytics/client.ts`).
/// An oversize body returns `Ok(413)` (not `Err`) so the frontend drops it
/// immediately instead of head-of-line blocking the queue on retries.
#[tauri::command]
pub async fn analytics_post(path: String, body: String) -> Result<u16, String> {
    let url = endpoint(&base_url(), &path)?;
    if body.len() > MAX_BODY_BYTES {
        return Ok(413);
    }
    let client = http_client()?;
    let response = client
        .post(url)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    Ok(response.status().as_u16())
}

/// The operating system, coarsely. Deliberately NOT the hostname, the user
/// name or the kernel build: those identify a machine or a person, and what
/// support needs is "which OS release".
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    /// `macos` / `windows` / `linux` (Rust's `std::env::consts::OS`).
    pub os: String,
    /// `14.5` on macOS, `10` or `11` on Windows, `ubuntu-22.04` on Linux.
    pub os_version: Option<String>,
    /// `arm64` or `x86_64`.
    pub arch: Option<String>,
}

/// Rust calls Apple Silicon `aarch64`; everything else in this app, and
/// Python's `platform.machine()` on macOS, calls it `arm64`.
fn normalize_arch(arch: &str) -> String {
    match arch {
        "aarch64" => "arm64".to_string(),
        other => other.to_string(),
    }
}

/// `10` or `11` from the output of `cmd /C ver`, e.g.
/// `Microsoft Windows [Version 10.0.22631.4460]` or localized equivalents
/// (`[version 10.0...]`, `[Versión 10.0...]`, `[版本 10.0...]`, `[Версия 10.0...]`).
///
/// Windows 11 still reports major version 10; the build number is the only
/// thing that tells them apart, and 22000 was the first Windows 11 build.
/// The build number itself is dropped: it changes with every monthly update
/// and adds nothing a support question needs.
fn parse_windows_version(ver_output: &str) -> Option<String> {
    // Prefer the bracketed version segment (`[...]`), falling back to the whole
    // string, and scan for the first dotted triple `major.minor.build` without
    // relying on the English word "Version".
    let slice = match (ver_output.find('['), ver_output.rfind(']')) {
        (Some(start), Some(end)) if start < end => &ver_output[start + 1..end],
        _ => ver_output,
    };
    let bytes = slice.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == b'.') {
                i += 1;
            }
            let token = slice[start..i].trim_matches('.');
            let parts: Vec<&str> = token.split('.').collect();
            if parts.len() >= 3 {
                if let (Ok(major), Ok(build)) = (parts[0].parse::<u32>(), parts[2].parse::<u32>()) {
                    if major == 10 && build >= 22000 {
                        return Some("11".to_string());
                    }
                    return Some(major.to_string());
                }
            }
        } else {
            i += 1;
        }
    }
    None
}

/// `ubuntu-22.04` from the contents of `/etc/os-release` (`ID` and
/// `VERSION_ID`). Rolling distributions have no `VERSION_ID`; then just `arch`.
fn parse_os_release(contents: &str) -> Option<String> {
    let field = |name: &str| {
        contents.lines().find_map(|line| {
            let value = line.strip_prefix(name)?.strip_prefix('=')?;
            let value = value.trim().trim_matches('"').trim_matches('\'');
            // Only what a distribution id or version can contain; this string
            // is sent, so nothing unexpected may ride along.
            let clean: String = value
                .chars()
                .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
                .take(32)
                .collect();
            (!clean.is_empty()).then_some(clean)
        })
    };
    let id = field("ID")?;
    Some(match field("VERSION_ID") {
        Some(version) => format!("{id}-{version}"),
        None => id,
    })
}

async fn os_version<R: Runtime>(app: &AppHandle<R>) -> Option<String> {
    match std::env::consts::OS {
        "macos" => {
            let output = app.shell().command("sw_vers").args(["-productVersion"]).output().await.ok()?;
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let plausible = !version.is_empty()
                && version.len() <= 16
                && version.chars().all(|c| c.is_ascii_digit() || c == '.');
            plausible.then_some(version)
        }
        "windows" => {
            let output = app.shell().command("cmd").args(["/C", "ver"]).output().await.ok()?;
            parse_windows_version(&String::from_utf8_lossy(&output.stdout))
        }
        "linux" => parse_os_release(&std::fs::read_to_string("/etc/os-release").ok()?),
        _ => None,
    }
}

/// OS name, release and CPU architecture, for the analytics `context`.
#[tauri::command]
pub async fn system_info<R: Runtime>(app: AppHandle<R>) -> SystemInfo {
    SystemInfo {
        os: std::env::consts::OS.to_string(),
        os_version: os_version(&app).await,
        arch: Some(normalize_arch(std::env::consts::ARCH)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_two_analytics_paths_are_reachable() {
        let base = "https://analytics.sleap.ai";
        assert_eq!(endpoint(base, "/v2/events").unwrap(), "https://analytics.sleap.ai/v2/events");
        assert_eq!(endpoint(base, "/ping").unwrap(), "https://analytics.sleap.ai/ping");
        for path in ["", "/", "/pings", "/v2/events/../../admin", "//evil.example/ping", "@evil.example/ping", "/ping?x=1"] {
            assert!(endpoint(base, path).is_err(), "{path} must be refused");
        }
    }

    #[test]
    fn base_url_override_is_loopback_only_in_release_builds() {
        assert_eq!(resolve_base_url(Some("http://127.0.0.1:8099/"), false), "http://127.0.0.1:8099");
        assert_eq!(resolve_base_url(Some("http://localhost:8099"), false), "http://localhost:8099");
        assert_eq!(resolve_base_url(Some("http://[::1]:8099"), false), "http://[::1]:8099");
        assert_eq!(resolve_base_url(Some("https://evil.example"), false), DEFAULT_BASE_URL);
        assert_eq!(resolve_base_url(Some("http://localhost.evil.example"), false), DEFAULT_BASE_URL);
        assert_eq!(resolve_base_url(Some("http://127.0.0.1@evil.example"), false), DEFAULT_BASE_URL);
        // Debug builds allow any http(s) override.
        assert_eq!(resolve_base_url(Some("https://staging.example/"), true), "https://staging.example");
    }

    #[test]
    fn windows_11_is_told_apart_from_windows_10_by_build_number() {
        assert_eq!(parse_windows_version("\r\nMicrosoft Windows [Version 10.0.22631.4460]\r\n").as_deref(), Some("11"));
        assert_eq!(parse_windows_version("Microsoft Windows [Version 10.0.26100.2314]").as_deref(), Some("11"));
        assert_eq!(parse_windows_version("Microsoft Windows [Version 10.0.19045.5131]").as_deref(), Some("10"));
        assert_eq!(parse_windows_version("Microsoft Windows [Version 6.3.9600]").as_deref(), Some("6"));
        // Non-English Windows locales translate "Version".
        assert_eq!(parse_windows_version("Microsoft Windows [version 10.0.22631.4460]").as_deref(), Some("11"));
        assert_eq!(parse_windows_version("Microsoft Windows [Versión 10.0.19045.5131]").as_deref(), Some("10"));
        assert_eq!(parse_windows_version("Microsoft Windows [版本 10.0.26100.2314]").as_deref(), Some("11"));
        assert_eq!(parse_windows_version("Microsoft Windows [Версия 10.0.22621.1]").as_deref(), Some("11"));
        assert_eq!(parse_windows_version("Microsoft Windows [Versione 10.0.19045.1]").as_deref(), Some("10"));
        assert_eq!(parse_windows_version("Microsoft Windows [versão 10.0.22631.1]").as_deref(), Some("11"));
        assert_eq!(parse_windows_version("nothing useful"), None);
    }

    #[test]
    fn os_release_yields_distribution_and_version_only() {
        let ubuntu = "PRETTY_NAME=\"Ubuntu 22.04.4 LTS\"\nNAME=\"Ubuntu\"\nVERSION_ID=\"22.04\"\nID=ubuntu\nID_LIKE=debian\n";
        assert_eq!(parse_os_release(ubuntu).as_deref(), Some("ubuntu-22.04"));
        // ID_LIKE must not be mistaken for ID.
        assert_eq!(parse_os_release("ID_LIKE=debian\nID=pop\nVERSION_ID='24.04'\n").as_deref(), Some("pop-24.04"));
        // Rolling release: no VERSION_ID.
        assert_eq!(parse_os_release("NAME=\"Arch Linux\"\nID=arch\n").as_deref(), Some("arch"));
        assert_eq!(parse_os_release("NAME=Something\n"), None);
        // Whatever the file says, only id-safe characters are kept.
        assert_eq!(parse_os_release("ID=\"my distro/../x\"\n").as_deref(), Some("mydistro..x"));
    }

    #[test]
    fn apple_silicon_is_reported_as_arm64() {
        assert_eq!(normalize_arch("aarch64"), "arm64");
        assert_eq!(normalize_arch("x86_64"), "x86_64");
    }
}
