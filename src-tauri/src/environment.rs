//! Python environment detection and management commands.
//!
//! Detects `uv`, discovers Python interpreters, checks package availability,
//! and installs Python versions and tools via `uv`.
//!
//! All process spawning uses `tauri_plugin_shell::ShellExt` for consistent
//! cross-platform behavior and streaming support.

use crate::RunningProcess;
use serde::Serialize;
use std::path::{Path, PathBuf};
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
}

/// Events streamed during process operations.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "event", content = "data")]
pub enum ProcessEvent {
    Stdout { line: String },
    Stderr { line: String },
    Finished { success: bool, code: Option<i32> },
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// --- PATH / uv resolution ---------------------------------------------------
//
// The INSTALLED desktop app is launched by the OS GUI layer (macOS
// LaunchServices, Linux desktop session) — NOT a login shell — so it inherits a
// MINIMAL PATH (on macOS just /etc/paths: /usr/local/bin:/usr/bin:/bin:...) that
// EXCLUDES ~/.local/bin, where the astral installer puts `uv` and the uv-tool
// shims (`sleap-nn`, `sleap-rtc`). Under `tauri dev` the app inherits the
// launching terminal's rich PATH, so bare-name spawns happen to work — which is
// why this only reproduces in the installed app. Fix: (1) resolve `uv` to an
// ABSOLUTE path (which-first, then a documented probe order), and (2) augment
// every child's PATH with the well-known tool bin dirs so the shims + the
// `curl | sh` installer resolve too.

/// The uv executable filename for the current platform.
#[cfg(windows)]
const UV_EXE: &str = "uv.exe";
#[cfg(not(windows))]
const UV_EXE: &str = "uv";

/// Well-known directories that hold `uv` / uv-tool shims, in PREFERENCE ORDER.
/// cfg-gated so names + separators are always correct per-platform (built with
/// `PathBuf::join`, never a manual slash swap).
///
/// Order: `~/.local/bin` first — the astral installer default AND where our own
/// Environment-tab install button puts uv — then cargo, then Homebrew/system.
fn tool_bin_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join(".local").join("bin")); // astral default + uv-tool shims
        dirs.push(home.join(".cargo").join("bin")); // `cargo install uv`
    }
    #[cfg(target_os = "macos")]
    {
        dirs.push(PathBuf::from("/opt/homebrew/bin")); // Homebrew (Apple Silicon)
        dirs.push(PathBuf::from("/usr/local/bin")); // Homebrew (Intel) / manual
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        dirs.push(PathBuf::from("/usr/local/bin")); // manual / distro
        dirs.push(PathBuf::from("/home/linuxbrew/.linuxbrew/bin")); // Linuxbrew
    }
    dirs
}

/// A PATH with the well-known tool bin dirs PREPENDED to the inherited PATH.
/// Prepend so our known-good uv/shims win; keep the rest so system tools
/// (curl, sh, python) still resolve.
fn augmented_path() -> std::ffi::OsString {
    let mut paths = tool_bin_dirs();
    if let Some(existing) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&existing));
    }
    std::env::join_paths(&paths).unwrap_or_else(|_| std::env::var_os("PATH").unwrap_or_default())
}

/// Parent env minus the AppImage-injected PYTHONHOME/PYTHONPATH, with PATH
/// overridden to the augmented tool PATH. The Linux AppImage AppRun exports
/// those two ($APPDIR-based), which a spawned venv python would otherwise
/// inherit and die on (`ModuleNotFoundError: No module named 'encodings'`).
/// No-op on macOS/Windows, where neither is set.
fn child_env() -> Vec<(std::ffi::OsString, std::ffi::OsString)> {
    use std::ffi::OsStr;
    let mut env: Vec<_> = std::env::vars_os()
        .filter(|(k, _)| k != OsStr::new("PYTHONHOME") && k != OsStr::new("PYTHONPATH"))
        .collect();
    env.push(("PATH".into(), augmented_path()));
    env
}

