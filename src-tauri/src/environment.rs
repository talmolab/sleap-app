//! Python environment detection and management commands.
//!
//! Detects `uv`, discovers Python interpreters, checks package availability,
//! and installs Python versions and tools via `uv`.
//!
//! All process spawning uses `tauri_plugin_shell::ShellExt` for consistent
//! cross-platform behavior and streaming support.

use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, Runtime};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/// Information about the `uv` installation.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UvInfo {
    pub available: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    pub python_dir: Option<String>,
}

/// A tool installed via `uv tool`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UvTool {
    pub name: String,
    pub version: Option<String>,
    pub commands: Vec<String>,
}

/// A Python interpreter discovered by `uv python list`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonInterpreter {
    /// Full key, e.g. "cpython-3.13.11-macos-aarch64-none"
    pub key: String,
    /// Python version, e.g. "3.13.11"
    pub version: String,
    /// Absolute path to the interpreter binary.
    pub path: Option<String>,
    /// "managed" (uv-installed) or "system"
    pub source: String,
}

/// Result of checking a specific Python interpreter.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PythonInfo {
    pub path: String,
    pub version: Option<String>,
    pub sleap_nn_version: Option<String>,
    pub sleap_version: Option<String>,
}

/// Events streamed during install operations.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event", content = "data")]
pub enum InstallEvent {
    Stdout { line: String },
    Stderr { line: String },
    Finished { success: bool, code: Option<i32> },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Run a command via the shell plugin and collect stdout.
async fn shell_output<R: Runtime>(
    app: &AppHandle<R>,
    program: &str,
    args: &[&str],
) -> Option<String> {
    let output = app
        .shell()
        .command(program)
        .args(args)
        .output()
        .await
        .ok()?;
    if output.status.success() {
        let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    } else {
        None
    }
}

/// Spawn a command and stream its stdout/stderr through a Channel.
async fn stream_command<R: Runtime>(
    app: &AppHandle<R>,
    program: &str,
    args: &[&str],
    on_event: &Channel<InstallEvent>,
) -> Result<bool, String> {
    let (mut rx, _child) = app
        .shell()
        .command(program)
        .args(args)
        .spawn()
        .map_err(|e| format!("Failed to spawn {}: {}", program, e))?;

    let mut success = false;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let line = String::from_utf8_lossy(&bytes).to_string();
                let _ = on_event.send(InstallEvent::Stdout { line });
            }
            CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes).to_string();
                let _ = on_event.send(InstallEvent::Stderr { line });
            }
            CommandEvent::Terminated(payload) => {
                success = payload.code == Some(0);
                let _ = on_event.send(InstallEvent::Finished {
                    success,
                    code: payload.code,
                });
            }
            _ => {}
        }
    }

    Ok(success)
}

// ---------------------------------------------------------------------------
// Detection commands
// ---------------------------------------------------------------------------

/// Detect whether `uv` is installed and get its version.
#[tauri::command]
pub async fn detect_uv<R: Runtime>(app: AppHandle<R>) -> UvInfo {
    // Try to get uv version
    let version_output = shell_output(&app, "uv", &["--version"]).await;
    if version_output.is_none() {
        return UvInfo {
            available: false,
            version: None,
            path: None,
            python_dir: None,
        };
    }

    let version = version_output.map(|v| {
        v.strip_prefix("uv ").unwrap_or(&v).to_string()
    });

    // Find uv path
    #[cfg(windows)]
    let which_cmd = "where";
    #[cfg(not(windows))]
    let which_cmd = "which";
    let path = shell_output(&app, which_cmd, &["uv"]).await.map(|s| {
        s.lines().next().unwrap_or(&s).to_string()
    });

    // Get managed Python directory
    let python_dir = shell_output(&app, "uv", &["python", "dir"]).await;

    UvInfo {
        available: true,
        version,
        path,
        python_dir,
    }
}

/// List tools installed via `uv tool`.
#[tauri::command]
pub async fn list_uv_tools<R: Runtime>(app: AppHandle<R>) -> Vec<UvTool> {
    match shell_output(&app, "uv", &["tool", "list"]).await {
        Some(output) => parse_uv_tool_list(&output),
        None => vec![],
    }
}

