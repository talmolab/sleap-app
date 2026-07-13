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

/// SPIKE (spike/tauri-localhost-origin): the inlined "sleap" plugin bundling the range
/// reader's byte-pipe commands (`read_range`, `file_size`) so they resolve as
/// `plugin:sleap|...` and stay reachable from the http://localhost (remote) origin. The
/// runtime `R` is inferred from the return type, so no `Wry` hardcoding.
fn sleap_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("sleap")
        .invoke_handler(tauri::generate_handler![
            read_range,
            file_size,
            get_initial_file,
            read_image_file,
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
        .build()
}

/// Auto-pick a free TCP port for the `http://localhost` origin. Picking a free port
/// (instead of a fixed 1430) means a port already in use — a second app instance, a
/// dev server, some other process — can't brick startup. Nothing is pinned: the
/// runtime capability (`localhost_capability`) is built for whatever port we get, and
/// the window URL uses the same value. Falls back to 1430 if the probe fails.
fn pick_localhost_port() -> u16 {
  std::net::TcpListener::bind("127.0.0.1:0")
    .and_then(|listener| listener.local_addr())
    .map(|addr| addr.port())
    .unwrap_or(1430)
}

/// Runtime replacement for the old static `capabilities/localhost.json`: grants the
/// main window's permission set to the `http://localhost:<port>` REMOTE origin for the
/// auto-picked port. A window served over http://localhost is remote context, so the
/// build-time (local) capabilities do NOT apply and every `invoke` / `plugin:sleap|…`
/// call would be blocked without this. Mirrors the static file exactly (minus the
/// editor-only `$schema`), with the dynamic port substituted. Added in `setup()`.
fn localhost_capability(port: u16) -> String {
  format!(
    r#"{{
  "identifier": "localhost-dynamic",
  "description": "Runtime grant for the http://localhost origin with an auto-picked port (tauri-plugin-localhost).",
  "local": false,
  "remote": {{ "urls": ["http://localhost:{port}"] }},
  "windows": ["main"],
  "permissions": [
    "core:default",
    "pilot:default",
    "fs:default",
    "fs:allow-read-file",
    "fs:allow-read-text-file",
    "fs:allow-write-file",
    "fs:allow-exists",
    "fs:allow-stat",
    {{ "identifier": "fs:scope", "allow": [{{ "path": "**" }}, {{ "path": "$HOME/.sleap-rtc/**" }}] }},
    "dialog:default",
    "dialog:allow-open",
    "dialog:allow-save",
    "shell:allow-open",
    "updater:default",
    "process:default",
    "core:window:allow-close",
    "core:window:allow-destroy",
    "core:window:allow-set-title",
    "sleap:default"
  ]
}}"#
  )
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

  // SPIKE (spike/tauri-localhost-origin): serve the frontend over http://localhost
  // for any BUNDLED build so WKWebView grants crossOriginIsolated (→ SharedArrayBuffer
  // for the B-seam range reader). `tauri::is_dev()` is false for both `tauri build`
  // and `tauri build --debug` (bundled assets, tauri:// scheme) and true only under
  // `tauri dev` (which already uses the Vite http origin) — it's the same signal Tauri
  // uses to pick devUrl vs bundled assets, so our window URL always matches the asset
  // mode. Escape hatch: SLEAP_ORIGIN=custom keeps the tauri:// scheme (A/B the flip).
  let use_localhost = !tauri::is_dev()
    && std::env::var("SLEAP_ORIGIN").map(|v| v != "custom").unwrap_or(true);
  // Auto-picked once here, then reused for the localhost server, the window URL, and
  // the runtime capability so all three always agree. 0 when unused (tauri:// / dev).
  let localhost_port = if use_localhost { pick_localhost_port() } else { 0 };

  let mut builder = tauri::Builder::default()
    .manage(InitialFile(Mutex::new(file_arg)))
    .manage(RunningProcess(Mutex::new(None)))
    .manage(ZmqRelay(Mutex::new(None)))
    .manage(ProgressRelay(Mutex::new(None)))
    .manage(tokio::sync::Mutex::new(rtc::RtcState::new()))
    // All native commands live in the inlined `sleap` plugin (see sleap_plugin()) so they
    // resolve as `plugin:sleap|…` and stay reachable when the app is served from the
    // http://localhost origin (bare custom commands are blocked there — see build.rs).
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    .plugin(tauri_plugin_process::init())
    // SPIKE (spike/tauri-localhost-origin): expose read_range + file_size as an INLINED
    // plugin so they're reachable from the http://localhost (remote) origin — bare custom
    // commands are blocked there (see build.rs). Command names become
    // `plugin:sleap|read_range` / `plugin:sleap|file_size` (see nativeRange.ts).
    .plugin(sleap_plugin());

  // Register the localhost HTTP server only when we actually serve over it
  // (bundled build + flag on). Inject COOP/COEP on every response — the plugin does
  // NOT set them itself, and without them the http origin wouldn't be isolated either.
  if use_localhost {
    builder = builder.plugin(
      tauri_plugin_localhost::Builder::new(localhost_port)
        .host("localhost")
        .on_request(|_req, resp| {
          resp.add_header("Cross-Origin-Opener-Policy", "same-origin");
          resp.add_header("Cross-Origin-Embedder-Policy", "require-corp");
        })
        .build(),
    );
  }

  let builder = builder.setup(move |app| {
    use tauri::Manager; // for add_capability (dynamic-acl)
    if cfg!(debug_assertions) {
      app.handle().plugin(
        tauri_plugin_log::Builder::default()
          .level(log::LevelFilter::Info)
          .build(),
      )?;
    }

    // Build the main window here (removed from tauri.conf.json) so its URL can be
    // http://localhost:PORT in release. Dev / flag-off use WebviewUrl::App, which
    // resolves to the Vite devUrl (debug) or the tauri:// scheme (release).
    // The window loads from the http://localhost:<port> REMOTE origin, so the
    // build-time (local) capabilities don't apply — grant the same permission set to
    // the auto-picked origin at runtime (replaces the old static localhost.json, which
    // could only pin a fixed port). Must be added before the window's webview loads.
    if use_localhost {
      app.add_capability(localhost_capability(localhost_port))?;
    }

    let url = if use_localhost {
      tauri::WebviewUrl::External(
        format!("http://localhost:{localhost_port}")
          .parse()
          .expect("valid localhost url"),
      )
    } else {
      tauri::WebviewUrl::App("index.html".into())
    };
    tauri::WebviewWindowBuilder::new(app, "main", url)
      .title("SLEAP")
      .inner_size(1280.0, 800.0)
      .min_inner_size(800.0, 600.0)
      .resizable(true)
      .build()?;

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

  let app = builder
    .build(tauri::generate_context!())
    .expect("error while building tauri application");

  app.run(|_app_handle, _event| {
    // macOS delivers files opened via Finder / a file association ("Open With",
    // double-click) as an Apple Event, surfaced here as RunEvent::Opened — NOT as
    // a CLI argument. Stash the first path into the same InitialFile slot the CLI
    // path uses (so a cold-start webview picks it up via get_initial_file) and
    // emit `open-file` (so an already-running window loads it immediately). Both
    // the launch poll and the event handler funnel through get_initial_file,
    // which take()s the slot, so the two can't double-load the same file.
    #[cfg(target_os = "macos")]
    {
      use tauri::{Emitter, Manager};
      if let tauri::RunEvent::Opened { urls } = _event {
        if let Some(path) = urls
          .iter()
          .filter_map(|u| u.to_file_path().ok())
          .next()
          .map(|p| p.to_string_lossy().into_owned())
        {
          println!("[sleap-label] opened file: {path}");
          *_app_handle.state::<InitialFile>().0.lock().unwrap() = Some(path);
          let _ = _app_handle.emit("open-file", ());

          // #199: bring the already-running app to the foreground so the newly
          // opened project is actually visible. Without this the file loads into
          // a window that may be minimized, hidden, or on another Space — from
          // the user's view nothing happens. On macOS `set_focus()` activates the
          // app (NSApp activate) and does makeKeyAndOrderFront, which also
          // switches to the window's Space; `unminimize()`/`show()` cover the
          // minimized/hidden cases first.
          if let Some(window) = _app_handle.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
          }
        }
      }
    }
  });
}
