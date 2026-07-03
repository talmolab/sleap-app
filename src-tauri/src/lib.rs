mod environment;
mod rtc;

use std::path::{Component, PathBuf};
use std::sync::Mutex;
use tauri_plugin_shell::process::CommandChild;

pub struct RunningProcess(pub Mutex<Option<CommandChild>>);

/// ZMQ PUB relay for sending stop commands to sleap-nn during training.
/// Uses std::process::Child (not Tauri shell) for reliable pipe handling.
pub struct ZmqRelay(pub Mutex<Option<std::process::Child>>);

/// ZMQ SUB relay for receiving training progress (loss) from sleap-nn.
/// Uses std::process::Child (python3 sidecar) like ZmqRelay.
pub struct ProgressRelay(pub Mutex<Option<std::process::Child>>);

/// Holds a file path passed as a CLI argument, consumed once by the frontend.
struct InitialFile(Mutex<Option<String>>);

/// Returns (and consumes) the file path passed via CLI, if any.
#[tauri::command]
fn get_initial_file(state: tauri::State<InitialFile>) -> Option<String> {
    state.0.lock().unwrap().take()
}

/// Read a file's raw bytes natively (`std::fs::read`), bypassing the fs plugin's
/// per-call path scope-validation. On SMB/network mounts that validation adds
/// multi-second cold-read latency (measured ~4 s/frame vs ~32 ms native), which
/// is pathological for ImageVideo playback (one image read per displayed frame).
/// Returns raw bytes via the binary IPC channel (no JSON number-array encoding).
#[tauri::command]
fn read_image_file(path: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| format!("read_image_file({path}): {e}"))
}

/// Read a byte range `[offset, offset+length)` from a file natively (`std::fs`).
/// The "dumb byte pipe" for the B-seam range reader: returns raw bytes via the
/// binary IPC channel and does ZERO decoding. A short read at EOF returns fewer
/// bytes (never an error), so the last chunk of a file works.
#[tauri::command]
fn read_range(path: String, offset: u64, length: u32) -> Result<tauri::ipc::Response, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(&path).map_err(|e| format!("read_range open({path}): {e}"))?;
    f.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("read_range seek({offset}): {e}"))?;
    let mut buf = vec![0u8; length as usize];
    let mut filled = 0usize;
    while filled < buf.len() {
        match f.read(&mut buf[filled..]) {
            Ok(0) => break, // EOF
            Ok(n) => filled += n,
            Err(e) => return Err(format!("read_range read: {e}")),
        }
    }
    buf.truncate(filled);
    Ok(tauri::ipc::Response::new(buf))
}

/// Total size (bytes) of a file — the range reader's declared file length.
#[tauri::command]
fn file_size(path: String) -> Result<u64, String> {
    std::fs::metadata(&path)
        .map(|m| m.len())
        .map_err(|e| format!("file_size({path}): {e}"))
}

/// Reveal a file in the OS file manager (Finder / Explorer / xdg-open).
#[tauri::command]
fn reveal_in_file_manager(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {}", path));
    }

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .args(["/select,", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        let parent = p.parent().unwrap_or(p);
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Open the preferences directory (~/.sleap-app) in the OS file manager.
#[tauri::command]
fn open_preferences_directory() -> Result<(), String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    let prefs_dir = home.join(".sleap-app");

    if !prefs_dir.exists() {
        std::fs::create_dir_all(&prefs_dir).map_err(|e| e.to_string())?;
    }

    let dir_str = prefs_dir.to_string_lossy().to_string();

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&dir_str)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&dir_str)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir_str)
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

/// Normalize a path by resolving `.` and `..` components without touching the
/// filesystem. Unlike `canonicalize()`, this works even if the file doesn't
/// exist yet, and doesn't resolve symlinks.
fn normalize_path(path: PathBuf) -> PathBuf {
    let mut parts: Vec<Component> = Vec::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                // Pop the last normal component, but keep prefix/root
                if matches!(parts.last(), Some(Component::Normal(_))) {
                    parts.pop();
                }
            }
            Component::CurDir => {} // skip "."
            other => parts.push(other),
        }
    }
    parts.iter().collect()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // Extract the first non-flag argument as a file path to open on launch.
  // Resolve to absolute path so the frontend FS plugin can read it.
  let file_arg = std::env::args()
      .skip(1)
      .find(|a| !a.starts_with('-'))
      .map(|p| {
          let path = PathBuf::from(&p);
          let abs = if path.is_relative() {
              std::env::current_dir()
                  .map(|cwd| cwd.join(&path))
                  .unwrap_or(path)
          } else {
              path
          };
          // Normalize to remove .. segments (Tauri FS plugin rejects them).
          // We use logical normalization instead of canonicalize() because
          // canonicalize() fails if the file doesn't exist.
          normalize_path(abs)
      })
      .map(|p| p.to_string_lossy().into_owned());
  println!("[sleap-label] file_arg: {:?}", file_arg);

  let builder = tauri::Builder::default()
    .manage(InitialFile(Mutex::new(file_arg)))
    .manage(RunningProcess(Mutex::new(None)))
    .manage(ZmqRelay(Mutex::new(None)))
    .manage(ProgressRelay(Mutex::new(None)))
    .manage(tokio::sync::Mutex::new(rtc::RtcState::new()))
    .invoke_handler(tauri::generate_handler![
        get_initial_file,
        read_image_file,
        read_range,
        file_size,
        reveal_in_file_manager,
        open_preferences_directory,
        environment::detect_uv,
        environment::detect_gpu,
        environment::list_uv_tools,
        environment::list_python_interpreters,
        environment::list_downloadable_pythons,
        environment::check_python,
        environment::install_python,
        environment::install_uv_tool,
        environment::upgrade_uv_tool,
        environment::update_uv,
        environment::install_uv,
        environment::run_python_command,
        environment::cancel_command,
        environment::start_zmq_relay,
        environment::send_training_stop,
        environment::stop_zmq_relay,
        environment::start_progress_relay,
        environment::stop_progress_relay,
        rtc::rtc_join_room,
        rtc::rtc_connect_worker,
        rtc::rtc_send,
        rtc::rtc_disconnect_worker,
        rtc::rtc_leave_room,
    ])
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    });

  // tauri-pilot: dev-only bridge that lets the `tauri-pilot` CLI drive the
  // WebView for UI inspection and automation. Registered here in the builder
  // chain (not inside `setup`) so its `js_init_script` bridge is injected
  // before the main window's webview loads. `tauri_plugin_pilot::init()` is a
  // no-op in release builds; this gate keeps it out of production entirely.
  // The conditional `let` shadows `builder` only in debug — using `let mut`
  // would warn about an unused `mut` in release, where this line is compiled out.
  // See CLAUDE.md → "Driving the desktop GUI (tauri-pilot)".
  #[cfg(debug_assertions)]
  let builder = builder.plugin(tauri_plugin_pilot::init());

  builder
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
