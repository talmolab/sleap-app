//! Python environment detection and management commands.
//!
//! Detects `uv`, discovers Python interpreters, checks package availability,
//! and installs Python versions and tools via `uv`.
//!
//! All process spawning uses `tauri_plugin_shell::ShellExt` for consistent
//! cross-platform behavior and streaming support.

use crate::RunningProcess;
use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;
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
    /// Same meaning as `UvTool::update_available`: `None` = the self-update
    /// check couldn't run or doesn't apply (offline, timed out, or uv was
    /// installed via a package manager — see `self_update_supported`);
    /// `Some(false)` = confirmed already the latest version; `Some(true)` =
    /// a newer version is available (see `latest_version`).
    pub update_available: Option<bool>,
    pub latest_version: Option<String>,
    /// `uv self update` refuses outright for a uv installed via a package
    /// manager (brew/pip/etc. — no install receipt to update against), not
    /// just for this one check but for the real "Update" button too. `None`
    /// = not determined yet (the check itself failed/timed out, distinct
    /// from a confirmed refusal); `Some(false)` = confirmed refused.
    pub self_update_supported: Option<bool>,
}

/// A tool installed via `uv tool`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UvTool {
    pub name: String,
    pub version: Option<String>,
    pub commands: Vec<String>,
    /// `None` = the outdated-check couldn't run (offline, timed out, etc.);
    /// `Some(false)` = confirmed already the latest version;
    /// `Some(true)` = a newer version is available (see `latest_version`).
    pub update_available: Option<bool>,
    pub latest_version: Option<String>,
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

/// Like `shell_output`, but distinguishes "ran successfully with empty output"
/// from "failed to run at all" — needed for `uv tool list --outdated`, where
/// empty-but-success means nothing is outdated (not "unknown").
async fn shell_status_output<R: Runtime>(
    app: &AppHandle<R>,
    program: &str,
    args: &[&str],
) -> Option<(bool, String)> {
    let output = app
        .shell()
        .command(program)
        .args(args)
        .env_clear()
        .envs(child_env())
        .output()
        .await
        .ok()?;
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Some((output.status.success(), stdout))
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

/// Best-effort, network-dependent check for whether uv itself is out of
/// date, via `uv self update --dry-run` (never actually applies an update).
/// All of uv's dry-run messaging goes to STDERR, not stdout (verified
/// directly against upstream's crates/uv/src/commands/self_update.rs), and
/// resolves through one of two different code paths depending on how uv was
/// installed, with different wording:
///   - Standalone installer (has an install receipt): "You're already on
///     version vX.Y.Z of uv (the latest version)." when current, or "Would
///     update uv from vX.Y.Z to vA.B.C" when outdated — an exact target
///     version either way.
///   - Installed via a package manager (pip/brew/etc., no receipt found):
///     self-update is refused outright with a non-zero exit and a message
///     pointing at `pip install --upgrade`/`brew upgrade` instead — there is
///     no dry-run result to report in that case, and the real "Update"
///     button would fail the exact same way if clicked.
///
/// Bounded by a timeout, same reasoning as `list_uv_tools`'s own
/// `--outdated` check: this is network-dependent (hits GitHub), and a
/// slow/offline resolution must not stall detect_uv (which now runs at app
/// startup, not just when the Environment panel opens).
async fn check_uv_self_update<R: Runtime>(
    app: &AppHandle<R>,
    uv: &str,
) -> (Option<bool>, Option<String>, Option<bool>) {
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        app.shell()
            .command(uv)
            .args(["self", "update", "--dry-run"])
            .env_clear()
            .envs(child_env())
            .output(),
    )
    .await;

    let Ok(Ok(output)) = result else {
        return (None, None, None);
    };

    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    parse_self_update_dry_run(output.status.success(), &stderr)
}

/// Pure parser for `check_uv_self_update`'s output, so the two upstream
/// message shapes can be tested without spawning a real `uv` process. See
/// `check_uv_self_update`'s doc comment for exactly which wording maps to
/// which case.
fn parse_self_update_dry_run(
    success: bool,
    stderr: &str,
) -> (Option<bool>, Option<String>, Option<bool>) {
    if !success {
        // Almost always "installed via a package manager, self-update not
        // supported" (see check_uv_self_update's doc comment). A genuinely
        // transient failure here is already covered by the timeout/spawn-
        // failure branch in the caller, so treating any non-zero exit as
        // "not supported" is strictly better than a wrong up-to-date/
        // outdated guess.
        return (None, None, Some(false));
    }

    if stderr.contains("already on version") || stderr.contains("on the latest version of uv") {
        return (Some(false), None, Some(true));
    }

    if let Some(rest) = stderr
        .lines()
        .find_map(|l| l.strip_prefix("Would update uv from "))
    {
        // "vX.Y.Z to vA.B.C" (standalone installer) or "vX.Y.Z to the latest
        // version" (custom-updater path with no exact target resolved).
        let latest_version = rest
            .split(" to ")
            .nth(1)
            .map(str::trim)
            .and_then(|v| v.strip_prefix('v'))
            .filter(|v| v.chars().next().is_some_and(|c| c.is_ascii_digit()))
            .map(str::to_string);
        return (Some(true), latest_version, Some(true));
    }

    (None, None, None)
}

