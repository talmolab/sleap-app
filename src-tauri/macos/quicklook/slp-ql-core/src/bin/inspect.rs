use std::env;
use std::path::PathBuf;
use std::time::Instant;

use slp_ql_core::reader::SlpDocument;

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("Usage: slp-inspect <file.slp> [more.slp ...]");
        std::process::exit(1);
    }

    let mut ok_count = 0usize;
    let mut err_count = 0usize;

    for arg in &args {
        let path = PathBuf::from(arg);
        let t0 = Instant::now();
        match SlpDocument::open(&path) {
            Ok(doc) => {
                ok_count += 1;
                let s = doc.summary();
                let mut pose_info = String::from("-");
                let mut img_info = String::from("-");

                if let Some(first) = s
                    .preview_frames
                    .iter()
                    .find(|f| f.has_embedded_image || f.has_preview_image)
                    .or_else(|| s.preview_frames.first())
                {
                    if let Some(row_idx) = first.row_idx {
                        let tp = Instant::now();
                        match doc.frame_poses(row_idx) {
                            Ok(fp) => {
                                let npts: usize = fp.instances.iter().map(|i| i.points.len()).sum();
                                pose_info = format!(
                                    "{}inst/{}pts/{}bb ({:.2}ms)",
                                    fp.instances.len(),
                                    npts,
                                    fp.bboxes.len(),
                                    tp.elapsed().as_secs_f64() * 1000.0
                                );
                            }
                            Err(e) => pose_info = format!("ERR({e})"),
                        }
                    }

                    if first.has_embedded_image || first.has_preview_image {
                        let ti = Instant::now();
                        match doc.frame_image(first.video_idx, first.frame_idx) {
                            Ok(Some(img)) => {
                                let magic = if img.bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
                                    "PNG"
                                } else if img.bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
                                    "JPEG"
                                } else if img.kind == 1 {
                                    "RAW"
                                } else {
                                    "BIN"
                                };
                                let src = if img.is_preview { "prev" } else { "emb" };
                                img_info = format!(
                                    "{src}:{magic} {}B {}x{} (orig {}x{}) ({:.2}ms)",
                                    img.bytes.len(),
                                    img.width,
                                    img.height,
                                    img.orig_width,
                                    img.orig_height,
                                    ti.elapsed().as_secs_f64() * 1000.0
                                );
                            }
                            Ok(None) => img_info = "none".into(),
                            Err(e) => img_info = format!("ERR({e})"),
                        }
                    }
                }

                println!(
                    "OK   {:42} | fmt={:<4.1} v={:<8} | {:5}fr {:6}inst ({}u/{}p) {:2}vid(emb:{}) {:2}sk | open={:5.2}ms | pose={} | img={}",
                    s.filename,
                    s.format_id,
                    s.sleap_version,
                    s.counts.labeled_frames,
                    s.counts.instances,
                    s.counts.user_instances,
                    s.counts.predicted_instances,
                    s.counts.videos,
                    s.counts.embedded_videos,
                    s.skeletons.len(),
                    t0.elapsed().as_secs_f64() * 1000.0,
                    pose_info,
                    img_info
                );
            }
            Err(e) => {
                err_count += 1;
                println!("FAIL {:42} | {}", path.file_name().unwrap_or_default().to_string_lossy(), e);
            }
        }
    }

    println!("\nSummary: {ok_count} OK, {err_count} FAIL out of {} files", args.len());
}