/// Resolve `uv` to an absolute path.
/// 1. `which`/`where` FIRST — honors the PATH the user's own shell resolves
///    against (dev / terminal launch). In the installed app the minimal PATH
///    finds nothing here, so we fall through to probing.
/// 2. Probe the known install dirs in preference order.
/// 3. Fall back to bare `"uv"` (unchanged legacy behavior; errors as before if
///    genuinely absent).
async fn resolve_uv<R: Runtime>(app: &AppHandle<R>) -> String {
    #[cfg(windows)]
    let which_cmd = "where";
    #[cfg(not(windows))]
    let which_cmd = "which";
    // RAW (un-augmented) env here so "which-first" reflects the user's OWN PATH,
    // not our prepended dirs.
    if let Some(out) = shell_output_raw(app, which_cmd, &["uv"]).await {
        if let Some(line) = out.lines().next() {
            let p = PathBuf::from(line.trim());
            if p.is_file() {
                return p.to_string_lossy().into_owned();
            }
        }
    }
    for dir in tool_bin_dirs() {
        let candidate = dir.join(UV_EXE);
        if candidate.is_file() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    "uv".to_string()
}

/// Run a command with the process's INHERITED environment (no PATH tweaks) and
/// collect stdout. Used only for the `which`/`where` probe in `resolve_uv`.
async fn shell_output_raw<R: Runtime>(
    app: &AppHandle<R>,
    program: &str,
    args: &[&str],
) -> Option<String> {
    let output = app.shell().command(program).args(args).output().await.ok()?;
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

/// Run a command with an AUGMENTED PATH (adds the well-known tool bin dirs) and
/// collect stdout. Used for all uv / tool invocations.
async fn shell_output<R: Runtime>(
    app: &AppHandle<R>,
    program: &str,
    args: &[&str],
) -> Option<String> {
    let output = app
        .shell()
        .command(program)
        .args(args)
        .env_clear()
        .envs(child_env())
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
    on_event: &Channel<ProcessEvent>,
) -> Result<bool, String> {
    let (mut rx, _child) = app
        .shell()
        .command(program)
        .args(args)
        .env_clear()
        .envs(child_env())
        .spawn()
        .map_err(|e| format!("Failed to spawn {}: {}", program, e))?;

    let mut success = false;

    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(bytes) => {
                let line = String::from_utf8_lossy(&bytes).to_string();
                let _ = on_event.send(ProcessEvent::Stdout { line });
            }
            CommandEvent::Stderr(bytes) => {
                let line = String::from_utf8_lossy(&bytes).to_string();
                let _ = on_event.send(ProcessEvent::Stderr { line });
            }
            CommandEvent::Terminated(payload) => {
                success = payload.code == Some(0);
                let _ = on_event.send(ProcessEvent::Finished {
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
    // Resolve uv to an absolute path first — the installed app's minimal PATH
    // won't find a bare `uv` (see resolve_uv).
    let uv = resolve_uv(&app).await;

    // Try to get uv version
    let version_output = shell_output(&app, &uv, &["--version"]).await;
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

    // Report the resolved absolute path (None only if we fell back to bare "uv").
    let path = if uv == "uv" { None } else { Some(uv.clone()) };

    // Get managed Python directory
    let python_dir = shell_output(&app, &uv, &["python", "dir"]).await;

    UvInfo {
        available: true,
        version,
        path,
        python_dir,
    }
}

/// Detect GPU availability for torch backend selection.
/// Returns "cuda" if nvidia-smi is found, "mps" on Apple Silicon macOS, else "cpu".
#[tauri::command]
pub async fn detect_gpu<R: Runtime>(app: AppHandle<R>) -> String {
    // Check for NVIDIA GPU via nvidia-smi
    if let Some(output) = shell_output(&app, "nvidia-smi", &["--query-gpu=name", "--format=csv,noheader"]).await {
        if !output.trim().is_empty() {
            return "cuda".to_string();
        }
    }

    // Check for Apple Silicon (MPS)
    #[cfg(target_os = "macos")]
    {
        // Apple Silicon Macs always support MPS via Metal
        if std::env::consts::ARCH == "aarch64" {
            return "mps".to_string();
        }
    }

    "cpu".to_string()
}

/// Point-in-time GPU stats for diagnostics. NVIDIA-only for the numeric fields
/// (via `nvidia-smi`); on mps/cpu only `backend`/`name` are populated. This is a
/// snapshot at call time, not a peak-during-training measurement.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuStats {
    pub backend: String,
    pub name: Option<String>,
    pub memory_total_mb: Option<u64>,
    pub memory_used_mb: Option<u64>,
    pub utilization_pct: Option<u32>,
}

/// Query current GPU stats. Returns NVIDIA util/VRAM via `nvidia-smi` when
/// present, else identifies the mps/cpu backend with no numeric fields.
#[tauri::command]
pub async fn gpu_stats<R: Runtime>(app: AppHandle<R>) -> GpuStats {
    if let Some(output) = shell_output(
        &app,
        "nvidia-smi",
        &[
            "--query-gpu=name,memory.total,memory.used,utilization.gpu",
            "--format=csv,noheader,nounits",
        ],
    )
    .await
    {
        let line = output.lines().next().unwrap_or("").trim().to_string();
        if !line.is_empty() {
            let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
            return GpuStats {
                backend: "cuda".to_string(),
                name: parts
                    .first()
                    .map(|s| s.to_string())
                    .filter(|s| !s.is_empty()),
                memory_total_mb: parts.get(1).and_then(|s| s.parse::<u64>().ok()),
                memory_used_mb: parts.get(2).and_then(|s| s.parse::<u64>().ok()),
                utilization_pct: parts.get(3).and_then(|s| s.parse::<u32>().ok()),
            };
        }
    }

    #[cfg(target_os = "macos")]
    {
        if std::env::consts::ARCH == "aarch64" {
            return GpuStats {
                backend: "mps".to_string(),
                name: Some("Apple Silicon (Metal)".to_string()),
                memory_total_mb: None,
                memory_used_mb: None,
                utilization_pct: None,
            };
        }
    }

    GpuStats {
        backend: "cpu".to_string(),
        name: None,
        memory_total_mb: None,
        memory_used_mb: None,
        utilization_pct: None,
    }
}

/// List tools installed via `uv tool`.
#[tauri::command]
pub async fn list_uv_tools<R: Runtime>(app: AppHandle<R>) -> Vec<UvTool> {
    let uv = resolve_uv(&app).await;
    match shell_output(&app, &uv, &["tool", "list"]).await {
        Some(output) => parse_uv_tool_list(&output),
        None => vec![],
    }
}

/// List installed Python interpreters via `uv python list --only-installed`.
#[tauri::command]
pub async fn list_python_interpreters<R: Runtime>(
    app: AppHandle<R>,
) -> Vec<PythonInterpreter> {
    let uv = resolve_uv(&app).await;
    let output = match shell_output(
        &app,
        &uv,
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
    let uv = resolve_uv(&app).await;
    let output = match shell_output(&app, &uv, &["python", "list"]).await {
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

    PythonInfo {
        path: python_path,
        version,
        sleap_nn_version,
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
    on_event: Channel<ProcessEvent>,
) -> Result<(), String> {
    let uv = resolve_uv(&app).await;
    stream_command(&app, &uv, &["python", "install", &version], &on_event).await?;
    Ok(())
}

/// Install a uv tool (e.g., sleap-nn).
/// If `python_path` is provided, uses `--python <path>`.
/// If `force` is true, uses `--force` for reinstall.
/// `extra_args` allows passing additional flags like `--torch-backend=auto`.
#[tauri::command]
pub async fn install_uv_tool<R: Runtime>(
    app: AppHandle<R>,
    package: String,
    python_path: Option<String>,
    force: Option<bool>,
    extra_args: Option<Vec<String>>,
    on_event: Channel<ProcessEvent>,
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

    // Collect extra_args so we can borrow them
    let extras = extra_args.unwrap_or_default();
    for arg in &extras {
        args.push(arg);
    }

    let arg_refs: Vec<&str> = args.iter().map(|s| s.as_ref()).collect();
    let uv = resolve_uv(&app).await;
    stream_command(&app, &uv, &arg_refs, &on_event).await?;
    Ok(())
}

/// Upgrade a uv tool to latest version.
#[tauri::command]
pub async fn upgrade_uv_tool<R: Runtime>(
    app: AppHandle<R>,
    package: String,
    on_event: Channel<ProcessEvent>,
) -> Result<(), String> {
    let uv = resolve_uv(&app).await;
    stream_command(&app, &uv, &["tool", "upgrade", &package], &on_event).await?;
    Ok(())
}

/// Update uv itself via `uv self update`.
#[tauri::command]
pub async fn update_uv<R: Runtime>(
    app: AppHandle<R>,
    on_event: Channel<ProcessEvent>,
) -> Result<(), String> {
    let uv = resolve_uv(&app).await;
    stream_command(&app, &uv, &["self", "update"], &on_event).await?;
    Ok(())
}

/// Install uv via the official install script.
/// On Unix: `curl -LsSf https://astral.sh/uv/install.sh | sh`
/// On Windows: `powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"`
#[tauri::command]
pub async fn install_uv<R: Runtime>(
    app: AppHandle<R>,
    on_event: Channel<ProcessEvent>,
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
// Process management commands
// ---------------------------------------------------------------------------

/// Spawn an arbitrary program with args, streaming output and retaining the
/// child handle so it can be cancelled via `cancel_command`.
#[tauri::command]
pub async fn run_python_command<R: Runtime>(
    app: AppHandle<R>,
    running: tauri::State<'_, RunningProcess>,
    program: String,
    args: Vec<String>,
    on_event: Channel<ProcessEvent>,
) -> Result<bool, String> {
    let (mut rx, child) = app
        .shell()
        .command(&program)
        .args(&args)
        .env_clear()
        .envs(child_env())
        .spawn()
        .map_err(|e| format!("Failed to spawn {}: {}", program, e))?;

    // Store child handle for cancellation
    {
        let mut guard = running.0.lock().map_err(|e| e.to_string())?;
        *guard = Some(child);
    }

    let mut success = false;
    while let Some(event) = rx.recv().await {
        match event {
            tauri_plugin_shell::process::CommandEvent::Stdout(line) => {
                let line = String::from_utf8_lossy(&line).to_string();
                let _ = on_event.send(ProcessEvent::Stdout { line });
            }
            tauri_plugin_shell::process::CommandEvent::Stderr(line) => {
                let line = String::from_utf8_lossy(&line).to_string();
                let _ = on_event.send(ProcessEvent::Stderr { line });
            }
            tauri_plugin_shell::process::CommandEvent::Terminated(payload) => {
                success = payload.code == Some(0);
                let _ = on_event.send(ProcessEvent::Finished {
                    success,
                    code: payload.code,
                });
                break;
            }
            _ => {}
        }
    }

    // Clear stored handle
    {
        let mut guard = running.0.lock().map_err(|e| e.to_string())?;
        *guard = None;
    }

    Ok(success)
}

/// Kill the currently running process spawned by `run_python_command`, if any.
#[tauri::command]
pub async fn cancel_command(
    running: tauri::State<'_, RunningProcess>,
) -> Result<(), String> {
    let mut guard = running.0.lock().map_err(|e| e.to_string())?;
    if let Some(child) = guard.take() {
        child.kill().map_err(|e| format!("Failed to kill process: {}", e))?;
    }
    Ok(())
}

/// Build the path to the Python interpreter inside a uv tool's virtual env.
///
/// uv installs each tool into `<uv tool dir>/<tool>/` with the interpreter at
/// `bin/python3` (Unix) or `Scripts\python.exe` (Windows). Pure + testable.
fn sleap_nn_python_path(tool_dir: &Path) -> PathBuf {
    let base = tool_dir.join("sleap-nn");
    #[cfg(windows)]
    {
        base.join("Scripts").join("python.exe")
    }
    #[cfg(not(windows))]
    {
        base.join("bin").join("python3")
    }
}

/// Resolve the Python interpreter inside sleap-nn's uv-tool virtual environment.
///
/// The ZMQ relay sidecars `import zmq` (pyzmq), which is a declared dependency of
/// sleap-nn and lives in its venv, NOT in the system `python3`. Running the relay
/// with this interpreter mirrors how the `sleap-nn` command itself runs (its uv
/// shim is shebang-pinned to this same interpreter), so the relay shares the exact
/// pyzmq the trainer publishes with. Errors clearly rather than silently falling
/// back to a base `python3` that lacks pyzmq.
async fn resolve_sleap_nn_python<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let uv = resolve_uv(app).await;
    let tool_dir = shell_output(app, &uv, &["tool", "dir"])
        .await
        .ok_or_else(|| "Could not determine uv tool directory (is uv installed?)".to_string())?;
    let python = sleap_nn_python_path(Path::new(tool_dir.trim()));
    if python.exists() {
        Ok(python)
    } else {
        Err(format!(
            "sleap-nn environment not found at {} — install sleap-nn before training.",
            python.display()
        ))
    }
}

// ---------------------------------------------------------------------------
// NWB export (Labels/.slp -> .nwb via sleap-io in the sleap-nn venv)
// ---------------------------------------------------------------------------

/// One-liner that converts a `.slp` to NWB using sleap-io: reads `argv[1]` (the
/// slp), writes `argv[2]` (the nwb). `save_file` infers NWB from the `.nwb`
/// extension. Run by the sleap-nn venv Python (which carries sleap-io + pynwb +
/// ndx-pose).
const NWB_EXPORT_SCRIPT: &str =
    "import sys, sleap_io as sio; sio.save_file(sio.load_file(sys.argv[1]), sys.argv[2])";

/// Build the error message for a failed export from the child's exit code and
/// captured stderr. Empty stderr → a generic exit-code message; otherwise the
/// LAST non-empty stderr line (pynwb/hdmf tracebacks are long — the final line
/// holds the actual error, e.g. the image-sequence `starting_frame` RuntimeError).
/// Pure + testable.
fn nwb_export_error(code: Option<i32>, stderr: &str) -> String {
    let trimmed = stderr.trim();
    if trimmed.is_empty() {
        return format!("NWB export failed (exit code {code:?})");
    }
    trimmed
        .lines()
        .rev()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or(trimmed)
        .to_string()
}

/// Run the sleap-io conversion with the given venv Python, capturing stderr.
async fn run_nwb_export<R: Runtime>(
    app: &AppHandle<R>,
    python: &Path,
    slp_path: &str,
    nwb_path: &str,
) -> Result<(), String> {
    let (mut rx, _child) = app
        .shell()
        .command(python.to_string_lossy().to_string())
        .args(["-c", NWB_EXPORT_SCRIPT, slp_path, nwb_path])
        .env_clear()
        .envs(child_env())
        .spawn()
        .map_err(|e| format!("Failed to spawn Python: {e}"))?;

    let mut stderr = String::new();
    let mut code: Option<i32> = None;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stderr(line) => {
                stderr.push_str(&String::from_utf8_lossy(&line));
            }
            CommandEvent::Terminated(payload) => {
                code = payload.code;
                break;
            }
            _ => {}
        }
    }

    if code == Some(0) {
        Ok(())
    } else {
        Err(nwb_export_error(code, &stderr))
    }
}

/// Export a SLEAP `.slp` file (on disk) to NWB (ndx-pose) by running sleap-io in
/// the sleap-nn uv-tool venv — the same interpreter that runs training/inference,
/// which already carries pynwb + ndx-pose. `slp_path` is a caller-created temp
/// handoff file and is removed afterward (on every path). Desktop only. Returns
/// `Err("SLEAP_NN_NOT_INSTALLED")` when the sleap-nn env is missing so the UI can
/// prompt to install it; other failures return the trailing Python error line.
#[tauri::command]
pub async fn export_nwb<R: Runtime>(
    app: AppHandle<R>,
    slp_path: String,
    nwb_path: String,
) -> Result<(), String> {
    let python = match resolve_sleap_nn_python(&app).await {
        Ok(p) => p,
        Err(_) => {
            let _ = std::fs::remove_file(&slp_path);
            return Err("SLEAP_NN_NOT_INSTALLED".to_string());
        }
    };
    let result = run_nwb_export(&app, &python, &slp_path, &nwb_path).await;
    // Best-effort cleanup of the temp handoff .slp (created by the caller).
    let _ = std::fs::remove_file(&slp_path);
    result
}

/// Start a ZMQ PUB relay using std::process::Command for reliable pipe control.
/// Binds on port 9000 (matching PyQt SLEAP GUI default).
/// Kills any stale process on the port before binding.
///
/// Runs the sidecar with sleap-nn's venv Python (which has pyzmq), resolved via
/// `uv tool dir`, instead of the system `python3` (which lacks pyzmq). See #121.
#[tauri::command]
pub async fn start_zmq_relay<R: Runtime>(
    app: AppHandle<R>,
    relay: tauri::State<'_, crate::ZmqRelay>,
) -> Result<(), String> {
    // Kill any existing relay we own
    {
        let mut guard = relay.0.lock().map_err(|e| e.to_string())?;
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    // Resolve sleap-nn's venv Python (which has pyzmq) before spawning the
    // sidecar; the system `python3` lacks pyzmq. See #121.
    let python = resolve_sleap_nn_python(&app).await?;

    let port: u16 = 9000;

    let script = format!(
        "import zmq, sys\n\
         c = zmq.Context()\n\
         s = c.socket(zmq.PUB)\n\
         s.bind('tcp://127.0.0.1:{}')\n\
         sys.stdout.write('ready\\n')\n\
         sys.stdout.flush()\n\
         for line in sys.stdin:\n\
         \tline = line.strip()\n\
         \tif line:\n\
         \t\ts.send_string(line)\n\
         s.close()\n\
         c.term()\n",
        port
    );

    // Kill any stale process holding the port (from crashed previous runs)
    #[cfg(unix)]
    {
        use std::process::Command as StdCommand;
        if let Ok(output) = StdCommand::new("lsof")
            .args(["-ti", &format!(":{}", port)])
            .output()
        {
            let pids = String::from_utf8_lossy(&output.stdout);
            for pid_str in pids.split_whitespace() {
                if let Ok(pid) = pid_str.parse::<i32>() {
                    log::info!("[zmq-relay] Killing stale process on port {}: pid={}", port, pid);
                    unsafe { libc::kill(pid, libc::SIGKILL); }
                }
            }
            // Brief wait for OS to release the port
            if !pids.trim().is_empty() {
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        }
    }

    log::info!("[zmq-relay] Starting on port {}...", port);
    let mut child = std::process::Command::new(&python)
        .args(["-u", "-c", &script])
        .env_clear()
        .envs(child_env())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn ZMQ relay: {}", e))?;

    let pid = child.id();

    // Wait for "ready" to confirm the relay bound successfully
    if let Some(ref mut stdout) = child.stdout {
        use std::io::BufRead;
        let mut reader = std::io::BufReader::new(stdout);
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(n) if n > 0 && line.trim() == "ready" => {
                log::info!("[zmq-relay] Ready on port {} (pid={})", port, pid);
            }
            Ok(_) => {
                let stderr_msg = child.stderr.as_mut().map(|se| {
                    let mut buf = String::new();
                    use std::io::Read;
                    let _ = se.read_to_string(&mut buf);
                    buf
                }).unwrap_or_default();
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("ZMQ relay failed: {}", stderr_msg.trim()));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Failed to read from ZMQ relay: {}", e));
            }
        }
    }

    // Detach stdout/stderr so pipes don't block
    child.stdout.take();
    child.stderr.take();

    let mut guard = relay.0.lock().map_err(|e| e.to_string())?;
    *guard = Some(child);
    Ok(())
}

/// Send a stop command to sleap-nn via the ZMQ relay's stdin.
#[tauri::command]
pub async fn send_training_stop(
    relay: tauri::State<'_, crate::ZmqRelay>,
) -> Result<(), String> {
    let mut guard = relay.0.lock().map_err(|e| e.to_string())?;
    if let Some(ref mut child) = *guard {
        if let Some(ref mut stdin) = child.stdin {
            use std::io::Write;
            stdin.write_all(b"{\"command\":\"stop\"}\n")
                .map_err(|e| format!("Failed to write to relay stdin: {}", e))?;
            stdin.flush()
                .map_err(|e| format!("Failed to flush relay stdin: {}", e))?;
            log::info!("[zmq-relay] Sent stop command");
            Ok(())
        } else {
            Err("ZMQ relay stdin not available".into())
        }
    } else {
        Err("No ZMQ relay running".into())
    }
}

/// Kill the ZMQ relay process.
#[tauri::command]
pub async fn stop_zmq_relay(
    relay: tauri::State<'_, crate::ZmqRelay>,
) -> Result<(), String> {
    let mut guard = relay.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
        log::info!("[zmq-relay] Stopped");
    }
    Ok(())
}

/// Start a ZMQ SUB relay that BINDS port 9001 and forwards every training-progress
/// message published by sleap-nn (ProgressReporterZMQ) to the frontend as a
/// "training-progress" Tauri event. sleap-nn's PUB CONNECTs to 9001, so the SUB binds.
/// Mirrors start_zmq_relay but subscribes instead of publishes.
#[tauri::command]
pub async fn start_progress_relay<R: Runtime>(
    app: tauri::AppHandle<R>,
    relay: tauri::State<'_, crate::ProgressRelay>,
) -> Result<(), String> {
    // Kill any existing relay we own
    {
        let mut guard = relay.0.lock().map_err(|e| e.to_string())?;
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    // Resolve sleap-nn's venv Python (which has pyzmq) before spawning the
    // sidecar; the system `python3` lacks pyzmq. See #121.
    let python = resolve_sleap_nn_python(&app).await?;

    let port: u16 = 9001;

    let script = format!(
        "import zmq, sys\n\
         c = zmq.Context()\n\
         s = c.socket(zmq.SUB)\n\
         s.bind('tcp://127.0.0.1:{}')\n\
         s.setsockopt_string(zmq.SUBSCRIBE, '')\n\
         sys.stdout.write('ready\\n')\n\
         sys.stdout.flush()\n\
         while True:\n\
         \ttry:\n\
         \t\tmsg = s.recv_string()\n\
         \texcept Exception:\n\
         \t\tbreak\n\
         \tline = msg.replace('\\r', ' ').replace('\\n', ' ')\n\
         \tsys.stdout.write(line + '\\n')\n\
         \tsys.stdout.flush()\n",
        port
    );

    // Kill any stale process holding the port (from crashed previous runs)
    #[cfg(unix)]
    {
        use std::process::Command as StdCommand;
        if let Ok(output) = StdCommand::new("lsof")
            .args(["-ti", &format!(":{}", port)])
            .output()
        {
            let pids = String::from_utf8_lossy(&output.stdout);
            for pid_str in pids.split_whitespace() {
                if let Ok(pid) = pid_str.parse::<i32>() {
                    log::info!("[progress-relay] Killing stale process on port {}: pid={}", port, pid);
                    unsafe { libc::kill(pid, libc::SIGKILL); }
                }
            }
            if !pids.trim().is_empty() {
                std::thread::sleep(std::time::Duration::from_millis(200));
            }
        }
    }

    log::info!("[progress-relay] Starting on port {}...", port);
    let mut child = std::process::Command::new(&python)
        .args(["-u", "-c", &script])
        .env_clear()
        .envs(child_env())
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn progress relay: {}", e))?;

    // Take stdout so we can read the ready handshake, then move it to the forwarder thread.
    let mut stdout = child.stdout.take().ok_or("progress relay: no stdout")?;
    {
        use std::io::BufRead;
        let mut reader = std::io::BufReader::new(&mut stdout);
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(n) if n > 0 && line.trim() == "ready" => {
                log::info!("[progress-relay] Ready on port {}", port);
            }
            Ok(_) => {
                let stderr_msg = child.stderr.as_mut().map(|se| {
                    let mut buf = String::new();
                    use std::io::Read;
                    let _ = se.read_to_string(&mut buf);
                    buf
                }).unwrap_or_default();
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Progress relay failed: {}", stderr_msg.trim()));
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Failed to read from progress relay: {}", e));
            }
        }
    }

    // Forward every subsequent stdout line to the frontend as a Tauri event.
    let app_handle = app.clone();
    std::thread::spawn(move || {
        use std::io::BufRead;
        use tauri::Emitter;
        let reader = std::io::BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) if !l.trim().is_empty() => {
                    let _ = app_handle.emit("training-progress", l);
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        log::info!("[progress-relay] stdout reader thread exited");
    });

    // Detach stderr so the pipe doesn't block.
    child.stderr.take();

    let mut guard = relay.0.lock().map_err(|e| e.to_string())?;
    *guard = Some(child);
    Ok(())
}

/// Kill the ZMQ SUB progress relay process.
#[tauri::command]
pub async fn stop_progress_relay(
    relay: tauri::State<'_, crate::ProgressRelay>,
) -> Result<(), String> {
    let mut guard = relay.0.lock().map_err(|e| e.to_string())?;
    if let Some(mut child) = guard.take() {
        let _ = child.kill();
        let _ = child.wait();
        log::info!("[progress-relay] Stopped");
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

    // -- uv resolution / PATH augmentation --

    #[test]
    fn test_uv_exe_name() {
        #[cfg(windows)]
        assert_eq!(UV_EXE, "uv.exe");
        #[cfg(not(windows))]
        assert_eq!(UV_EXE, "uv");
    }

    #[test]
    fn test_tool_bin_dirs_prefers_local_bin_then_cargo() {
        let dirs = tool_bin_dirs();
        // ~/.local/bin (astral default + our install button) must be probed
        // before ~/.cargo/bin so the app prefers the standard install.
        let local = dirs
            .iter()
            .position(|p| p.to_string_lossy().contains(".local"));
        let cargo = dirs
            .iter()
            .position(|p| p.to_string_lossy().contains(".cargo"));
        if let (Some(l), Some(c)) = (local, cargo) {
            assert!(l < c, "~/.local/bin must be probed before ~/.cargo/bin");
        }
    }

    #[test]
    fn test_augmented_path_prepends_tool_dirs() {
        let augmented = augmented_path();
        let s = augmented.to_string_lossy();
        // Every probed tool dir must appear in the augmented PATH...
        for dir in tool_bin_dirs() {
            assert!(
                s.contains(&*dir.to_string_lossy()),
                "augmented PATH should contain probed dir {:?}",
                dir
            );
        }
        // ...and the inherited PATH must be preserved (not clobbered).
        if let Some(existing) = std::env::var_os("PATH") {
            for entry in std::env::split_paths(&existing) {
                if !entry.as_os_str().is_empty() {
                    assert!(
                        s.contains(&*entry.to_string_lossy()),
                        "augmented PATH should preserve inherited entry {:?}",
                        entry
                    );
                    break;
                }
            }
        }
    }

    #[test]
    fn test_child_env_strips_appimage_python_vars() {
        // Simulate the Linux AppImage AppRun, which exports $APPDIR-based
        // PYTHONHOME/PYTHONPATH that break any spawned venv python.
        std::env::set_var("PYTHONHOME", "/tmp/.mount_TEST/usr/");
        std::env::set_var("PYTHONPATH", "/tmp/.mount_TEST/usr/share/pyshared/:");

        let env = child_env();

        std::env::remove_var("PYTHONHOME");
        std::env::remove_var("PYTHONPATH");

        use std::ffi::OsStr;
        assert!(
            !env.iter().any(|(k, _)| k == OsStr::new("PYTHONHOME")),
            "child_env must strip PYTHONHOME"
        );
        assert!(
            !env.iter().any(|(k, _)| k == OsStr::new("PYTHONPATH")),
            "child_env must strip PYTHONPATH"
        );
        // PATH must be present and augmented with the tool bin dirs.
        let path = env
            .iter()
            .rev()
            .find(|(k, _)| k == OsStr::new("PATH"))
            .map(|(_, v)| v.to_string_lossy().into_owned())
            .expect("child_env must set PATH");
        for dir in tool_bin_dirs() {
            assert!(
                path.contains(&*dir.to_string_lossy()),
                "child_env PATH should contain probed dir {:?}",
                dir
            );
        }
    }

    // -- sleap-nn venv python path (relay interpreter, #121) --

    #[test]
    fn test_sleap_nn_python_path() {
        let tool_dir = Path::new("/home/u/.local/share/uv/tools");
        let p = sleap_nn_python_path(tool_dir);
        // Must live under the sleap-nn tool dir, not the system python.
        assert!(p.starts_with("/home/u/.local/share/uv/tools/sleap-nn"));
        #[cfg(not(windows))]
        assert_eq!(
            p,
            Path::new("/home/u/.local/share/uv/tools/sleap-nn/bin/python3")
        );
        #[cfg(windows)]
        assert!(p.ends_with("Scripts\\python.exe"));
    }

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
        // A tool that exposes several console scripts (sleap-nn itself exposes
        // only `sleap-nn`; its train/track are subcommands, not separate execs).
        let output = "\
jupyter v1.1.1
    - jupyter
    - jupyter-lab
    - jupyter-notebook
";
        let tools = parse_uv_tool_list(output);
        assert_eq!(tools.len(), 1);
        assert_eq!(
            tools[0].commands,
            vec!["jupyter", "jupyter-lab", "jupyter-notebook"]
        );
    }

    // -- nwb export error formatting tests --

    #[test]
    fn test_nwb_export_error_empty_stderr() {
        assert_eq!(
            nwb_export_error(Some(1), "   \n  "),
            "NWB export failed (exit code Some(1))"
        );
    }

    #[test]
    fn test_nwb_export_error_uses_last_nonempty_line() {
        // pynwb/hdmf tracebacks are long; the actual error is the final line.
        let stderr = "Traceback (most recent call last):\n  File \"x\", line 1\nRuntimeError: unable to write attribute 'starting_frame'\n\n";
        assert_eq!(
            nwb_export_error(Some(1), stderr),
            "RuntimeError: unable to write attribute 'starting_frame'"
        );
    }

    #[test]
    fn test_nwb_export_error_single_line() {
        assert_eq!(nwb_export_error(None, "boom"), "boom");
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