/// List installed Python interpreters via `uv python list --only-installed`.
#[tauri::command]
pub async fn list_python_interpreters<R: Runtime>(
    app: AppHandle<R>,
) -> Vec<PythonInterpreter> {
    let output = match shell_output(
        &app,
        "uv",
        &["python", "list", "--only-installed"],
    )
    .await
    {
        Some(s) => s,
        None => return vec![],
    };

    let mut interpreters = parse_uv_python_list(&output);
    // Filter to cpython only
    interpreters.retain(|i| i.key.starts_with("cpython-"));
    dedup_interpreters(&mut interpreters);
    interpreters
}

/// List Python versions available for download.
#[tauri::command]
pub async fn list_downloadable_pythons<R: Runtime>(
    app: AppHandle<R>,
) -> Vec<PythonInterpreter> {
    let output = match shell_output(&app, "uv", &["python", "list"]).await {
        Some(s) => s,
        None => return vec![],
    };

    let mut downloadable = extract_downloadable(&output);
    // Filter to cpython only
    downloadable.retain(|i| i.key.starts_with("cpython-"));
    downloadable
}

/// Check a specific Python interpreter for version and package availability.
#[tauri::command]
pub async fn check_python<R: Runtime>(
    app: AppHandle<R>,
    python_path: String,
) -> PythonInfo {
    let version = shell_output(&app, &python_path, &["--version"])
        .await
        .map(|v| v.strip_prefix("Python ").unwrap_or(&v).to_string());

    let sleap_nn_version = shell_output(
        &app,
        &python_path,
        &["-c", "import sleap_nn; print(sleap_nn.__version__)"],
    )
    .await;

    let sleap_version = shell_output(
        &app,
        &python_path,
        &["-c", "import sleap; print(sleap.__version__)"],
    )
    .await;

    PythonInfo {
        path: python_path,
        version,
        sleap_nn_version,
        sleap_version,
    }
}

// ---------------------------------------------------------------------------
// Install commands (streaming)
// ---------------------------------------------------------------------------

/// Install a Python version via `uv python install`.
#[tauri::command]
pub async fn install_python<R: Runtime>(
    app: AppHandle<R>,
    version: String,
    on_event: Channel<InstallEvent>,
) -> Result<(), String> {
    stream_command(&app, "uv", &["python", "install", &version], &on_event).await?;
    Ok(())
}

/// Install a uv tool (e.g., sleap-nn).
/// If `python_path` is provided, uses `--python <path>`.
/// If `force` is true, uses `--force` for reinstall.
#[tauri::command]
pub async fn install_uv_tool<R: Runtime>(
    app: AppHandle<R>,
    package: String,
    python_path: Option<String>,
    force: Option<bool>,
    on_event: Channel<InstallEvent>,
) -> Result<(), String> {
    let mut args = vec!["tool", "install"];
    args.push(&package);

    let python_flag;
    if let Some(ref path) = python_path {
        args.push("--python");
        python_flag = path.clone();
        args.push(&python_flag);
    }

    if force.unwrap_or(false) {
        args.push("--force");
    }

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_ref()).collect();
    stream_command(&app, "uv", &arg_refs, &on_event).await?;
    Ok(())
}

/// Upgrade a uv tool to latest version.
#[tauri::command]
pub async fn upgrade_uv_tool<R: Runtime>(
    app: AppHandle<R>,
    package: String,
    on_event: Channel<InstallEvent>,
) -> Result<(), String> {
    stream_command(&app, "uv", &["tool", "upgrade", &package], &on_event).await?;
    Ok(())
}

/// Update uv itself via `uv self update`.
#[tauri::command]
pub async fn update_uv<R: Runtime>(
    app: AppHandle<R>,
    on_event: Channel<InstallEvent>,
) -> Result<(), String> {
    stream_command(&app, "uv", &["self", "update"], &on_event).await?;
    Ok(())
}

