mod environment;
mod rtc;

use std::collections::HashMap;
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

/// SPIKE (spike/write-bseam): holds the single, persistent read-write file handle for the
/// "write B-seam" feasibility spike. Unlike `read_range` (which opens the file fresh on
/// every call), HDF5's seek-back-and-patch write pattern needs writes and reads to hit the
/// SAME open `std::fs::File` descriptor so reads observe prior writes reliably via the OS
/// page cache. Only one save is in flight at a time, hence a single slot (not a map).
struct WriteHandle(Mutex<Option<std::fs::File>>);

/// Open (or re-create) the file backing the write B-seam and stash it as the single
/// persistent read-write handle used by `write_at` / `read_at` / `truncate_file`.
/// `create(true).truncate(true)` mirrors starting a fresh save file.
#[tauri::command]
fn write_open(state: tauri::State<WriteHandle>, path: String) -> Result<(), String> {
    // Ensure the parent directory exists — the streaming writer may stage into a
    // freshly-resolved local dir (e.g. the app cache dir) that hasn't been
    // created yet. create_dir_all is a no-op when it already exists.
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("write_open({path}): create parent dir: {e}"))?;
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true)
        .open(&path)
        .map_err(|e| format!("write_open({path}): {e}"))?;
    let mut guard = state.0.lock().map_err(|e| format!("write_open({path}): {e}"))?;
    *guard = Some(file);
    Ok(())
}

/// SPIKE (spike/write-bseam): open an EXISTING file for append (no truncate) and stash it
/// as the single persistent read-write handle, like `write_open` but WITHOUT
/// `.truncate(true)` — the file's existing bytes stay intact on disk. Used by the
/// streaming writer's dual-bridge dest-file open, where the destination already has
/// content (e.g. the small pose-table half already written on the main thread) that the
/// append phase must read AND extend, never clobber.
#[tauri::command]
fn write_open_append(state: tauri::State<WriteHandle>, path: String) -> Result<(), String> {
    if let Some(parent) = std::path::Path::new(&path).parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("write_open_append({path}): create parent dir: {e}"))?;
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .open(&path)
        .map_err(|e| format!("write_open_append({path}): {e}"))?;
    let mut guard = state.0.lock().map_err(|e| format!("write_open_append({path}): {e}"))?;
    *guard = Some(file);
    Ok(())
}

/// Write bytes at an absolute offset into the held write-B-seam handle.
///
/// Bytes travel over the **raw binary IPC channel** (never a JSON number-array — that's
/// ~10x size blowup and would make the large-file stage of this spike unusable). To avoid
/// mixing a numeric `offset` arg with a raw body (Tauri commands take either all-JSON args
/// or a single raw `Request` body, not both), the JS caller prepends the offset as an
/// 8-byte little-endian `u64` to the front of the raw body: `[offset:8][payload bytes...]`.
#[tauri::command]
fn write_at(state: tauri::State<WriteHandle>, request: tauri::ipc::Request) -> Result<(), String> {
    use std::io::{Seek, SeekFrom, Write};
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => bytes,
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("write_at: expected a raw binary body, got JSON".to_string());
        }
    };
    if bytes.len() < 8 {
        return Err(format!(
            "write_at: body too short for an 8-byte offset prefix ({} bytes)",
            bytes.len()
        ));
    }
    let offset = u64::from_le_bytes(bytes[0..8].try_into().unwrap());
    let payload = &bytes[8..];

    let mut guard = state.0.lock().map_err(|e| format!("write_at({offset}): {e}"))?;
    let file = guard
        .as_mut()
        .ok_or_else(|| format!("write_at({offset}): no open write handle (call write_open first)"))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("write_at seek({offset}): {e}"))?;
    file.write_all(payload)
        .map_err(|e| format!("write_at write({offset}): {e}"))?;
    Ok(())
}

/// Read back `[offset, offset+length)` from the SAME open write-B-seam handle (not a fresh
/// `std::fs::File::open` like `read_range`), so reads see writes made via `write_at` on this
/// handle. Mirrors `read_range`'s seek + looped read + short-read-at-EOF behavior exactly.
#[tauri::command]
fn read_at(state: tauri::State<WriteHandle>, offset: u64, length: u32) -> Result<tauri::ipc::Response, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut guard = state.0.lock().map_err(|e| format!("read_at({offset}): {e}"))?;
    let file = guard
        .as_mut()
        .ok_or_else(|| format!("read_at({offset}): no open write handle (call write_open first)"))?;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("read_at seek({offset}): {e}"))?;
    let mut buf = vec![0u8; length as usize];
    let mut filled = 0usize;
    while filled < buf.len() {
        match file.read(&mut buf[filled..]) {
            Ok(0) => break, // EOF
            Ok(n) => filled += n,
            Err(e) => return Err(format!("read_at read: {e}")),
        }
    }
    buf.truncate(filled);
    Ok(tauri::ipc::Response::new(buf))
}