/// Extract just the semver from `uv --version` output.
///
/// uv prints `uv 0.12.8 (68209e5c6 2026-08-31 aarch64-apple-darwin)` -- the
/// commit, build date and target triple are 40+ characters that used to be
/// rendered verbatim in a 320px-wide panel row, pushing everything else out.
fn parse_uv_version(output: &str) -> String {
    let s = output.trim();
    let s = s.strip_prefix("uv ").unwrap_or(s).trim();
    s.split_whitespace().next().unwrap_or(s).to_string()
}

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
            update_available: None,
            latest_version: None,
            self_update_supported: None,
        };
    }

    let version = version_output.as_deref().map(parse_uv_version);

    // Report the resolved absolute path (None only if we fell back to bare "uv").
    let path = if uv == "uv" { None } else { Some(uv.clone()) };

    // Get managed Python directory
    let python_dir = shell_output(&app, &uv, &["python", "dir"]).await;

    let (update_available, latest_version, self_update_supported) =
        check_uv_self_update(&app, &uv).await;

    UvInfo {
        available: true,
        version,
        path,
        python_dir,
        update_available,
        latest_version,
        self_update_supported,
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

// ---------------------------------------------------------------------------
// Accelerator / GPU detection (as sleap-nn itself sees it)
// ---------------------------------------------------------------------------

/// Accelerator + GPU info for the sleap-nn install, as reported by the torch
/// inside its own uv-tool venv.
///
/// Every field mirrors one from sleap-nn's `get_system_info_dict()` -- see
/// `ACCELERATOR_PROBE_SCRIPT`.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceleratorInfo {
    /// "cuda", "mps" or "cpu". `None` only when the probe couldn't run at all
    /// (see `error`) -- "no GPU" is reported as `Some("cpu")`, not as `None`.
    pub accelerator: Option<String>,
    /// Devices torch can actually use: the CUDA device count, or 0 for CPU.
    ///
    /// MPS reports 1, which is Lightning's `devices=1` convention rather than
    /// a real device count -- Metal exposes one unified GPU that isn't
    /// enumerable or countable. Passed through as sleap-nn reports it, but do
    /// NOT show it as "1 GPU" on a Mac: see `summarizeAccelerator`, which
    /// renders a count only for CUDA.
    pub gpu_count: u32,
    /// Per-device descriptions, e.g. "NVIDIA RTX 4090 (24 GB)". CUDA only --
    /// torch exposes no equivalent device list for MPS.
    pub gpus: Vec<String>,
    pub torch_version: Option<String>,
    pub cuda_version: Option<String>,
    /// NVIDIA driver version, reported even when CUDA is unavailable: a driver
    /// present with no usable CUDA is the signature of a CPU-only torch wheel,
    /// which is exactly the case the UI needs to call out.
    pub driver_version: Option<String>,
    /// Whether `driver_version` meets `driver_min_required` for
    /// `cuda_version`. `None` when it couldn't be determined (no driver, or a
    /// CUDA version sleap-nn has no requirement table entry for).
    pub driver_compatible: Option<bool>,
    pub driver_min_required: Option<String>,
    /// "macos", "windows" or "linux" -- which accelerator is even reachable
    /// depends on it (no CUDA on macOS, no MPS anywhere else).
    pub os: String,
    /// Why nothing could be reported. Mutually exclusive with the fields above.
    pub error: Option<String>,
}

/// Re-emits sleap-nn's own system-info collector as JSON on stdout -- the same
/// data `sleap-nn system` prints as a table, which is where the driver /
/// compute-capability knowledge lives (sleap_nn/system_info.py). Failures are
/// reported in-band as `{"error": ...}` so an old sleap-nn without that module
/// surfaces as a message rather than an opaque non-zero exit.
const ACCELERATOR_PROBE_SCRIPT: &str = "\
import json
try:
    from sleap_nn.system_info import get_system_info_dict
    out = get_system_info_dict()
except Exception as e:
    out = {'error': '%s: %s' % (type(e).__name__, e)}
print(json.dumps(out))
";

/// Importing torch is slow (seconds; more on a cold filesystem cache, more
/// again on Windows), so this is generous -- but bounded, so a wedged probe
/// leaves the UI saying "unknown" instead of spinning forever.
const ACCELERATOR_PROBE_TIMEOUT: Duration = Duration::from_secs(90);

/// Clamp a subprocess message to something that fits in a tooltip.
fn short_error(s: &str) -> String {
    let s = s.trim();
    if s.chars().count() <= 300 {
        return s.to_string();
    }
    s.chars().take(297).collect::<String>() + "..."
}

fn str_field(v: &serde_json::Value, key: &str) -> Option<String> {
    v.get(key).and_then(|x| x.as_str()).map(str::to_string)
}