/// Install uv via the official install script.
/// On Unix: `curl -LsSf https://astral.sh/uv/install.sh | sh`
/// On Windows: `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`
#[tauri::command]
pub async fn install_uv<R: Runtime>(
    app: AppHandle<R>,
    on_event: Channel<InstallEvent>,
) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        // Download and pipe to sh in one command via sh -c
        stream_command(
            &app,
            "sh",
            &["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"],
            &on_event,
        )
        .await?;
    }

    #[cfg(windows)]
    {
        stream_command(
            &app,
            "powershell",
            &[
                "-ExecutionPolicy",
                "ByPass",
                "-c",
                "irm https://astral.sh/uv/install.ps1 | iex",
            ],
            &on_event,
        )
        .await?;
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// Parsers (pure functions, testable)
// ---------------------------------------------------------------------------

/// Parse the output of `uv tool list`.
///
/// Format:
/// ```text
/// package-name v0.1.0
///     - command1
///     - command2
/// ```
fn parse_uv_tool_list(output: &str) -> Vec<UvTool> {
    let mut tools = Vec::new();
    let mut current: Option<UvTool> = None;

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        if trimmed.starts_with("- ") {
            if let Some(ref mut tool) = current {
                tool.commands.push(trimmed[2..].to_string());
            }
        } else {
            if let Some(tool) = current.take() {
                tools.push(tool);
            }

            let mut parts = trimmed.splitn(2, ' ');
            let name = parts.next().unwrap_or(trimmed).to_string();
            let version = parts.next().map(|v| {
                v.trim().strip_prefix('v').unwrap_or(v.trim()).to_string()
            });

            current = Some(UvTool {
                name,
                version,
                commands: Vec::new(),
            });
        }
    }

    if let Some(tool) = current {
        tools.push(tool);
    }

    tools
}

/// Parse the output of `uv python list [--only-installed]`.
///
/// Each line has a key and a path (or `<download available>`), separated by whitespace.
/// Paths may include symlink arrows: `/path/to/python3.13 -> /real/path/python3.13`
///
/// Example:
/// ```text
/// cpython-3.13.11-macos-aarch64-none    /Users/x/.local/bin/python3.13 -> /Users/x/.local/share/uv/python/.../bin/python3.13
/// cpython-3.13.11-macos-aarch64-none    /Users/x/.local/share/uv/python/.../bin/python3.13
/// cpython-3.9.6-macos-aarch64-none      /usr/bin/python3
/// ```
fn parse_uv_python_list(output: &str) -> Vec<PythonInterpreter> {
    let mut result = Vec::new();

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Split on 2+ whitespace to separate key from path
        let parts: Vec<&str> = trimmed.splitn(2, |c: char| c.is_whitespace())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect();

        if parts.len() < 2 {
            continue;
        }

        let key = parts[0].to_string();
        let path_part = parts[1];

        // Skip download-only entries
        if path_part.contains("<download available>") {
            continue;
        }

        // Handle symlink arrows: take the first part (the actual accessible path)
        let path = if let Some(idx) = path_part.find(" -> ") {
            path_part[..idx].trim().to_string()
        } else {
            path_part.trim().to_string()
        };

        // Extract version from key: "cpython-3.13.11-macos-aarch64-none" -> "3.13.11"
        let version = extract_version_from_key(&key);

        // Determine source: managed if path contains a uv python directory
        let source = if path.contains("/uv/python/") || path.contains("\\uv\\python\\") {
            "managed"
        } else {
            "system"
        };

        result.push(PythonInterpreter {
            key,
            version,
            path: Some(path),
            source: source.to_string(),
        });
    }

    result
}

/// Extract version string from a uv python key.
/// "cpython-3.13.11-macos-aarch64-none" -> "3.13.11"
/// "cpython-3.13.11+freethreaded-macos-aarch64-none" -> "3.13.11"
fn extract_version_from_key(key: &str) -> String {
    // Skip the implementation prefix (e.g., "cpython-")
    let after_impl = key.splitn(2, '-').nth(1).unwrap_or(key);
    // Take version part (digits and dots, possibly followed by +variant)
    let version: String = after_impl
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    if version.is_empty() {
        key.to_string()
    } else {
        version
    }
}

/// Deduplicate interpreters: keep the last entry for each key.
/// Since `uv python list` shows symlinks first and canonical paths second,
/// keeping the last gives us the canonical (non-symlink) path.
fn dedup_interpreters(interpreters: &mut Vec<PythonInterpreter>) {
    let mut seen = std::collections::HashMap::new();
    // Walk forward, recording latest index for each key
    for (i, interp) in interpreters.iter().enumerate() {
        seen.insert(interp.key.clone(), i);
    }
    let mut keep: Vec<usize> = seen.into_values().collect();
    keep.sort();
    let kept: Vec<PythonInterpreter> = keep.into_iter().map(|i| interpreters[i].clone()).collect();
    *interpreters = kept;
}