/// Truncate (or extend) the held write-B-seam handle to exactly `length` bytes.
#[tauri::command]
fn truncate_file(state: tauri::State<WriteHandle>, length: u64) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|e| format!("truncate_file({length}): {e}"))?;
    let file = guard
        .as_mut()
        .ok_or_else(|| format!("truncate_file({length}): no open write handle (call write_open first)"))?;
    file.set_len(length)
        .map_err(|e| format!("truncate_file({length}): {e}"))
}

/// Flush and close the held write-B-seam handle, freeing the slot for the next save.
#[tauri::command]
fn write_close(state: tauri::State<WriteHandle>) -> Result<(), String> {
    use std::io::Write;
    let mut guard = state.0.lock().map_err(|e| format!("write_close: {e}"))?;
    if let Some(mut file) = guard.take() {
        file.flush().map_err(|e| format!("write_close: {e}"))?;
        // `file` drops here, closing the OS descriptor.
    }
    Ok(())
}

/// Atomically replace `to` with `from` on the same filesystem (`std::fs::rename`). Used by
/// the streaming pkg.slp writer (Phase 3) to swap a verified-complete temp file over the
/// real destination as the LAST step of a save — the original `to` is only ever destroyed
/// by this rename, and only after the temp has been fully written and independently
/// verified, so a failure anywhere before this call leaves the original untouched.
#[tauri::command]
fn rename_file(from: String, to: String) -> Result<(), String> {
    std::fs::rename(&from, &to).map_err(|e| format!("rename_file({from} -> {to}): {e}"))
}

/// Bulk sequential copy `from` -> `to` (`std::fs::copy`, one streamed pass). Used by the
/// streaming pkg.slp writer's local-temp-staging path: the file is built AND verified on
/// LOCAL disk (many small, latency-cheap ops), then copied to the possibly-network
/// destination in ONE sequential pass. `std::fs::rename` can't cross filesystems, so a
/// local→network publish needs a copy; doing it as a single sequential transfer is
/// throughput-bound (fast even over SMB) instead of paying per-op network latency for the
/// writer's many scattered reads/writes. Overwrites `to` if it exists.
#[tauri::command]
fn copy_file(from: String, to: String) -> Result<(), String> {
    std::fs::copy(&from, &to)
        .map(|_| ())
        .map_err(|e| format!("copy_file({from} -> {to}): {e}"))
}

/// Delete a file (`std::fs::remove_file`). Used by the streaming pkg.slp writer's cleanup
/// path to FULLY remove temp/stage files on failure (and the local stage file on success),
/// instead of leaving 0-byte `*.sleap-tmp-*` stubs behind. A missing file is treated as
/// success so cleanup is idempotent and never masks the real error.
#[tauri::command]
fn remove_file(path: String) -> Result<(), String> {
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove_file({path}): {e}")),
    }
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

/// Cross-window "open file" registry: window label -> the canonical `.slp` path
/// that window currently has open (`None` = empty / Welcome screen). Each
/// WebviewWindow is an isolated JS heap, so this shared Rust map is the ONLY
/// place that can answer "is this file already open, and in which window?". Kept
/// in sync by the frontend (`window_set_file`) and self-healed on window close
/// (`on_window_event` -> `Destroyed`).
struct WindowFiles(Mutex<HashMap<String, Option<String>>>);

/// Canonical dedup key for a path: resolve symlinks + `.`/`..` and make it
/// absolute so `./a.slp`, an absolute path, and a symlink to it all collapse to
/// one key. Falls back to logical `normalize_path` when the file can't be
/// canonicalized (e.g. it no longer exists), so a key is always produced.
fn canonical_key(path: &str) -> String {
    let p = PathBuf::from(path);
    match std::fs::canonicalize(&p) {
        Ok(c) => c.to_string_lossy().into_owned(),
        Err(_) => {
            let abs = if p.is_relative() {
                std::env::current_dir().map(|cwd| cwd.join(&p)).unwrap_or(p)
            } else {
                p
            };
            normalize_path(abs).to_string_lossy().into_owned()
        }
    }
}

/// What the frontend should do with an "open this path" request (see
/// `resolve_open`). `action` is `"focus"` (already open — jump to `label`),
/// `"reuse"` (load into the empty window `label`), or `"new"` (spawn a window).
#[derive(serde::Serialize)]
struct Resolution {
    action: String,
    label: Option<String>,
}