/// Pure parser for `ACCELERATOR_PROBE_SCRIPT`'s stdout, so the mapping can be
/// tested without a real sleap-nn install.
///
/// Falls back to the LAST non-empty line when the whole buffer doesn't parse:
/// anything the venv's own startup chatter (deprecation notices, CUDA init
/// warnings) writes to stdout lands before our single line of JSON.
fn parse_accelerator_json(stdout: &str, os: &str) -> AcceleratorInfo {
    let mut info = AcceleratorInfo {
        os: os.to_string(),
        ..Default::default()
    };

    let Some(text) = stdout.lines().rev().find(|l| !l.trim().is_empty()) else {
        info.error = Some("sleap-nn's Python reported nothing.".to_string());
        return info;
    };

    let parsed = serde_json::from_str::<serde_json::Value>(stdout.trim())
        .or_else(|_| serde_json::from_str::<serde_json::Value>(text.trim()));

    let Ok(v) = parsed else {
        info.error = Some(format!("Unexpected output: {}", short_error(text)));
        return info;
    };

    if let Some(err) = str_field(&v, "error") {
        info.error = Some(short_error(&err));
        return info;
    }

    info.accelerator = str_field(&v, "accelerator");
    info.gpu_count = v
        .get("gpu_count")
        .and_then(|c| c.as_u64())
        .unwrap_or(0)
        .min(u32::MAX as u64) as u32;
    info.torch_version = str_field(&v, "pytorch_version");
    info.cuda_version = str_field(&v, "cuda_version");
    info.driver_version = str_field(&v, "driver_version");
    info.driver_compatible = v.get("driver_compatible").and_then(|b| b.as_bool());
    info.driver_min_required = str_field(&v, "driver_min_required");
    info.gpus = v
        .get("gpus")
        .and_then(|g| g.as_array())
        .map(|gpus| {
            gpus.iter()
                .filter_map(|g| {
                    let name = str_field(g, "name")?;
                    Some(match g.get("memory_gb").and_then(|m| m.as_f64()) {
                        Some(mem) => format!("{} ({} GB)", name, mem),
                        None => name,
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    info
}

/// Report which accelerator sleap-nn will actually train on, and how many GPUs
/// it can see.
///
/// Deliberately asks the torch INSIDE sleap-nn's uv-tool venv -- the same
/// interpreter training and inference run on, resolved the same way as the ZMQ
/// relays -- rather than probing the machine with `nvidia-smi` the way
/// `detect_gpu` above does. The question a user is asking when they check
/// this ("did my GPU get picked up?") is whether the INSTALLED torch build can
/// use it: a CUDA machine carrying a CPU-only torch wheel reports "cpu" here,
/// which is precisely the "reinstall sleap-nn" signal, while `detect_gpu`
/// would still say "cuda". (`detect_gpu` can't be replaced by this: it runs
/// BEFORE sleap-nn exists, to choose which torch extra to install.)
#[tauri::command]
pub async fn detect_accelerator<R: Runtime>(app: AppHandle<R>) -> AcceleratorInfo {
    let os = std::env::consts::OS;
    let fail = |error: String| AcceleratorInfo {
        os: os.to_string(),
        error: Some(error),
        ..Default::default()
    };

    let python = match resolve_sleap_nn_python(&app).await {
        Ok(p) => p,
        Err(e) => return fail(e),
    };

    let result = tokio::time::timeout(
        ACCELERATOR_PROBE_TIMEOUT,
        app.shell()
            .command(python.to_string_lossy().to_string())
            .args(["-c", ACCELERATOR_PROBE_SCRIPT])
            .env_clear()
            .envs(child_env())
            .output(),
    )
    .await;

    match result {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            // The script catches its own exceptions, so a non-zero exit with
            // no JSON means the interpreter itself failed (broken venv, bad
            // torch install) -- report its stderr, which says why.
            if !output.status.success() && stdout.trim().is_empty() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return fail(if stderr.trim().is_empty() {
                    "sleap-nn's Python exited without output.".to_string()
                } else {
                    short_error(&stderr)
                });
            }
            parse_accelerator_json(&stdout, os)
        }
        Ok(Err(e)) => fail(format!("Could not run sleap-nn's Python: {}", e)),
        Err(_) => fail(format!(
            "Timed out after {}s waiting for sleap-nn to report GPU status.",
            ACCELERATOR_PROBE_TIMEOUT.as_secs()
        )),
    }
}

// ---------------------------------------------------------------------------
// Optional sleap-nn extras (ONNX / TensorRT export support)
// ---------------------------------------------------------------------------

/// Which optional sleap-nn extras are present in its uv-tool venv.
///
/// Answers the question the Environment panel's extras checkboxes need and
/// that nothing could answer before: `uv tool list` reports the tool's
/// version but NOT which extras it was installed with, so the only way to
/// know is to look for the modules they bring in.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SleapNnExtras {
    /// sleap-nn's `[export]` extra: `onnx` + `onnxruntime` (+ onnxscript).
    pub onnx: bool,
    /// sleap-nn's `[tensorrt]` extra: `tensorrt` + `torch_tensorrt`.
    pub tensorrt: bool,
    /// Whether TensorRT is installable on this platform at all. sleap-nn marks
    /// both tensorrt deps `sys_platform == 'linux' or sys_platform == 'win32'`,
    /// so on macOS the extra resolves to NOTHING and asking for it would
    /// silently install nothing -- hence the UI greys it out rather than
    /// letting it be selected.
    pub tensorrt_supported: bool,
    pub error: Option<String>,
}

/// Reports which extras' modules are importable, WITHOUT importing them:
/// `find_spec` only resolves the module on disk, so this stays fast (no torch,
/// no onnxruntime init) and can refresh on its own while the much slower
/// accelerator probe is still running.
const EXTRAS_PROBE_SCRIPT: &str = "\
import json, importlib.util as u
def has(m):
    try:
        return u.find_spec(m) is not None
    except Exception:
        return False
print(json.dumps({
    'onnx': has('onnx') and has('onnxruntime'),
    'tensorrt': has('tensorrt') and has('torch_tensorrt'),
}))
";

/// No torch import here (see `EXTRAS_PROBE_SCRIPT`), so this only has to cover
/// interpreter startup.
const EXTRAS_PROBE_TIMEOUT: Duration = Duration::from_secs(30);

/// True when sleap-nn's `tensorrt` extra has any installable dependency on
/// this platform -- see `SleapNnExtras::tensorrt_supported`.
const fn tensorrt_supported() -> bool {
    cfg!(any(target_os = "linux", target_os = "windows"))
}

/// Pure parser for `EXTRAS_PROBE_SCRIPT`'s stdout. Same last-non-empty-line
/// tolerance as `parse_accelerator_json`, for the same reason.
fn parse_extras_json(stdout: &str) -> SleapNnExtras {
    let mut extras = SleapNnExtras {
        tensorrt_supported: tensorrt_supported(),
        ..Default::default()
    };

    let Some(text) = stdout.lines().rev().find(|l| !l.trim().is_empty()) else {
        extras.error = Some("sleap-nn's Python reported nothing.".to_string());
        return extras;
    };

    let parsed = serde_json::from_str::<serde_json::Value>(stdout.trim())
        .or_else(|_| serde_json::from_str::<serde_json::Value>(text.trim()));

    let Ok(v) = parsed else {
        extras.error = Some(format!("Unexpected output: {}", short_error(text)));
        return extras;
    };

    extras.onnx = v.get("onnx").and_then(|b| b.as_bool()).unwrap_or(false);
    // A tensorrt module present on a platform sleap-nn can't install it on
    // would be someone else's install; report what's actually importable and
    // let the UI decide what to offer.
    extras.tensorrt = v.get("tensorrt").and_then(|b| b.as_bool()).unwrap_or(false);
    extras
}

/// Detect which optional extras the installed sleap-nn carries.
#[tauri::command]
pub async fn detect_sleap_nn_extras<R: Runtime>(app: AppHandle<R>) -> SleapNnExtras {
    let fail = |error: String| SleapNnExtras {
        tensorrt_supported: tensorrt_supported(),
        error: Some(error),
        ..Default::default()
    };

    let python = match resolve_sleap_nn_python(&app).await {
        Ok(p) => p,
        Err(e) => return fail(e),
    };

    let result = tokio::time::timeout(
        EXTRAS_PROBE_TIMEOUT,
        app.shell()
            .command(python.to_string_lossy().to_string())
            .args(["-c", EXTRAS_PROBE_SCRIPT])
            .env_clear()
            .envs(child_env())
            .output(),
    )
    .await;

    match result {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            if !output.status.success() && stdout.trim().is_empty() {
                let stderr = String::from_utf8_lossy(&output.stderr);
                return fail(if stderr.trim().is_empty() {
                    "sleap-nn's Python exited without output.".to_string()
                } else {
                    short_error(&stderr)
                });
            }
            parse_extras_json(&stdout)
        }
        Ok(Err(e)) => fail(format!("Could not run sleap-nn's Python: {}", e)),
        Err(_) => fail(format!(
            "Timed out after {}s checking sleap-nn's extras.",
            EXTRAS_PROBE_TIMEOUT.as_secs()
        )),
    }
}

/// List tools installed via `uv tool`.
#[tauri::command]
pub async fn list_uv_tools<R: Runtime>(app: AppHandle<R>) -> Vec<UvTool> {
    let uv = resolve_uv(&app).await;
    let mut tools = match shell_output(&app, &uv, &["tool", "list"]).await {
        Some(output) => parse_uv_tool_list(&output),
        None => vec![],
    };

    // Best-effort "is a newer version available?" check via `uv tool list
    // --outdated`, which resolves against the index (network). Bounded by a
    // timeout so a slow/offline resolution can't stall the whole panel —
    // `uv tool list` above is local and instant, this is the first
    // network-dependent step in this command. On any failure/timeout, leave
    // `update_available` as `None` (unknown) on every tool rather than
    // disabling their Update buttons.
    let outdated = tokio::time::timeout(
        Duration::from_secs(5),
        shell_status_output(&app, &uv, &["tool", "list", "--outdated"]),
    )
    .await
    .ok()
    .flatten();

    if let Some((true, output)) = outdated {
        let latest_by_name = parse_uv_tool_outdated(&output);
        for tool in &mut tools {
            match latest_by_name.get(&tool.name) {
                Some(latest) => {
                    tool.update_available = Some(true);
                    tool.latest_version = Some(latest.clone());
                }
                None => {
                    tool.update_available = Some(false);
                    // Confirmed up to date (absent from `--outdated` output) means
                    // the installed version IS the latest — no extra query needed.
                    tool.latest_version = tool.version.clone();
                }
            }
        }
    }

    tools
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

/// Start the warm sleap-nn `overlay-serve` sidecar (model-output overlays).
///
/// Resolves the app's sleap-nn venv Python and the bundled `overlay-serve` script,
/// spawns it with the chosen model dirs (`OVERLAY_MODELS`, os-pathsep-joined) +
/// device, then reads stdout until the `OVERLAY_SERVE_READY port=<n>` line and
/// returns the port. The app then fetches confmaps from
/// `http://127.0.0.1:<port>/infer`. The model loads ONCE in the sidecar (warmed with
/// a synthetic frame — no video), so per-frame requests are just a forward pass.
#[tauri::command]
pub async fn start_overlay_serve<R: Runtime>(
    app: AppHandle<R>,
    model_paths: Vec<String>,
    device: String,
    overlay: tauri::State<'_, crate::OverlayServe>,
) -> Result<u16, String> {
    // Kill any sidecars we already own (previous toggle / racing spawn).
    {
        let mut guard = overlay.0.lock().map_err(|e| e.to_string())?;
        for mut child in guard.drain(..) {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    if model_paths.is_empty() {
        return Err("No overlay model directories provided".into());
    }

    // Resolve sleap-nn's venv Python (same env inference uses) + the bundled script.
    let python = resolve_sleap_nn_python(&app).await?;
    let script = {
        use tauri::Manager;
        match app
            .path()
            .resolve("resources/overlay_serve.py", tauri::path::BaseDirectory::Resource)
        {
            Ok(p) if p.exists() => p,
            _ => {
                // Dev fallback (tauri dev may not stage resources): manifest-relative.
                let dev = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("resources/overlay_serve.py");
                if dev.exists() {
                    dev
                } else {
                    return Err("overlay-serve script not found (resource + dev fallback)".into());
                }
            }
        }
    };
    let models_joined = std::env::join_paths(model_paths.iter())
        .map_err(|e| format!("Invalid model path: {}", e))?;

    log::info!(
        "[overlay-serve] starting: {} {} (models: {:?})",
        python.display(),
        script.display(),
        model_paths
    );
    let mut child = std::process::Command::new(&python)
        .arg("-u")
        .arg(&script)
        .env_clear()
        .envs(child_env())
        .env("OVERLAY_MODELS", &models_joined)
        .env("OVERLAY_DEVICE", &device)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to spawn overlay-serve: {}", e))?;

    // Read stdout until the READY handshake. Model load + warmup can take
    // ~10-20s; earlier lines (load logs / warnings) are skipped.
    let mut port: Option<u16> = None;
    let mut device_used: Option<String> = None;
    if let Some(ref mut stdout) = child.stdout {
        use std::io::BufRead;
        let reader = std::io::BufReader::new(stdout);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(e) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("Failed to read overlay-serve stdout: {}", e));
                }
            };
            if let Some(rest) = line.strip_prefix("OVERLAY_SERVE_READY port=") {
                // rest = "<port> device=<cuda|mps|cpu>" (device optional/older scripts)
                let mut parts = rest.split_whitespace();
                port = parts.next().and_then(|p| p.parse::<u16>().ok());
                device_used = parts.find_map(|t| t.strip_prefix("device=").map(str::to_string));
                break;
            }
        }
    }

    let port = match port {
        Some(p) => p,
        None => {
            let stderr_msg = child
                .stderr
                .as_mut()
                .map(|se| {
                    use std::io::Read;
                    let mut buf = String::new();
                    let _ = se.read_to_string(&mut buf);
                    buf
                })
                .unwrap_or_default();
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "overlay-serve did not report a ready port. {}",
                stderr_msg.trim()
            ));
        }
    };

    // Detach pipes so the sidecar never blocks on a full stdout/stderr buffer.
    child.stdout.take();
    child.stderr.take();

    {
        let mut guard = overlay.0.lock().map_err(|e| e.to_string())?;
        // Kill any sidecar a racing spawn stored before tracking this one, so a
        // dev double-mount leaves exactly one live sidecar (never an orphan).
        for mut old in guard.drain(..) {
            let _ = old.kill();
            let _ = old.wait();
        }
        guard.push(child);
    }
    log::info!(
        "[overlay-serve] ready on port {} (device={})",
        port,
        device_used.as_deref().unwrap_or("?")
    );
    Ok(port)
}