/// Extract downloadable Python versions from `uv python list` output.
/// Returns one entry per minor version (e.g., "3.14", "3.13"), using
/// the latest patch version available.
fn extract_downloadable(output: &str) -> Vec<PythonInterpreter> {
    let mut result = Vec::new();
    let mut seen_minors = std::collections::HashSet::new();

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || !trimmed.contains("<download available>") {
            continue;
        }

        // Skip freethreaded variants
        if trimmed.contains("+freethreaded") {
            continue;
        }

        let key = trimmed
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_string();
        if key.is_empty() {
            continue;
        }

        let version = extract_version_from_key(&key);

        // Deduplicate to one per implementation + minor version (e.g., "cpython-3.14")
        let impl_name = key.splitn(2, '-').next().unwrap_or("");
        let minor: String = version
            .splitn(3, '.')
            .take(2)
            .collect::<Vec<_>>()
            .join(".");
        let dedup_key = format!("{}-{}", impl_name, minor);
        if seen_minors.contains(&dedup_key) {
            continue;
        }
        seen_minors.insert(dedup_key);

        result.push(PythonInterpreter {
            key,
            version,
            path: None,
            source: "download".to_string(),
        });
    }

    result
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -- uv tool list parser tests --

    #[test]
    fn test_parse_uv_tool_list_empty() {
        assert!(parse_uv_tool_list("").is_empty());
    }

    #[test]
    fn test_parse_uv_tool_list_single() {
        let output = "sleap-nn v0.1.1\n    - sleap-nn\n";
        let tools = parse_uv_tool_list(output);
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0].name, "sleap-nn");
        assert_eq!(tools[0].version, Some("0.1.1".to_string()));
        assert_eq!(tools[0].commands, vec!["sleap-nn"]);
    }

    #[test]
    fn test_parse_uv_tool_list_multiple() {
        let output = "\
sleap-nn v0.1.1
    - sleap-nn
ruff v0.5.0
    - ruff
";
        let tools = parse_uv_tool_list(output);
        assert_eq!(tools.len(), 2);
        assert_eq!(tools[0].name, "sleap-nn");
        assert_eq!(tools[1].name, "ruff");
        assert_eq!(tools[1].version, Some("0.5.0".to_string()));
    }

    #[test]
    fn test_parse_uv_tool_list_multiple_commands() {
        let output = "\
sleap v0.2.0
    - sleap
    - sleap-train
    - sleap-track
";
        let tools = parse_uv_tool_list(output);
        assert_eq!(tools.len(), 1);
        assert_eq!(
            tools[0].commands,
            vec!["sleap", "sleap-train", "sleap-track"]
        );
    }

    // -- uv python list parser tests --

    #[test]
    fn test_parse_uv_python_list_empty() {
        assert!(parse_uv_python_list("").is_empty());
    }

    #[test]
    fn test_parse_uv_python_list_installed() {
        let output = "\
cpython-3.13.11-macos-aarch64-none       /Users/x/.local/share/uv/python/cpython-3.13.11-macos-aarch64-none/bin/python3.13
cpython-3.12.11-macos-aarch64-none       /Users/x/.local/share/uv/python/cpython-3.12.11-macos-aarch64-none/bin/python3.12
cpython-3.9.6-macos-aarch64-none         /usr/bin/python3
";
        let interps = parse_uv_python_list(output);
        assert_eq!(interps.len(), 3);
        assert_eq!(interps[0].version, "3.13.11");
        assert_eq!(interps[0].source, "managed");
        assert_eq!(interps[2].version, "3.9.6");
        assert_eq!(interps[2].source, "system");
        assert_eq!(interps[2].path, Some("/usr/bin/python3".to_string()));
    }

    #[test]
    fn test_parse_uv_python_list_with_symlinks() {
        let output = "\
cpython-3.13.11-macos-aarch64-none       /Users/x/.local/bin/python3.13 -> /Users/x/.local/share/uv/python/cpython-3.13.11-macos-aarch64-none/bin/python3.13
cpython-3.13.11-macos-aarch64-none       /Users/x/.local/share/uv/python/cpython-3.13.11-macos-aarch64-none/bin/python3.13
";
        let interps = parse_uv_python_list(output);
        assert_eq!(interps.len(), 2);
        // First entry is the symlink path (before ->)
        assert_eq!(
            interps[0].path,
            Some("/Users/x/.local/bin/python3.13".to_string())
        );
        // Second entry is the canonical path
        assert_eq!(
            interps[1].path,
            Some("/Users/x/.local/share/uv/python/cpython-3.13.11-macos-aarch64-none/bin/python3.13".to_string())
        );
    }

    #[test]
    fn test_dedup_interpreters() {
        let output = "\
cpython-3.13.11-macos-aarch64-none       /Users/x/.local/bin/python3.13 -> /Users/x/.local/share/uv/python/.../bin/python3.13
cpython-3.13.11-macos-aarch64-none       /Users/x/.local/share/uv/python/.../bin/python3.13
cpython-3.12.11-macos-aarch64-none       /Users/x/.local/share/uv/python/.../bin/python3.12
";
        let mut interps = parse_uv_python_list(output);
        dedup_interpreters(&mut interps);
        assert_eq!(interps.len(), 2);
        // Should keep the canonical (last) path for 3.13.11
        assert!(interps[0]
            .path
            .as_ref()
            .unwrap()
            .contains("/uv/python/"));
    }

    #[test]
    fn test_parse_uv_python_list_skips_download_available() {
        let output = "\
cpython-3.14.2-macos-aarch64-none        <download available>
cpython-3.13.11-macos-aarch64-none       /Users/x/.local/share/uv/python/.../bin/python3.13
";
        let interps = parse_uv_python_list(output);
        assert_eq!(interps.len(), 1);
        assert_eq!(interps[0].version, "3.13.11");
    }

    #[test]
    fn test_extract_version_from_key() {
        assert_eq!(
            extract_version_from_key("cpython-3.13.11-macos-aarch64-none"),
            "3.13.11"
        );
        assert_eq!(
            extract_version_from_key("cpython-3.14.2+freethreaded-macos-aarch64-none"),
            "3.14.2"
        );
        assert_eq!(extract_version_from_key("cpython"), "cpython");
    }

    #[test]
    fn test_extract_downloadable() {
        let output = "\
cpython-3.15.0a5-macos-aarch64-none                 <download available>
cpython-3.15.0a5+freethreaded-macos-aarch64-none    <download available>
cpython-3.14.2-macos-aarch64-none                   <download available>
cpython-3.14.2+freethreaded-macos-aarch64-none      <download available>
cpython-3.13.11-macos-aarch64-none                  /Users/x/.local/share/uv/python/.../bin/python3.13
cpython-3.12.12-macos-aarch64-none                  <download available>
cpython-3.12.11-macos-aarch64-none                  /Users/x/.local/share/uv/python/.../bin/python3.12
cpython-3.11.14-macos-aarch64-none                  <download available>
pyodide-3.12.7-emscripten-wasm32-musl               <download available>
";
        let mut dl = extract_downloadable(output);
        // Filter cpython like the command does
        dl.retain(|i| i.key.starts_with("cpython-"));
        // Should get: 3.15, 3.14, 3.12, 3.11 (one per minor, no freethreaded, no pyodide)
        assert_eq!(dl.len(), 4);
        assert_eq!(dl[0].version, "3.15.0");
        assert_eq!(dl[1].version, "3.14.2");
        assert_eq!(dl[2].version, "3.12.12");
        assert_eq!(dl[3].version, "3.11.14");
        assert!(dl.iter().all(|d| d.path.is_none()));
        assert!(dl.iter().all(|d| d.source == "download"));
    }

    #[test]
    fn test_extract_downloadable_filters_pyodide() {
        let output = "\
pyodide-3.12.7-emscripten-wasm32-musl    <download available>
cpython-3.12.12-macos-aarch64-none       <download available>
";
        let mut dl = extract_downloadable(output);
        dl.retain(|i| i.key.starts_with("cpython-"));
        assert_eq!(dl.len(), 1);
        assert_eq!(dl[0].version, "3.12.12");
    }
}