/// Pure routing decision over the label->file map. Split out from the command so
/// it can be unit-tested without Tauri state or the filesystem. `key` is already
/// canonicalized; map values are canonical paths (or `None` for empty windows).
fn resolve_open_impl(
    map: &HashMap<String, Option<String>>,
    key: &str,
    prefer_label: Option<&str>,
) -> Resolution {
    // 1. Already open in some window -> focus it (dedup). Pick deterministically
    //    (smallest label) if two windows somehow hold the same path.
    let mut open_here: Vec<&String> = map
        .iter()
        .filter(|(_, p)| p.as_deref() == Some(key))
        .map(|(l, _)| l)
        .collect();
    open_here.sort();
    if let Some(label) = open_here.first() {
        return Resolution { action: "focus".into(), label: Some((*label).clone()) };
    }
    // 2. The calling window is empty -> load in place there.
    if let Some(pl) = prefer_label {
        if matches!(map.get(pl), Some(None)) {
            return Resolution { action: "reuse".into(), label: Some(pl.to_string()) };
        }
    }
    // 3. Some other window is empty -> reuse it (deterministic: smallest label).
    let mut empties: Vec<&String> =
        map.iter().filter(|(_, p)| p.is_none()).map(|(l, _)| l).collect();
    empties.sort();
    if let Some(label) = empties.first() {
        return Resolution { action: "reuse".into(), label: Some((*label).clone()) };
    }
    // 4. Nothing open, nothing empty -> spawn a new window.
    Resolution { action: "new".into(), label: None }
}

/// Decide where an "open this path" request should go, given the current
/// window->file registry. `prefer_label` is the calling window's label (so an
/// empty caller loads in place rather than spawning a window).
#[tauri::command]
fn resolve_open(
    state: tauri::State<WindowFiles>,
    path: String,
    prefer_label: Option<String>,
) -> Resolution {
    let key = canonical_key(&path);
    let map = state.0.lock().unwrap();
    resolve_open_impl(&map, &key, prefer_label.as_deref())
}