/// Kill all overlay-serve sidecars we own.
#[tauri::command]
pub async fn stop_overlay_serve(
    overlay: tauri::State<'_, crate::OverlayServe>,
) -> Result<(), String> {
    let mut guard = overlay.0.lock().map_err(|e| e.to_string())?;
    let mut n = 0;
    for mut child in guard.drain(..) {
        let _ = child.kill();
        let _ = child.wait();
        n += 1;
    }
    if n > 0 {
        log::info!("[overlay-serve] stopped {} sidecar(s)", n);
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
                update_available: None,
                latest_version: None,
            });
        }
    }

    if let Some(tool) = current {
        tools.push(tool);
    }

    tools
}

/// Parse the output of `uv tool list --outdated`.
///
/// Only tools with a newer version available are listed, one entry per
/// outdated tool. Format:
/// ```text
/// package-name v0.1.0 [latest: 0.2.0]
///     - command1
/// ```
/// Returns a map of tool name -> latest version string (no `v` prefix).
fn parse_uv_tool_outdated(output: &str) -> HashMap<String, String> {
    let mut latest_by_name = HashMap::new();

    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("- ") {
            continue;
        }

        let Some(bracket_start) = trimmed.find("[latest:") else {
            continue;
        };
        let name = trimmed[..bracket_start]
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_string();
        if name.is_empty() {
            continue;
        }

        let latest = trimmed[bracket_start + "[latest:".len()..]
            .trim_end_matches(']')
            .trim()
            .trim_start_matches('v')
            .to_string();
        if !latest.is_empty() {
            latest_by_name.insert(name, latest);
        }
    }

    latest_by_name
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

