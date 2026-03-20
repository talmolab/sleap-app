mod environment;

use std::path::{Component, PathBuf};
use std::sync::Mutex;
use tauri_plugin_shell::process::CommandChild;

pub struct RunningProcess(pub Mutex<Option<CommandChild>>);

/// Holds a file path passed as a CLI argument, consumed once by the frontend.
struct InitialFile(Mutex<Option<String>>);

/// Returns (and consumes) the file path passed via CLI, if any.
#[tauri::command]
fn get_initial_file(state: tauri::State<InitialFile>) -> Option<String> {
    state.0.lock().unwrap().take()
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

  tauri::Builder::default()
    .manage(InitialFile(Mutex::new(file_arg)))
    .manage(RunningProcess(Mutex::new(None)))
    .invoke_handler(tauri::generate_handler![
        get_initial_file,
        environment::detect_uv,
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
    ])
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_shell::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
