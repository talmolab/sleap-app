//! SLEAP Share desktop backend: credential persistence (`~/.sleap-app/sleap-share.json`,
//! `0600` on Unix) and streaming presigned-PUT uploads to Cloudflare R2.
//!
//! WHY STREAM FROM RUST?
//! 1. Packaged desktop builds serve the frontend from `http://localhost:<dynamic-port>`.
//!    R2 CORS cannot wildcard dynamic ports, whereas native Rust HTTP requests bypass
//!    CORS cleanly.
//! 2. Streaming `[offset, offset+length)` directly from `tokio::fs::File` in 64 KiB
//!    chunks keeps memory usage constant for multi-GB `.pkg.slp` and companion videos,
//!    with real upload progress and instant cancellation.
//!
//! SECURITY: `validate_upload_url` restricts destinations to `https://*.r2.cloudflarestorage.com`
//! (plus loopback in debug builds for local testing) and disables HTTP redirects so a
//! compromised response cannot redirect upload bytes to an arbitrary host.

use std::collections::HashMap;
use std::io::SeekFrom;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

const UPLOAD_CHUNK_BYTES: usize = 64 * 1024;
const PROGRESS_THROTTLE: Duration = Duration::from_millis(80);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(60 * 60); // 1 hour per PUT / part

static UPLOAD_CLIENT: OnceLock<Result<reqwest::Client, String>> = OnceLock::new();

fn upload_client() -> Result<&'static reqwest::Client, String> {
    let entry = UPLOAD_CLIENT.get_or_init(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::builder()
            .user_agent("sleap-app")
            .timeout(UPLOAD_TIMEOUT)
            // Never follow redirects: prevents a 307/308 from forwarding bytes elsewhere.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| e.to_string())
    });
    entry.as_ref().map_err(Clone::clone)
}

/// Active upload cancellation flags keyed by `upload_id`.
#[derive(Default)]
pub struct SleapShareUploads(pub Mutex<HashMap<String, Arc<AtomicBool>>>);

struct UploadGuard<'a> {
    state: &'a SleapShareUploads,
    upload_id: String,
}