/// WandB authentication status, mirroring legacy SLEAP's
/// `wandb_utils.check_wandb_login_status`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WandbAuth {
    pub authenticated: bool,
    /// Human-readable description of how the user is authenticated, or `None`.
    pub source: Option<String>,
    /// Username from the netrc `login` field, if available.
    pub username: Option<String>,
}

/// Scan `.netrc`-format text for an `api.wandb.ai` entry. Returns whether a
/// password (the API key) is present, and the associated `login`/username if
/// any. Handles both one-per-line and single-line entries; stops the machine
/// block at the next `machine`/`default` token.
fn parse_netrc_wandb(text: &str) -> (bool, Option<String>) {
    let tokens: Vec<&str> = text.split_whitespace().collect();
    let mut i = 0;
    while i < tokens.len() {
        if tokens[i] == "machine" && i + 1 < tokens.len() {
            if tokens[i + 1] == "api.wandb.ai" {
                let mut j = i + 2;
                let mut login: Option<String> = None;
                let mut has_password = false;
                while j < tokens.len() && tokens[j] != "machine" && tokens[j] != "default" {
                    match tokens[j] {
                        "login" if j + 1 < tokens.len() => {
                            login = Some(tokens[j + 1].to_string());
                            j += 2;
                        }
                        "password" if j + 1 < tokens.len() => {
                            has_password = true;
                            j += 2;
                        }
                        "account" if j + 1 < tokens.len() => j += 2,
                        _ => j += 1,
                    }
                }
                if has_password {
                    return (true, login);
                }
            }
            i += 2;
        } else {
            i += 1;
        }
    }
    (false, None)
}