/// Record the file a window currently has open (`None` = empty / Welcome). One
/// call covers initial load, Save-As (path change) and close-to-Welcome (clear).
/// Paths are canonicalized so the key matches `resolve_open`'s lookups.
#[tauri::command]
fn window_set_file(state: tauri::State<WindowFiles>, label: String, path: Option<String>) {
    let key = path.map(|p| canonical_key(&p));
    state.0.lock().unwrap().insert(label, key);
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
            write_open,
            write_open_append,
            write_at,
            read_at,
            truncate_file,
            write_close,
            rename_file,
            copy_file,
            remove_file,
            get_initial_file,
            resolve_open,
            window_set_file,
            read_image_file,
            reveal_in_file_manager,
            open_preferences_directory,
            environment::detect_uv,
            environment::detect_gpu,
            environment::gpu_stats,
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
            environment::export_nwb,
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

/// Path of the file that remembers the localhost port between launches
/// (`~/.sleap-app/localhost-port`).
fn localhost_port_file() -> Option<PathBuf> {
  dirs::home_dir().map(|h| h.join(".sleap-app").join("localhost-port"))
}

/// Can we currently bind `127.0.0.1:<port>` (i.e. is the port free)? There's an
/// inherent TOCTOU gap before the localhost plugin rebinds it — the same gap
/// `pick_localhost_port` already has — but the window is tiny for a desktop-local port.
fn port_is_free(port: u16) -> bool {
  port != 0 && std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// Resolve the localhost origin port, PREFERRING a previously persisted port so the
/// app's origin (`http://localhost:<port>`) stays STABLE across launches. WKWebView,
/// WebKitGTK, and WebView2 all key `localStorage` + `IndexedDB` by origin *including the
/// port*, so a fresh random port every launch would silently reset persisted UI prefs,
/// the selected Python env, connect settings, and auth tokens. We remember the chosen
/// port in `~/.sleap-app/localhost-port` and reuse it while it's still free; only if it's
/// taken (a second instance, some other process) do we pick a new free port and rewrite
/// the file. File I/O is best-effort — any failure just falls through to a fresh pick.
fn resolve_localhost_port() -> u16 {
  let port_file = localhost_port_file();

  // Reuse the saved port when it parses and is still bindable.
  if let Some(saved) = port_file
    .as_ref()
    .and_then(|p| std::fs::read_to_string(p).ok())
    .and_then(|s| s.trim().parse::<u16>().ok())
    .filter(|&p| port_is_free(p))
  {
    return saved;
  }

  // No usable saved port: pick a fresh free one and persist it (best-effort).
  let port = pick_localhost_port();
  if let Some(path) = port_file {
    if let Some(parent) = path.parent() {
      let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(&path, port.to_string());
  }
  port
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
  "windows": ["main*"],
  "permissions": [
    "core:default",
    "pilot:default",
    "fs:default",
    "fs:allow-read-file",
    "fs:allow-read-text-file",
    "fs:allow-write-file",
    "fs:allow-write-text-file",
    "fs:allow-mkdir",
    "fs:allow-remove",
    "fs:allow-exists",
    "fs:allow-stat",
    {{ "identifier": "fs:scope", "allow": [{{ "path": "**" }}, {{ "path": "$HOME/.sleap-rtc/**" }}] }},
    "dialog:default",
    "dialog:allow-open",
    "dialog:allow-save",
    "shell:allow-open",
    {{
      "identifier": "shell:allow-execute",
      "allow": [
        {{ "name": "binaries/ffmpeg", "sidecar": true, "args": true }},
        {{ "name": "binaries/ffprobe", "sidecar": true, "args": true }}
      ]
    }},
    "updater:default",
    "process:default",
    "core:window:allow-close",
    "core:window:allow-destroy",
    "core:window:allow-set-title",
    "core:window:allow-set-focus",
    "core:window:allow-show",
    "core:window:allow-unminimize",
    "core:webview:allow-create-webview-window",
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
  // WebKitGTK gates SharedArrayBuffer behind a JavaScriptCore runtime option: even a
  // fully cross-origin-isolated page (COOP+COEP over the localhost origin;
  // `crossOriginIsolated === true`) gets NO SharedArrayBuffer constructor without it
  // (verified on WebKitGTK 2.52.3). Same mechanism GNOME Web uses to opt in. Must be
  // in our env before the first WebView spawns its WebKitWebProcess, which inherits it.
  #[cfg(target_os = "linux")]
  std::env::set_var("JSC_useSharedArrayBuffer", "1");
  // Resolved once here (persisted port reused when free, else a fresh free pick), then
  // reused for the localhost server, the window URL, and the runtime capability so all
  // three always agree. A STABLE port keeps the origin stable across launches, which is
  // what preserves origin-scoped localStorage/IndexedDB (prefs, Python env, auth). 0
  // when unused (tauri:// / dev).
  let localhost_port = if use_localhost { resolve_localhost_port() } else { 0 };

  let mut builder = tauri::Builder::default()
    .manage(InitialFile(Mutex::new(file_arg)))
    .manage(RunningProcess(Mutex::new(None)))
    .manage(ZmqRelay(Mutex::new(None)))
    .manage(ProgressRelay(Mutex::new(None)))
    .manage(WriteHandle(Mutex::new(None)))
    .manage(WindowFiles(Mutex::new(HashMap::new())))
    .manage(tokio::sync::Mutex::new(rtc::RtcState::new()))
    // Self-heal the open-file registry: when a window is destroyed (closed or
    // crashed) drop its claim so a later open can't be mis-routed to a dead
    // window. The frontend keeps the map otherwise (window_set_file).
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::Destroyed = event {
        use tauri::Manager;
        window.state::<WindowFiles>().0.lock().unwrap().remove(window.label());
        // Mark the diagnostics session clean on graceful window destroy by
        // removing the "running" sentinel. A crash / freeze / force-kill never
        // runs this handler, so the sentinel survives → the next launch offers
        // to send diagnostics. (Sync + fast, so it lands before the process exits.)
        if let Ok(dir) = window.app_handle().path().app_local_data_dir() {
          let _ = std::fs::remove_file(dir.join("sleap-logs").join("session.running"));
        }
      }
    })
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

    // macOS: the default app menu ships an Edit ▸ Undo/Redo bound to ⌘Z / ⌘⇧Z.
    // Those NATIVE accelerators intercept the keystroke before it reaches the
    // WebView, so the web app's own undo/redo handler never fired (⌘Z did nothing
    // in the bundled app). Install a custom menu WITHOUT Undo/Redo — keeping the
    // standard app/window items and cut/copy/paste/select-all for text fields — so
    // ⌘Z / ⌘⇧Z fall through to the app's own keyboard handler.
    #[cfg(target_os = "macos")]
    {
      use tauri::menu::{MenuBuilder, SubmenuBuilder};
      let app_menu = SubmenuBuilder::new(app, "SLEAP")
        .about(None)
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
      let edit_menu = SubmenuBuilder::new(app, "Edit")
        // Intentionally NO .undo()/.redo() — see the comment above.
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
      let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .separator()
        .close_window()
        .build()?;
      let menu = MenuBuilder::new(app)
        .item(&app_menu)
        .item(&edit_menu)
        .item(&window_menu)
        .build()?;
      app.set_menu(menu)?;
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
    // emit `open-file` (so an already-running window handles it immediately). The
    // frontend `open-file` listener drains the slot and routes the path through
    // `resolve_open` (openOrFocusPath): if the file is already open it focuses
    // that window; if a window is empty it loads there; otherwise it spawns a new
    // window — so a running project is never clobbered. Focus/foreground is now
    // handled by that routing (it set_focus()es the target window), so we no
    // longer force-focus the hardcoded `main` window here (#199 is preserved by
    // the target-window focus in openOrFocusPath). The launch poll and the
    // listener both funnel through get_initial_file, which take()s the slot, so
    // they can't double-load the same file.
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
        }
      }
    }
  });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(entries: &[(&str, Option<&str>)]) -> HashMap<String, Option<String>> {
        entries
            .iter()
            .map(|(l, p)| (l.to_string(), p.map(|s| s.to_string())))
            .collect()
    }

    #[test]
    fn focus_when_file_already_open() {
        let m = map(&[("w1", Some("/a.slp")), ("w2", None)]);
        // Even though the caller (w2) is empty, an existing open window wins.
        let r = resolve_open_impl(&m, "/a.slp", Some("w2"));
        assert_eq!(r.action, "focus");
        assert_eq!(r.label.as_deref(), Some("w1"));
    }

    #[test]
    fn reuse_caller_when_caller_is_empty() {
        let m = map(&[("w1", Some("/a.slp")), ("w2", None)]);
        let r = resolve_open_impl(&m, "/b.slp", Some("w2"));
        assert_eq!(r.action, "reuse");
        assert_eq!(r.label.as_deref(), Some("w2"));
    }

    #[test]
    fn reuse_other_empty_when_caller_busy() {
        // Caller w1 has a project; a different empty window (w2) should be reused
        // so the caller's project is never clobbered.
        let m = map(&[("w1", Some("/a.slp")), ("w2", None)]);
        let r = resolve_open_impl(&m, "/b.slp", Some("w1"));
        assert_eq!(r.action, "reuse");
        assert_eq!(r.label.as_deref(), Some("w2"));
    }

    #[test]
    fn new_window_when_none_open_and_none_empty() {
        let m = map(&[("w1", Some("/a.slp"))]);
        let r = resolve_open_impl(&m, "/b.slp", Some("w1"));
        assert_eq!(r.action, "new");
        assert_eq!(r.label, None);
    }

    #[test]
    fn empty_window_pick_is_deterministic() {
        // Two empty windows, caller not in the map → smallest label wins.
        let m = map(&[("w3", None), ("w2", None)]);
        let r = resolve_open_impl(&m, "/b.slp", Some("nope"));
        assert_eq!(r.action, "reuse");
        assert_eq!(r.label.as_deref(), Some("w2"));
    }

    #[test]
    fn empty_registry_opens_new() {
        let m: HashMap<String, Option<String>> = HashMap::new();
        let r = resolve_open_impl(&m, "/a.slp", Some("w1"));
        assert_eq!(r.action, "new");
    }

    #[test]
    fn canonical_key_normalizes_dot_dot_for_missing_path() {
        // A non-existent path can't be canonicalized, so the logical-normalize
        // fallback collapses `..` (and keeps it absolute).
        let k = canonical_key("/tmp/sub/../does-not-exist-xyz.slp");
        assert_eq!(k, "/tmp/does-not-exist-xyz.slp");
    }

    #[test]
    fn canonical_key_dedups_two_spellings_of_same_file() {
        // Two spellings of the SAME existing file must produce one key so dedup
        // works. Use a real temp file so canonicalize() runs (not the fallback):
        // both the direct path and a `.`-laden spelling fully exist, so both
        // resolve to the same absolute, symlink-free path (e.g. macOS
        // /var/folders/... -> /private/var/folders/...). canonicalize() requires
        // EVERY component to exist, which is why we don't inject a fake `nested/`.
        let dir = std::env::temp_dir();
        let file = dir.join("sleap_canon_test.slp");
        std::fs::write(&file, b"x").unwrap();
        let direct = file.to_string_lossy().into_owned();
        let dotted = dir
            .join(".")
            .join("sleap_canon_test.slp")
            .to_string_lossy()
            .into_owned();
        assert_eq!(canonical_key(&direct), canonical_key(&dotted));
        let _ = std::fs::remove_file(&file);
    }
}
