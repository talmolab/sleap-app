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

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_shell::ShellExt;

const DEFAULT_BASE_URL: &str = "https://analytics.sleap.ai";

/// Overrides the service URL, for running against a local
/// talmolab/sleap-analytics-service (`uvicorn app.main:app`). Development only.
const BASE_URL_ENV: &str = "SLEAP_ANALYTICS_URL";

/// The only paths this command will post to.
const ALLOWED_PATHS: [&str; 2] = ["/v2/events", "/ping"];

/// The service rejects anything larger (`MAX_BODY_BYTES` in its `app/events.py`).
const MAX_BODY_BYTES: usize = 64 * 1024;

/// Generous for a request this small, short enough that a dead network never
/// leaves a request hanging for the life of the window.
const NETWORK_TIMEOUT: Duration = Duration::from_secs(15);

fn base_url() -> String {
    std::env::var(BASE_URL_ENV)
        .ok()
        .map(|value| value.trim().trim_end_matches('/').to_string())
        .filter(|value| value.starts_with("https://") || value.starts_with("http://"))
        .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
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
#[tauri::command]
pub async fn analytics_post(path: String, body: String) -> Result<u16, String> {
    let url = endpoint(&base_url(), &path)?;
    if body.len() > MAX_BODY_BYTES {
        return Err(format!("analytics body is {} bytes; the limit is {MAX_BODY_BYTES}", body.len()));
    }
    let client = reqwest::Client::builder()
        .user_agent("sleap-app")
        .timeout(NETWORK_TIMEOUT)
        .build()
        .map_err(|e| e.to_string())?;
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
/// `Microsoft Windows [Version 10.0.22631.4460]`.
///
/// Windows 11 still reports major version 10; the build number is the only
/// thing that tells them apart, and 22000 was the first Windows 11 build.
/// The build number itself is dropped: it changes with every monthly update
/// and adds nothing a support question needs.
fn parse_windows_version(ver_output: &str) -> Option<String> {
    let start = ver_output.find("Version ")? + "Version ".len();
    let version: String = ver_output[start..]
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let mut parts = version.split('.');
    let major: u32 = parts.next()?.parse().ok()?;
    let _minor = parts.next();
    let build: u32 = parts.next().and_then(|b| b.parse().ok()).unwrap_or(0);
    if major == 10 && build >= 22000 {
        Some("11".to_string())
    } else {
        Some(major.to_string())
    }
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
    fn windows_11_is_told_apart_from_windows_10_by_build_number() {
        assert_eq!(parse_windows_version("\r\nMicrosoft Windows [Version 10.0.22631.4460]\r\n").as_deref(), Some("11"));
        assert_eq!(parse_windows_version("Microsoft Windows [Version 10.0.26100.2314]").as_deref(), Some("11"));
        assert_eq!(parse_windows_version("Microsoft Windows [Version 10.0.19045.5131]").as_deref(), Some("10"));
        // Localized Windows translates the product name but keeps "Version".
        assert_eq!(parse_windows_version("Microsoft Windows [Version 6.3.9600]").as_deref(), Some("6"));
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