/// Detect whether WandB is already authenticated on this machine, WITHOUT
/// calling `wandb login` (which is slow and prompts). Checks the
/// `WANDB_API_KEY` env var first, then cached credentials in `~/.netrc` /
/// `~/_netrc`. Desktop-only; mirrors legacy SLEAP's `check_wandb_login_status`.
#[tauri::command]
pub fn check_wandb_auth() -> WandbAuth {
    if std::env::var("WANDB_API_KEY")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false)
    {
        return WandbAuth {
            authenticated: true,
            source: Some("WANDB_API_KEY environment variable".to_string()),
            username: None,
        };
    }
    if let Some(home) = dirs::home_dir() {
        for name in [".netrc", "_netrc"] {
            if let Ok(text) = std::fs::read_to_string(home.join(name)) {
                let (has_password, username) = parse_netrc_wandb(&text);
                if has_password {
                    return WandbAuth {
                        authenticated: true,
                        source: Some("cached credentials (~/.netrc)".to_string()),
                        username,
                    };
                }
            }
        }
    }
    WandbAuth {
        authenticated: false,
        source: None,
        username: None,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    // -- WandB netrc parsing --

    #[test]
    fn netrc_finds_wandb_credentials_multiline() {
        let netrc = "machine api.wandb.ai\n  login myuser\n  password abc123def\n";
        let (found, user) = parse_netrc_wandb(netrc);
        assert!(found);
        assert_eq!(user, Some("myuser".to_string()));
    }

    #[test]
    fn netrc_finds_wandb_credentials_single_line() {
        let netrc = "machine api.wandb.ai login u password k\n";
        let (found, user) = parse_netrc_wandb(netrc);
        assert!(found);
        assert_eq!(user, Some("u".to_string()));
    }

    #[test]
    fn netrc_ignores_other_machines() {
        let netrc = "machine github.com login x password y\n";
        let (found, user) = parse_netrc_wandb(netrc);
        assert!(!found);
        assert_eq!(user, None);
    }

    #[test]
    fn netrc_wandb_without_password_is_not_authenticated() {
        let netrc = "machine api.wandb.ai login onlyuser\n";
        let (found, _) = parse_netrc_wandb(netrc);
        assert!(!found);
    }

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

    // -- uv --version parsing --

    #[test]
    fn test_parse_uv_version_strips_build_metadata() {
        assert_eq!(
            parse_uv_version("uv 0.12.8 (68209e5c6 2026-08-31 aarch64-apple-darwin)"),
            "0.12.8"
        );
        assert_eq!(parse_uv_version("uv 0.12.8"), "0.12.8");
        assert_eq!(parse_uv_version("  uv 0.12.8  "), "0.12.8");
        // No "uv " prefix (unexpected shape): still yields the first token.
        assert_eq!(parse_uv_version("0.12.8 (abc)"), "0.12.8");
        assert_eq!(parse_uv_version(""), "");
    }

    // -- sleap-nn extras probe parser --

    #[test]
    fn test_parse_extras_both_present() {
        let e = parse_extras_json(r#"{"onnx":true,"tensorrt":true}"#);
        assert!(e.onnx);
        assert!(e.tensorrt);
        assert!(e.error.is_none());
    }

    #[test]
    fn test_parse_extras_none_present() {
        let e = parse_extras_json(r#"{"onnx":false,"tensorrt":false}"#);
        assert!(!e.onnx);
        assert!(!e.tensorrt);
        assert!(e.error.is_none());
    }

    // The common post-`installExportExtra(false)` state: export support only.
    #[test]
    fn test_parse_extras_onnx_only() {
        let e = parse_extras_json(r#"{"onnx":true,"tensorrt":false}"#);
        assert!(e.onnx);
        assert!(!e.tensorrt);
    }

    // tensorrt_supported is a compile-time platform fact, never read from the
    // probe -- it must be filled in on every path, including the error ones.
    #[test]
    fn test_parse_extras_reports_platform_support() {
        let expected = cfg!(any(target_os = "linux", target_os = "windows"));
        assert_eq!(
            parse_extras_json(r#"{"onnx":true,"tensorrt":false}"#).tensorrt_supported,
            expected
        );
        assert_eq!(parse_extras_json("not json").tensorrt_supported, expected);
        assert_eq!(parse_extras_json("").tensorrt_supported, expected);
        #[cfg(target_os = "macos")]
        assert!(!expected, "macOS must not offer TensorRT");
    }

    #[test]
    fn test_parse_extras_ignores_stdout_noise() {
        let e = parse_extras_json("some warning\n{\"onnx\":true,\"tensorrt\":false}\n");
        assert!(e.onnx);
        assert!(e.error.is_none());
    }

    #[test]
    fn test_parse_extras_missing_keys_default_false() {
        let e = parse_extras_json("{}");
        assert!(!e.onnx);
        assert!(!e.tensorrt);
        assert!(e.error.is_none());
    }

    #[test]
    fn test_parse_extras_non_json_and_empty() {
        let e = parse_extras_json("Traceback (most recent call last):\n");
        assert!(!e.onnx);
        assert!(e.error.unwrap().contains("Unexpected output"));

        let e = parse_extras_json("   \n");
        assert!(e.error.is_some());
    }

    // -- accelerator probe parser (sleap-nn system_info -> AcceleratorInfo) --

    // Shape taken from sleap_nn/system_info.py's get_system_info_dict(); only
    // the fields parse_accelerator_json reads are kept.
    #[test]
    fn test_parse_accelerator_cuda() {
        let json = r#"{"accelerator":"cuda","gpu_count":2,"pytorch_version":"2.9.0+cu130",
            "cuda_version":"13.0","cudnn_version":"91002","driver_version":"580.65.06",
            "driver_compatible":true,"driver_min_required":"580.65.06",
            "gpus":[{"id":0,"name":"NVIDIA RTX 4090","compute_capability":"8.9","memory_gb":23.6},
                    {"id":1,"name":"NVIDIA RTX 4090","compute_capability":"8.9","memory_gb":23.6}]}"#;
        let info = parse_accelerator_json(json, "linux");
        assert_eq!(info.accelerator.as_deref(), Some("cuda"));
        assert_eq!(info.gpu_count, 2);
        assert_eq!(
            info.gpus,
            vec![
                "NVIDIA RTX 4090 (23.6 GB)".to_string(),
                "NVIDIA RTX 4090 (23.6 GB)".to_string()
            ]
        );
        assert_eq!(info.cuda_version.as_deref(), Some("13.0"));
        assert_eq!(info.driver_version.as_deref(), Some("580.65.06"));
        assert_eq!(info.driver_compatible, Some(true));
        assert_eq!(info.torch_version.as_deref(), Some("2.9.0+cu130"));
        assert_eq!(info.os, "linux");
        assert!(info.error.is_none());
    }

    #[test]
    fn test_parse_accelerator_mps() {
        let json = r#"{"accelerator":"mps","gpu_count":1,"gpus":[],"mps_available":true,
            "pytorch_version":"2.9.0","cuda_version":null,"driver_version":null,
            "driver_compatible":null,"driver_min_required":null}"#;
        let info = parse_accelerator_json(json, "macos");
        assert_eq!(info.accelerator.as_deref(), Some("mps"));
        assert_eq!(info.gpu_count, 1);
        assert!(info.gpus.is_empty());
        // JSON nulls must come through as None, not Some("null").
        assert!(info.cuda_version.is_none());
        assert!(info.driver_version.is_none());
        assert!(info.driver_compatible.is_none());
        assert!(info.error.is_none());
    }

    // The case the green light exists for: a driver is present, so the machine
    // HAS an NVIDIA GPU, but the installed torch can't use it (CPU-only wheel).
    #[test]
    fn test_parse_accelerator_cpu_with_driver() {
        let json = r#"{"accelerator":"cpu","gpu_count":0,"gpus":[],
            "pytorch_version":"2.9.0+cpu","cuda_version":null,"driver_version":"580.65.06"}"#;
        let info = parse_accelerator_json(json, "windows");
        assert_eq!(info.accelerator.as_deref(), Some("cpu"));
        assert_eq!(info.gpu_count, 0);
        assert_eq!(info.driver_version.as_deref(), Some("580.65.06"));
        assert!(info.error.is_none());
    }

    #[test]
    fn test_parse_accelerator_in_band_error() {
        let json = r#"{"error":"ModuleNotFoundError: No module named 'sleap_nn.system_info'"}"#;
        let info = parse_accelerator_json(json, "linux");
        assert!(info.accelerator.is_none());
        assert_eq!(info.gpu_count, 0);
        assert!(info.error.unwrap().contains("No module named"));
    }

    // Venv startup chatter on stdout must not shadow the JSON line.
    #[test]
    fn test_parse_accelerator_ignores_leading_stdout_noise() {
        let stdout = "UserWarning: something deprecated\n\
                      {\"accelerator\":\"mps\",\"gpu_count\":1}\n";
        let info = parse_accelerator_json(stdout, "macos");
        assert_eq!(info.accelerator.as_deref(), Some("mps"));
        assert_eq!(info.gpu_count, 1);
        assert!(info.error.is_none());
    }

    #[test]
    fn test_parse_accelerator_non_json_and_empty() {
        let info = parse_accelerator_json("Traceback (most recent call last):\n", "linux");
        assert!(info.accelerator.is_none());
        assert!(info.error.unwrap().contains("Unexpected output"));

        let info = parse_accelerator_json("  \n\n", "linux");
        assert!(info.accelerator.is_none());
        assert!(info.error.is_some());
        assert_eq!(info.os, "linux");
    }

    #[test]
    fn test_short_error_truncates() {
        assert_eq!(short_error("  boom  "), "boom");
        let long = "x".repeat(400);
        let out = short_error(&long);
        assert_eq!(out.chars().count(), 300);
        assert!(out.ends_with("..."));
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

    // -- parse_uv_tool_outdated tests --

    #[test]
    fn test_parse_uv_tool_outdated_empty() {
        assert!(parse_uv_tool_outdated("").is_empty());
    }

    #[test]
    fn test_parse_self_update_dry_run_already_latest_standalone() {
        let stderr = "info: Checking for updates...\nsuccess: You're already on version v0.12.7 of uv (the latest version).\n";
        let (update_available, latest_version, supported) =
            parse_self_update_dry_run(true, stderr);
        assert_eq!(update_available, Some(false));
        assert_eq!(latest_version, None);
        assert_eq!(supported, Some(true));
    }

    #[test]
    fn test_parse_self_update_dry_run_already_latest_custom_path() {
        let stderr = "You're on the latest version of uv (v0.12.7)\n";
        let (update_available, latest_version, supported) =
            parse_self_update_dry_run(true, stderr);
        assert_eq!(update_available, Some(false));
        assert_eq!(latest_version, None);
        assert_eq!(supported, Some(true));
    }

    #[test]
    fn test_parse_self_update_dry_run_outdated_standalone_has_exact_version() {
        let stderr = "Would update uv from v0.12.7 to v0.13.0\n";
        let (update_available, latest_version, supported) =
            parse_self_update_dry_run(true, stderr);
        assert_eq!(update_available, Some(true));
        assert_eq!(latest_version, Some("0.13.0".to_string()));
        assert_eq!(supported, Some(true));
    }

    #[test]
    fn test_parse_self_update_dry_run_outdated_custom_path_no_exact_version() {
        // The custom-updater path (UpdateRequest::Latest) can't resolve an
        // exact target version in dry-run mode -- literally "the latest
        // version" instead of a vX.Y.Z string.
        let stderr = "Would update uv from v0.12.7 to the latest version\n";
        let (update_available, latest_version, supported) =
            parse_self_update_dry_run(true, stderr);
        assert_eq!(update_available, Some(true));
        assert_eq!(latest_version, None);
        assert_eq!(supported, Some(true));
    }

    #[test]
    fn test_parse_self_update_dry_run_refused_for_package_manager_install() {
        let stderr = "error: Self-update is only available for uv binaries installed via the standalone installation scripts.\n\nIf you installed uv with pip, brew, or another package manager, update uv with `pip install --upgrade`, `brew upgrade`, or similar.\n";
        let (update_available, latest_version, supported) =
            parse_self_update_dry_run(false, stderr);
        assert_eq!(update_available, None);
        assert_eq!(latest_version, None);
        assert_eq!(supported, Some(false));
    }

    #[test]
    fn test_parse_self_update_dry_run_unrecognized_output_is_unknown() {
        let (update_available, latest_version, supported) =
            parse_self_update_dry_run(true, "some future uv release changed the wording\n");
        assert_eq!(update_available, None);
        assert_eq!(latest_version, None);
        assert_eq!(supported, None);
    }

    #[test]
    fn test_parse_uv_tool_outdated_single() {
        let output = "sleap-nn v0.3.3 [latest: 0.4.0]\n    - sleap-nn\n";
        let map = parse_uv_tool_outdated(output);
        assert_eq!(map.get("sleap-nn"), Some(&"0.4.0".to_string()));
        assert_eq!(map.len(), 1);
    }

    #[test]
    fn test_parse_uv_tool_outdated_multiple() {
        let output = "\
poethepoet v0.44.0 [latest: 0.45.0]
    - poe
sleap-nn v0.3.3 [latest: 0.4.0]
    - sleap-nn
";
        let map = parse_uv_tool_outdated(output);
        assert_eq!(map.len(), 2);
        assert_eq!(map.get("poethepoet"), Some(&"0.45.0".to_string()));
        assert_eq!(map.get("sleap-nn"), Some(&"0.4.0".to_string()));
    }

    #[test]
    fn test_parse_uv_tool_outdated_ignores_non_outdated_tools() {
        // A tool with no `[latest: ...]` marker (shouldn't appear in
        // `--outdated` output at all, but guard against malformed lines).
        let output = "sleap-nn v0.3.3\n    - sleap-nn\n";
        assert!(parse_uv_tool_outdated(output).is_empty());
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
