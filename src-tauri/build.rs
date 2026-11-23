use tauri_build::{Attributes, DefaultPermissionRule, InlinedPlugin};

/// Linux only (#507): `tauri.linux.conf.json` empties `externalBin` so the .deb /
/// .rpm don't install ffmpeg into /usr/bin. That also stops tauri-build from
/// copying the sidecars next to the compiled binary, which `tauri dev` (and the
/// AppImage-less local run) relies on for `Command.sidecar("binaries/ffmpeg")`.
/// Do that one copy here instead, exactly as tauri-build would have. Missing
/// sources are skipped silently (same as an un-fetched checkout before).
fn copy_linux_dev_sidecars() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("linux") {
        return;
    }
    let (Ok(target), Ok(out_dir)) = (std::env::var("TARGET"), std::env::var("OUT_DIR")) else {
        return;
    };
    // OUT_DIR = <target>/<profile>/build/<pkg>-<hash>/out -> <target>/<profile>
    let Some(profile_dir) = std::path::Path::new(&out_dir).ancestors().nth(3) else {
        return;
    };
    for tool in ["ffmpeg", "ffprobe"] {
        let src = format!("binaries/{tool}-{target}");
        if std::path::Path::new(&src).is_file() {
            // Only for files that exist: a missing path would rerun this script
            // on every build.
            println!("cargo:rerun-if-changed={src}");
            let _ = std::fs::copy(&src, profile_dir.join(tool));
        }
    }
}

fn main() {
    copy_linux_dev_sidecars();
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
                    // Linux .deb/.rpm private ffmpeg dir (#507)
                    "linux_package_tools_dir",
                    // native menu bar (macOS)
                    "set_app_menu",
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
                    "open_in_default_app",
                    "open_preferences_directory",
                    "computer_name",
                    // environment (uv / python / training)
                    "detect_uv",
                    "detect_gpu",
                    "detect_accelerator",
                    "detect_sleap_nn_extras",
                    "gpu_stats",
                    "check_wandb_auth",
                    "list_uv_tools",
                    "list_python_interpreters",
                    "list_downloadable_pythons",
                    "check_python",
                    "install_python",
                    "install_uv_tool",
                    "upgrade_uv_tool",
                    "uninstall_uv_tool",
                    "update_uv",
                    "install_uv",
                    "run_python_command",
                    "cancel_command",
                    "export_nwb",
                    "start_overlay_serve",
                    "stop_overlay_serve",
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
                    // iroh (remote inference, protocol-v1 transport)
                    "iroh_connect",
                    "iroh_send",
                    "iroh_disconnect",
                    // iroh blob range reads (item 2.4, job-result blobs)
                    "iroh_blob_open",
                    "iroh_blob_read_range",
                    "iroh_blob_close",
                    // self-update channels
                    "check_update",
                    "install_update",
                    // Claude connector (loopback MCP endpoint)
                    "mcp_start",
                    "mcp_stop",
                    "mcp_status",
                    "mcp_response",
                ])
                .default_permission(DefaultPermissionRule::AllowAllCommands),
        ),
    )
    .expect("failed to run tauri-build");
}