impl<'a> Drop for UploadGuard<'a> {
    fn drop(&mut self) {
        if let Ok(mut map) = self.state.0.lock() {
            map.remove(&self.upload_id);
        }
    }
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UploadPutResult {
    pub etag: Option<String>,
    pub status: u16,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct UploadProgressEvent {
    upload_id: String,
    loaded: u64,
    total: u64,
}

fn credentials_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or("Could not determine home directory")?;
    Ok(home.join(".sleap-app").join("sleap-share.json"))
}

fn load_credentials_from(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(content) => Ok(Some(content)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Failed to read SLEAP Share credentials: {e}")),
    }
}

fn save_credentials_to(path: &Path, json: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create credentials directory: {e}"))?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json.as_bytes())
        .map_err(|e| format!("Failed to write SLEAP Share credentials: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("Failed to chmod SLEAP Share credentials: {e}"))?;
    }
    std::fs::rename(&tmp, path)
        .map_err(|e| format!("Failed to persist SLEAP Share credentials: {e}"))?;
    Ok(())
}

fn clear_credentials_at(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Failed to remove SLEAP Share credentials: {e}")),
    }
}

#[tauri::command]
pub fn sleap_share_load_credentials() -> Result<Option<String>, String> {
    let path = credentials_path()?;
    load_credentials_from(&path)
}

#[tauri::command]
pub fn sleap_share_save_credentials(json: String) -> Result<(), String> {
    let path = credentials_path()?;
    save_credentials_to(&path, &json)
}

#[tauri::command]
pub fn sleap_share_clear_credentials() -> Result<(), String> {
    let path = credentials_path()?;
    clear_credentials_at(&path)
}

/// Allocate a unique disk-backed staging path for temporary upload artifacts
/// (e.g., freshly exported `.pkg.slp` or serialized `.slp`). Always cleaned up
/// by the caller via `remove_file`.
#[tauri::command]
pub fn sleap_share_temp_path<R: Runtime>(
    app: AppHandle<R>,
    filename: String,
) -> Result<String, String> {
    let base_dir = app
        .path()
        .app_cache_dir()
        .ok()
        .unwrap_or_else(std::env::temp_dir)
        .join("sleap-share-staging");
    std::fs::create_dir_all(&base_dir)
        .map_err(|e| format!("Failed to create upload staging dir: {e}"))?;

    let mut rand_bytes = [0u8; 8];
    getrandom::getrandom(&mut rand_bytes)
        .map_err(|e| format!("Failed to generate temp filename entropy: {e}"))?;
    let hex: String = rand_bytes.iter().map(|b| format!("{b:02x}")).collect();

    let leaf = Path::new(&filename)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("upload.slp");
    let safe: String = leaf
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .take(120)
        .collect();
    let safe = if safe.is_empty() || safe.starts_with('.') {
        "upload.slp".to_string()
    } else {
        safe
    };

    let path = base_dir.join(format!("upload-{hex}-{safe}"));
    Ok(path.to_string_lossy().into_owned())
}

/// Validate a presigned PUT destination URL (SSRF guard).
/// Release builds allow only `https://*.r2.cloudflarestorage.com`; debug/test
/// builds also allow loopback hosts (`localhost`, `127.0.0.1`, `[::1]`).
pub(crate) fn validate_upload_url(raw: &str, allow_loopback: bool) -> Result<url::Url, String> {
    let parsed = url::Url::parse(raw).map_err(|e| format!("Invalid upload URL: {e}"))?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Upload URL must not contain embedded credentials".to_string());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "Upload URL is missing a host".to_string())?
        .to_ascii_lowercase();

    let is_r2 = parsed.scheme() == "https"
        && host.ends_with(".r2.cloudflarestorage.com")
        && host.len() > ".r2.cloudflarestorage.com".len();
    if is_r2 {
        return Ok(parsed);
    }

    let is_loopback = matches!(parsed.scheme(), "http" | "https")
        && matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]" | "::1");
    if allow_loopback && is_loopback {
        return Ok(parsed);
    }

    Err(format!("Refusing upload to disallowed host: {host}"))
}

