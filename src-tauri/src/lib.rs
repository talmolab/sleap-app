use std::sync::Mutex;

/// Holds a file path passed as a CLI argument, consumed once by the frontend.
struct InitialFile(Mutex<Option<String>>);

/// Returns (and consumes) the file path passed via CLI, if any.
#[tauri::command]
fn get_initial_file(state: tauri::State<InitialFile>) -> Option<String> {
    state.0.lock().unwrap().take()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // Extract the first non-flag argument as a file path to open on launch.
  // Resolve to absolute path so the frontend FS plugin can read it.
  let file_arg = std::env::args()
      .skip(1)
      .find(|a| !a.starts_with('-'))
      .map(|p| {
          let path = std::path::PathBuf::from(&p);
          if path.is_relative() {
              std::env::current_dir()
                  .map(|cwd| cwd.join(&path))
                  .unwrap_or(path)
          } else {
              path
          }
      })
      .map(|p| p.to_string_lossy().into_owned());
  println!("[sleap-label] file_arg: {:?}", file_arg);

  tauri::Builder::default()
    .manage(InitialFile(Mutex::new(file_arg)))
    .invoke_handler(tauri::generate_handler![get_initial_file])
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
