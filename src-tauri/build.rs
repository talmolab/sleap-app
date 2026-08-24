use tauri_build::{Attributes, DefaultPermissionRule, InlinedPlugin};

fn main() {
    // SPIKE (spike/tauri-localhost-origin): register `read_range` + `file_size` as an
    // INLINED plugin ("sleap") rather than bare app commands. From the http://localhost
    // origin the WebView is "remote", and Tauri blocks bare custom commands there; only
    // ACL-permitted PLUGIN commands are reachable. Inlining them under a plugin namespace
    // generates `sleap:allow-read-range` / `sleap:allow-file-size` (+ a `sleap:default`
    // that allows all its commands) which capabilities can grant — including a remote
    // capability. Unlike `AppManifest::commands`, an inlined plugin does NOT flip the
    // global app-ACL bit, so the app's other ~18 bare custom commands keep working on the
    // local (tauri://) build without needing per-command grants. NOTE: plugin commands are
    // ACL-checked on local too, so `sleap:default` must be granted for BOTH the local
    // origin (default.json) and the remote http://localhost origin (the runtime
    // `localhost_capability` added in lib.rs setup()).
    tauri_build::try_build(
        Attributes::new().plugin(
            "sleap",
            InlinedPlugin::new()
                // Every custom command the app needs while served from http://localhost.
                // Keep in sync with sleap_plugin()'s invoke_handler in lib.rs.
                .commands(&[
                    // file / native
                    "read_range",
                    "file_size",
                    "write_open",
                    "write_open_append",
                    "write_at",
                    "read_at",
                    "truncate_file",
                    "write_close",
                    "rename_file",
                    "copy_file",
                    "remove_file",
                    "get_initial_file",
                    "resolve_open",
                    "window_set_file",
                    "read_image_file",
                    "reveal_in_file_manager",
                    "open_preferences_directory",
                    // environment (uv / python / training)
                    "detect_uv",
                    "detect_gpu",
                    "gpu_stats",
                    "check_wandb_auth",
                    "list_uv_tools",
                    "list_python_interpreters",
                    "list_downloadable_pythons",
                    "check_python",
                    "install_python",
                    "install_uv_tool",
                    "upgrade_uv_tool",
                    "update_uv",
                    "install_uv",
                    "run_python_command",
                    "cancel_command",
                    "export_nwb",
                    "start_zmq_relay",
                    "send_training_stop",
                    "stop_zmq_relay",
                    "start_progress_relay",
                    "stop_progress_relay",
                    // rtc (remote inference)
                    "rtc_join_room",
                    "rtc_connect_worker",
                    "rtc_send",
                    "rtc_disconnect_worker",
                    "rtc_leave_room",
                ])
                .default_permission(DefaultPermissionRule::AllowAllCommands),
        ),
    )
    .expect("failed to run tauri-build");
}