async fn upload_file_impl<F>(
    presigned_url: &str,
    file_path: &Path,
    content_type: Option<&str>,
    offset: Option<u64>,
    length: Option<u64>,
    cancel_flag: Arc<AtomicBool>,
    allow_loopback: bool,
    mut on_progress: F,
) -> Result<UploadPutResult, String>
where
    F: FnMut(u64, u64) + Send + 'static,
{
    let url = validate_upload_url(presigned_url, allow_loopback)?;

    let mut file = tokio::fs::File::open(file_path)
        .await
        .map_err(|e| format!("Failed to open file for upload: {e}"))?;
    let meta = file
        .metadata()
        .await
        .map_err(|e| format!("Failed to stat file for upload: {e}"))?;
    let file_len = meta.len();

    let start = offset.unwrap_or(0);
    if start > file_len {
        return Err(format!(
            "Upload offset {start} exceeds file length {file_len}"
        ));
    }
    let remaining_in_file = file_len - start;
    let total = match length {
        Some(len) => {
            if len > remaining_in_file {
                return Err(format!(
                    "Upload slice [{start}, + {len}) exceeds file length {file_len}"
                ));
            }
            len
        }
        None => remaining_in_file,
    };

    file.seek(SeekFrom::Start(start))
        .await
        .map_err(|e| format!("Failed to seek file for upload: {e}"))?;

    let client = upload_client()?;
    let mut req = client.put(url).header("Content-Length", total);
    if let Some(ct) = content_type {
        if !ct.trim().is_empty() {
            req = req.header("Content-Type", ct);
        }
    }

    if total == 0 {
        on_progress(0, 0);
        req = req.body(Vec::<u8>::new());
    } else {
        struct StreamState<F> {
            file: tokio::fs::File,
            remaining: u64,
            loaded: u64,
            total: u64,
            cancel: Arc<AtomicBool>,
            last_emit: Instant,
            on_progress: F,
        }

        let state = StreamState {
            file,
            remaining: total,
            loaded: 0,
            total,
            cancel: cancel_flag.clone(),
            last_emit: Instant::now() - PROGRESS_THROTTLE,
            on_progress,
        };

        let body_stream = futures_util::stream::unfold(state, |mut st| async move {
            if st.remaining == 0 {
                return None;
            }
            if st.cancel.load(Ordering::Relaxed) {
                return Some((
                    Err(std::io::Error::new(
                        std::io::ErrorKind::Interrupted,
                        "Upload cancelled",
                    )),
                    st,
                ));
            }
            let to_read = (st.remaining as usize).min(UPLOAD_CHUNK_BYTES);
            let mut buf = vec![0u8; to_read];
            match st.file.read(&mut buf).await {
                Ok(0) => Some((
                    Err(std::io::Error::new(
                        std::io::ErrorKind::UnexpectedEof,
                        "Unexpected EOF while reading upload file",
                    )),
                    st,
                )),
                Ok(n) => {
                    buf.truncate(n);
                    st.remaining -= n as u64;
                    st.loaded += n as u64;
                    if st.remaining == 0 || st.last_emit.elapsed() >= PROGRESS_THROTTLE {
                        (st.on_progress)(st.loaded, st.total);
                        st.last_emit = Instant::now();
                    }
                    Some((Ok(buf), st))
                }
                Err(e) => Some((Err(e), st)),
            }
        });

        req = req.body(reqwest::Body::wrap_stream(body_stream));
    }

    let response = req.send().await.map_err(|e| {
        if cancel_flag.load(Ordering::Relaxed) {
            "Upload cancelled".to_string()
        } else {
            format!("Upload request failed: {e}")
        }
    })?;

    let status = response.status().as_u16();
    let etag = response
        .headers()
        .get("etag")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim().trim_matches('"').to_string());

    if !response.status().is_success() {
        let body_text = response.text().await.unwrap_or_default();
        let snippet: String = body_text.chars().take(240).collect();
        return Err(if snippet.is_empty() {
            format!("Storage upload failed with HTTP {status}")
        } else {
            format!("Storage upload failed with HTTP {status}: {snippet}")
        });
    }

    Ok(UploadPutResult { etag, status })
}

#[tauri::command]
pub async fn sleap_share_upload_file<R: Runtime>(
    app: AppHandle<R>,
    state: tauri::State<'_, SleapShareUploads>,
    upload_id: String,
    presigned_url: String,
    file_path: String,
    content_type: Option<String>,
    offset: Option<u64>,
    length: Option<u64>,
) -> Result<UploadPutResult, String> {
    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut map = state.0.lock().map_err(|e| e.to_string())?;
        map.insert(upload_id.clone(), cancel_flag.clone());
    }
    let _guard = UploadGuard {
        state: state.inner(),
        upload_id: upload_id.clone(),
    };

    let emit_id = upload_id.clone();
    let app_clone = app.clone();
    upload_file_impl(
        &presigned_url,
        Path::new(&file_path),
        content_type.as_deref(),
        offset,
        length,
        cancel_flag,
        cfg!(debug_assertions),
        move |loaded, total| {
            let _ = app_clone.emit(
                "sleap-share-upload-progress",
                UploadProgressEvent {
                    upload_id: emit_id.clone(),
                    loaded,
                    total,
                },
            );
        },
    )
    .await
}

#[tauri::command]
pub fn sleap_share_cancel_upload(
    state: tauri::State<'_, SleapShareUploads>,
    upload_id: String,
) -> Result<(), String> {
    let map = state.0.lock().map_err(|e| e.to_string())?;
    if let Some(flag) = map.get(&upload_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_upload_url_enforces_r2_allowlist() {
        assert!(validate_upload_url(
            "https://sleap-share-prod.abc123.r2.cloudflarestorage.com/abc123/labels.slp?X-Amz-Signature=1",
            false
        )
        .is_ok());

        // Reject non-R2 hosts, HTTP R2, credentials, bare suffix, and loopback in release
        for bad in [
            "http://sleap-share-prod.abc123.r2.cloudflarestorage.com/key",
            "https://r2.cloudflarestorage.com/key",
            "https://.r2.cloudflarestorage.com/key",
            "https://evil.example/key",
            "https://r2.cloudflarestorage.com.evil.example/key",
            "https://user:pass@bucket.r2.cloudflarestorage.com/key",
            "http://127.0.0.1:8787/upload",
            "file:///etc/passwd",
        ] {
            assert!(
                validate_upload_url(bad, false).is_err(),
                "expected {bad} to be rejected in release"
            );
        }

        // Debug mode allows loopback for local testing
        assert!(validate_upload_url("http://127.0.0.1:8787/upload", true).is_ok());
        assert!(validate_upload_url("http://localhost:8787/upload", true).is_ok());
        assert!(validate_upload_url("https://evil.example/upload", true).is_err());
    }

    #[test]
    fn credentials_round_trip_and_clear() {
        let dir = std::env::temp_dir().join(format!("sleap_share_creds_{}", std::process::id()));
        let path = dir.join("sleap-share.json");
        let _ = clear_credentials_at(&path);

        assert_eq!(load_credentials_from(&path).unwrap(), None);
        save_credentials_to(&path, r#"{"token":"slp_test","username":"alice"}"#).unwrap();
        assert_eq!(
            load_credentials_from(&path).unwrap().as_deref(),
            Some(r#"{"token":"slp_test","username":"alice"}"#)
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }

        clear_credentials_at(&path).unwrap();
        assert_eq!(load_credentials_from(&path).unwrap(), None);
        // Second clear is idempotent
        clear_credentials_at(&path).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn streaming_upload_streams_byte_range_and_returns_etag() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let addr = server.server_addr().to_ip().unwrap();
        let received = Arc::new(Mutex::new((Vec::<u8>::new(), Option::<String>::None)));
        let received_srv = received.clone();

        let srv_handle = std::thread::spawn(move || {
            let mut req = server.recv().unwrap();
            let ct = req
                .headers()
                .iter()
                .find(|h| h.field.equiv("Content-Type"))
                .map(|h| h.value.as_str().to_string());
            let mut body = Vec::new();
            req.as_reader().read_to_end(&mut body).unwrap();
            *received_srv.lock().unwrap() = (body, ct);
            let resp = tiny_http::Response::empty(200)
                .with_header(tiny_http::Header::from_bytes("ETag", "\"etag-part-2\"").unwrap());
            req.respond(resp).unwrap();
        });

        let tmp = std::env::temp_dir().join(format!("sleap_share_put_{}.bin", std::process::id()));
        let payload: Vec<u8> = (0u8..=255).cycle().take(150_000).collect();
        std::fs::write(&tmp, &payload).unwrap();

        let progress_calls = Arc::new(Mutex::new(Vec::<(u64, u64)>::new()));
        let pc = progress_calls.clone();

        let url = format!("http://127.0.0.1:{}/part2", addr.port());
        let res = upload_file_impl(
            &url,
            &tmp,
            Some("application/octet-stream"),
            Some(10_000),
            Some(80_000),
            Arc::new(AtomicBool::new(false)),
            true,
            move |loaded, total| {
                pc.lock().unwrap().push((loaded, total));
            },
        )
        .await
        .unwrap();

        srv_handle.join().unwrap();
        let _ = std::fs::remove_file(&tmp);

        assert_eq!(res.status, 200);
        assert_eq!(res.etag.as_deref(), Some("etag-part-2"));

        let (body, ct) = received.lock().unwrap().clone();
        assert_eq!(body.len(), 80_000);
        assert_eq!(body, payload[10_000..90_000]);
        assert_eq!(ct.as_deref(), Some("application/octet-stream"));

        let prog = progress_calls.lock().unwrap();
        assert!(!prog.is_empty());
        assert_eq!(prog.last().copied(), Some((80_000, 80_000)));
    }
}
