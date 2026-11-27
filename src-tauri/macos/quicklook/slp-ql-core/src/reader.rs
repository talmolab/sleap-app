use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Instant;

use hdf5_reader::group::Group;
use hdf5_reader::{
    dtype_element_size, ByteOrder, CompoundField, Dataset, Datatype, H5Type, Hdf5File,
    OpenOptions, SliceInfo, SliceInfoElem,
};
use serde_json::Value;

use crate::types::{
    BBoxPose, CountsInfo, DecodedImage, FramePoses, InstancePose, PointPose, PreviewFrameEntry,
    SkeletonInfo, SlpSummary, VideoInfo,
};

const SLP_FORMAT_ID_LIMIT: f64 = 4.0;

/// Raw element adapter so `hdf5_reader::Dataset::read_slice` can slice ANY fixed-size
/// HDF5 datatype (compound rows, vlen 16-byte refs, enums, etc.) without reading the
/// whole dataset.
#[derive(Clone, Debug)]
struct RawElem(Vec<u8>);

impl H5Type for RawElem {
    fn hdf5_type() -> Datatype {
        Datatype::Opaque {
            size: 1,
            tag: String::new(),
        }
    }

    fn from_bytes(bytes: &[u8], _dtype: &Datatype) -> hdf5_reader::error::Result<Self> {
        Ok(RawElem(bytes.to_vec()))
    }

    fn element_size(dtype: &Datatype) -> usize {
        dtype_element_size(dtype).unwrap_or(1)
    }
}

/// Flexible numeric decoder that coerces any integer/float/enum/bool HDF5 scalar to f64.
#[derive(Clone, Copy, Debug)]
struct AnyF64(f64);

impl H5Type for AnyF64 {
    fn hdf5_type() -> Datatype {
        Datatype::FloatingPoint {
            size: 8,
            byte_order: ByteOrder::LittleEndian,
        }
    }

    fn from_bytes(bytes: &[u8], dtype: &Datatype) -> hdf5_reader::error::Result<Self> {
        decode_numeric_f64(bytes, dtype).map(AnyF64)
    }

    fn element_size(dtype: &Datatype) -> usize {
        dtype_element_size(dtype).unwrap_or(8)
    }
}

fn decode_numeric_f64(bytes: &[u8], dtype: &Datatype) -> hdf5_reader::error::Result<f64> {
    match dtype {
        Datatype::FloatingPoint { size, byte_order } => {
            let le = *byte_order != ByteOrder::BigEndian;
            match size {
                4 if bytes.len() >= 4 => {
                    let b: [u8; 4] = bytes[..4].try_into().unwrap();
                    Ok(if le {
                        f32::from_le_bytes(b)
                    } else {
                        f32::from_be_bytes(b)
                    } as f64)
                }
                8 if bytes.len() >= 8 => {
                    let b: [u8; 8] = bytes[..8].try_into().unwrap();
                    Ok(if le {
                        f64::from_le_bytes(b)
                    } else {
                        f64::from_be_bytes(b)
                    })
                }
                _ => Ok(f64::NAN),
            }
        }
        Datatype::FixedPoint {
            size,
            signed,
            byte_order,
        } => {
            let le = *byte_order != ByteOrder::BigEndian;
            match (*size, *signed) {
                (1, true) if !bytes.is_empty() => Ok((bytes[0] as i8) as f64),
                (1, false) if !bytes.is_empty() => Ok(bytes[0] as f64),
                (2, true) if bytes.len() >= 2 => {
                    let b: [u8; 2] = bytes[..2].try_into().unwrap();
                    Ok((if le {
                        i16::from_le_bytes(b)
                    } else {
                        i16::from_be_bytes(b)
                    }) as f64)
                }
                (2, false) if bytes.len() >= 2 => {
                    let b: [u8; 2] = bytes[..2].try_into().unwrap();
                    Ok((if le {
                        u16::from_le_bytes(b)
                    } else {
                        u16::from_be_bytes(b)
                    }) as f64)
                }
                (4, true) if bytes.len() >= 4 => {
                    let b: [u8; 4] = bytes[..4].try_into().unwrap();
                    Ok((if le {
                        i32::from_le_bytes(b)
                    } else {
                        i32::from_be_bytes(b)
                    }) as f64)
                }
                (4, false) if bytes.len() >= 4 => {
                    let b: [u8; 4] = bytes[..4].try_into().unwrap();
                    Ok((if le {
                        u32::from_le_bytes(b)
                    } else {
                        u32::from_be_bytes(b)
                    }) as f64)
                }
                (8, true) if bytes.len() >= 8 => {
                    let b: [u8; 8] = bytes[..8].try_into().unwrap();
                    Ok((if le {
                        i64::from_le_bytes(b)
                    } else {
                        i64::from_be_bytes(b)
                    }) as f64)
                }
                (8, false) if bytes.len() >= 8 => {
                    let b: [u8; 8] = bytes[..8].try_into().unwrap();
                    Ok((if le {
                        u64::from_le_bytes(b)
                    } else {
                        u64::from_be_bytes(b)
                    }) as f64)
                }
                _ => Ok(0.0),
            }
        }
        Datatype::Enum { base, .. } => decode_numeric_f64(bytes, base),
        Datatype::Bitfield { size, .. } if *size == 1 && !bytes.is_empty() => Ok(bytes[0] as f64),
        _ => Ok(f64::NAN),
    }
}

#[derive(Debug, Clone)]
struct FrameRow {
    video_idx: usize,
    frame_idx: u64,
    inst_start: usize,
    inst_end: usize,
    is_negative: bool,
}

#[derive(Debug, Clone)]
struct EmbeddedVideoIndex {
    dataset_path: String,
    format: String,
    channel_order: String,
    width: Option<u32>,
    height: Option<u32>,
    channels: Option<u32>,
    frame_numbers: Vec<u64>,
    frame_to_pos: HashMap<u64, usize>,
    frame_sizes: Option<Vec<u64>>,
}

#[derive(Debug, Clone)]
struct BBoxRow {
    video_idx: usize,
    frame_idx: u64,
    pose: BBoxPose,
}

#[derive(Debug, Clone)]
struct PreviewImageRecord {
    video_idx: usize,
    frame_idx: u64,
    orig_width: u32,
    orig_height: u32,
    width: u32,
    height: u32,
    data_start: u64,
    data_end: u64,
}

pub struct SlpDocument {
    file: Hdf5File,
    summary: SlpSummary,
    frames: Vec<FrameRow>,
    embedded_videos: HashMap<usize, EmbeddedVideoIndex>,
    preview_images: HashMap<(usize, u64), PreviewImageRecord>,
    bboxes_by_frame: HashMap<(usize, u64), Vec<BBoxPose>>,
}

impl SlpDocument {
    pub fn open(path: &Path) -> Result<Self, String> {
        let t0 = Instant::now();
        let file_size_bytes = std::fs::metadata(path)
            .map_err(|e| format!("Cannot read file metadata: {e}"))?
            .len();

        let opts = OpenOptions {
            chunk_cache_bytes: 8 * 1024 * 1024,
            chunk_cache_slots: 257,
            max_chunk_bytes: 32 * 1024 * 1024,
            max_read_bytes: 64 * 1024 * 1024,
            max_object_header_bytes: 8 * 1024 * 1024,
            ..Default::default()
        };

        let file = Hdf5File::open_with_options(path, opts)
            .map_err(|e| format!("Not a valid HDF5/SLP file: {e}"))?;

        let root = file
            .root_group()
            .map_err(|e| format!("Failed reading HDF5 root: {e}"))?;
        let (root_groups, root_datasets) = root
            .member_names()
            .map_err(|e| format!("Failed listing HDF5 root members: {e}"))?;
        let root_group_set: HashSet<String> = root_groups.iter().cloned().collect();
        let root_ds_set: HashSet<String> = root_datasets.iter().cloned().collect();

        // Validate required SLP top-level structure
        if !root_group_set.contains("metadata") {
            return Err("Invalid SLP file: missing /metadata group".into());
        }
        let meta_grp = file
            .group("metadata")
            .map_err(|e| format!("Failed opening /metadata: {e}"))?;

        let format_id = meta_grp
            .attribute("format_id")
            .ok()
            .and_then(|a| a.read_as_f64().ok())
            .unwrap_or(1.0);

        if format_id >= SLP_FORMAT_ID_LIMIT {
            return Err(format!(
                "Unsupported SLP format version {format_id:.1} (supported up to < {SLP_FORMAT_ID_LIMIT:.1})"
            ));
        }

        let meta_json_str = read_attr_string(&meta_grp, "json")
            .ok_or_else(|| "Invalid SLP file: missing /metadata.attrs['json']".to_string())?;
        let meta_json: Value = serde_json::from_str(&meta_json_str)
            .map_err(|e| format!("Invalid /metadata JSON: {e}"))?;

        let sleap_version = meta_json
            .get("version")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();

        let skeletons = parse_skeletons(&meta_json);
        let provenance_summary = extract_provenance_summary(&meta_json);
        let tracks = read_tracks(&file, &root_ds_set);

        let filename_str = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "project.slp".into());
        let path_str = path.to_string_lossy().to_string();

        // Videos + embedded video indices
        let (mut videos, embedded_videos, video_group_id_to_index) =
            read_videos(&file, &root_group_set, &root_ds_set, &path_str);

        // Read frames table (3.0 columnar group OR 1.x/2.x compound OR 2.x flat 2-D)
        let is_format3 = format_id >= 3.0 || root_group_set.contains("frames");
        let frames = read_frames_table(
            &file,
            &root_group_set,
            &root_ds_set,
            &video_group_id_to_index,
            videos.len(),
        )?;

        // Count labeled frames per video
        for fr in &frames {
            if let Some(v) = videos.get_mut(fr.video_idx) {
                v.labeled_frame_count += 1;
            }
        }
        let negative_frames = frames.iter().filter(|f| f.is_negative).count();

        // Counts (cheaply via dataset shapes + light column read for user vs pred split)
        let total_instances = table_row_count(&file, "instances", "instance_type", &root_group_set, &root_ds_set);
        let user_points = table_row_count(&file, "points", "x", &root_group_set, &root_ds_set);
        let predicted_points = table_row_count(&file, "pred_points", "x", &root_group_set, &root_ds_set);

        let (user_instances, predicted_instances) =
            count_user_vs_predicted_instances(&file, &root_group_set, &root_ds_set, total_instances);

        let suggestions = dataset_len(&file, "suggestions_json", &root_ds_set);
        let sessions = dataset_len(&file, "sessions_json", &root_ds_set);
        let identities = nested_dataset_len(&file, "identity/name", &root_group_set);
        let categories = nested_dataset_len(&file, "categories/name", &root_group_set);
        let bboxes_count = table_row_count(&file, "bboxes", "x1", &root_group_set, &root_ds_set);
        let masks_count = table_row_count(&file, "masks", "video", &root_group_set, &root_ds_set);
        let rois_count = table_row_count(&file, "rois", "video", &root_group_set, &root_ds_set);
        let label_images_count =
            table_row_count(&file, "label_images", "video", &root_group_set, &root_ds_set);
        let events_count = nested_dataset_len(&file, "events/start_frame", &root_group_set);

        let bboxes_by_frame = if bboxes_count > 0 && bboxes_count <= 200_000 {
            read_bboxes_map(&file, &root_group_set, &root_ds_set, &video_group_id_to_index)
        } else {
            HashMap::new()
        };

        let embedded_video_count = videos.iter().filter(|v| v.embedded).count();
        let is_pkg = embedded_video_count > 0;

        // Read optional /preview group (clean RGB/gray preview JPEGs for linked .slp files)
        let preview_records = read_preview_index(&file, &root_group_set);
        let mut preview_images: HashMap<(usize, u64), PreviewImageRecord> =
            HashMap::with_capacity(preview_records.len());
        for rec in &preview_records {
            // Backfill video dimensions if videos_json omitted shape
            if let Some(v) = videos.get_mut(rec.video_idx) {
                if v.width.is_none() && rec.orig_width > 0 {
                    v.width = Some(rec.orig_width);
                }
                if v.height.is_none() && rec.orig_height > 0 {
                    v.height = Some(rec.orig_height);
                }
            }
            preview_images
                .entry((rec.video_idx, rec.frame_idx))
                .or_insert_with(|| rec.clone());
        }
        let has_preview_images = !preview_images.is_empty();
        let preview_image_count = preview_images.len();

        // Build preview frame list (prioritizing frames with embedded or /preview images;
        // capped to at most 400 entries in the summary JSON for snappy UI scrubbing).
        let preview_frames =
            build_preview_frames(&frames, &embedded_videos, &preview_records, &preview_images, 400);
        let timeline_bins = build_timeline_histogram(&frames, &videos, 48);

        let counts = CountsInfo {
            labeled_frames: frames.len(),
            negative_frames,
            instances: total_instances,
            user_instances,
            predicted_instances,
            user_points,
            predicted_points,
            tracks: tracks.len(),
            videos: videos.len(),
            embedded_videos: embedded_video_count,
            suggestions,
            sessions,
            identities,
            categories,
            bboxes: bboxes_count,
            masks: masks_count,
            rois: rois_count,
            label_images: label_images_count,
            events: events_count,
        };

        let open_ms = t0.elapsed().as_secs_f64() * 1000.0;

        let summary = SlpSummary {
            path: path_str,
            filename: filename_str,
            file_size_bytes,
            format_id,
            sleap_version,
            is_format3,
            is_pkg,
            has_preview_images,
            preview_image_count,
            skeletons,
            tracks,
            videos,
            counts,
            provenance_summary,
            preview_frames,
            timeline_bins,
            open_ms,
        };

        Ok(Self {
            file,
            summary,
            frames,
            embedded_videos,
            preview_images,
            bboxes_by_frame,
        })
    }

    pub fn summary(&self) -> &SlpSummary {
        &self.summary
    }

    /// Load poses + bboxes for a single frame row using hyperslab slicing on
    /// `/instances`, `/points`, and `/pred_points`.
    pub fn frame_poses(&self, frame_row_idx: usize) -> Result<FramePoses, String> {
        let fr = self
            .frames
            .get(frame_row_idx)
            .ok_or_else(|| format!("Frame row {frame_row_idx} out of bounds"))?;

        let (width, height) = self
            .summary
            .videos
            .get(fr.video_idx)
            .map(|v| (v.width, v.height))
            .unwrap_or((None, None));

        let mut instances = Vec::new();
        if fr.inst_end > fr.inst_start {
            let inst_rows = read_instances_slice(&self.file, fr.inst_start, fr.inst_end)?;
            for inst in inst_rows {
                let is_predicted = inst.instance_type == 1;
                let pts = if inst.point_end > inst.point_start {
                    let table = if is_predicted { "pred_points" } else { "points" };
                    read_points_slice(&self.file, table, inst.point_start, inst.point_end)
                        .unwrap_or_default()
                } else {
                    Vec::new()
                };
                instances.push(InstancePose {
                    is_predicted,
                    skeleton_idx: inst.skeleton.max(0) as usize,
                    track_idx: if inst.track >= 0 {
                        Some(inst.track as usize)
                    } else {
                        None
                    },
                    score: if inst.score.is_finite() {
                        Some(inst.score)
                    } else {
                        None
                    },
                    points: pts,
                });
            }
        }

        let bboxes = self
            .bboxes_by_frame
            .get(&(fr.video_idx, fr.frame_idx))
            .cloned()
            .unwrap_or_default();

        Ok(FramePoses {
            row_idx: frame_row_idx,
            video_idx: fr.video_idx,
            frame_idx: fr.frame_idx,
            width,
            height,
            instances,
            bboxes,
        })
    }

    /// Load a single frame image by `(video_idx, frame_idx)` via hyperslab slicing.
    /// Prefers full-resolution embedded video (`videoN/video`) when available,
    /// otherwise falls back to the optional `/preview` group.
    pub fn frame_image(&self, video_idx: usize, frame_idx: u64) -> Result<Option<DecodedImage>, String> {
        if let Some(img) = self.embedded_frame_image(video_idx, frame_idx)? {
            return Ok(Some(img));
        }
        self.preview_group_image(video_idx, frame_idx)
    }

    fn preview_group_image(
        &self,
        video_idx: usize,
        frame_idx: u64,
    ) -> Result<Option<DecodedImage>, String> {
        let Some(rec) = self.preview_images.get(&(video_idx, frame_idx)) else {
            return Ok(None);
        };
        if rec.data_end <= rec.data_start {
            return Ok(None);
        }
        let ds = match self.file.dataset("preview/data") {
            Ok(d) => d,
            Err(_) => return Ok(None),
        };
        let total_len = ds.shape().first().copied().unwrap_or(0);
        if rec.data_end > total_len {
            return Ok(None);
        }
        let sel = SliceInfo {
            selections: vec![SliceInfoElem::Slice {
                start: rec.data_start,
                end: rec.data_end,
                step: 1,
            }],
        };
        let bytes = read_slice_as_u8(&ds, &sel)?;
        if bytes.is_empty() {
            return Ok(None);
        }
        Ok(Some(DecodedImage {
            bytes,
            kind: 0,
            width: rec.width as i32,
            height: rec.height as i32,
            channels: 3,
            is_bgr: false,
            orig_width: rec.orig_width as i32,
            orig_height: rec.orig_height as i32,
            is_preview: true,
        }))
    }

    fn embedded_frame_image(
        &self,
        video_idx: usize,
        frame_idx: u64,
    ) -> Result<Option<DecodedImage>, String> {
        let Some(emb) = self.embedded_videos.get(&video_idx) else {
            return Ok(None);
        };

        let pos = if !emb.frame_to_pos.is_empty() {
            match emb.frame_to_pos.get(&frame_idx) {
                Some(&p) => p,
                None => return Ok(None),
            }
        } else {
            frame_idx as usize
        };

        let ds = match self.file.dataset(&emb.dataset_path) {
            Ok(d) => d,
            Err(_) => return Ok(None),
        };

        let shape = ds.shape();
        let dtype = ds.dtype();
        let is_bgr = emb.channel_order.eq_ignore_ascii_case("bgr");
        let fmt_lower = emb.format.to_ascii_lowercase();
        let is_encoded = fmt_lower == "png" || fmt_lower == "jpg" || fmt_lower == "jpeg";
        let orig_w = emb.width.unwrap_or(0) as i32;
        let orig_h = emb.height.unwrap_or(0) as i32;

        // Case 1: Variable-length blob dataset (1D `[N]` with Datatype::VarLen)
        if matches!(dtype, Datatype::VarLen { .. }) && shape.len() == 1 {
            if (pos as u64) >= shape[0] {
                return Ok(None);
            }
            let sel = SliceInfo {
                selections: vec![SliceInfoElem::Index(pos as u64)],
            };
            let arr = ds
                .read_slice::<RawElem>(&sel)
                .map_err(|e| format!("Failed slicing vlen frame {pos}: {e}"))?;
            let Some(ref_elem) = arr.iter().next() else {
                return Ok(None);
            };
            let base_sz = match dtype {
                Datatype::VarLen { base, .. } => dtype_element_size(base).unwrap_or(1),
                _ => 1,
            };
            let bytes = ds
                .resolve_vlen_reference_bytes(&ref_elem.0, base_sz)
                .map_err(|e| format!("Failed resolving vlen frame {pos}: {e}"))?;
            if bytes.is_empty() {
                return Ok(None);
            }
            return Ok(Some(DecodedImage {
                bytes,
                kind: if is_encoded { 0 } else { 1 },
                width: orig_w,
                height: orig_h,
                channels: emb.channels.unwrap_or(3) as i32,
                is_bgr,
                orig_width: orig_w,
                orig_height: orig_h,
                is_preview: false,
            }));
        }

        // Case 2: 2D padded encoded image dataset `[N, M]`
        if shape.len() == 2 && is_encoded {
            if (pos as u64) >= shape[0] {
                return Ok(None);
            }
            let sel = SliceInfo {
                selections: vec![
                    SliceInfoElem::Index(pos as u64),
                    SliceInfoElem::Slice {
                        start: 0,
                        end: shape[1],
                        step: 1,
                    },
                ],
            };
            let mut bytes = read_slice_as_u8(&ds, &sel)?;
            if let Some(sizes) = &emb.frame_sizes {
                if let Some(&sz) = sizes.get(pos) {
                    if (sz as usize) <= bytes.len() {
                        bytes.truncate(sz as usize);
                    }
                }
            } else {
                while bytes.last() == Some(&0) {
                    bytes.pop();
                }
            }
            if bytes.is_empty() {
                return Ok(None);
            }
            return Ok(Some(DecodedImage {
                bytes,
                kind: 0,
                width: orig_w,
                height: orig_h,
                channels: emb.channels.unwrap_or(3) as i32,
                is_bgr,
                orig_width: orig_w,
                orig_height: orig_h,
                is_preview: false,
            }));
        }

        // Case 3: 1D concatenated encoded bytes `[totalBytes]` with `frame_sizes`
        if shape.len() == 1 && is_encoded {
            if let Some(sizes) = &emb.frame_sizes {
                if pos >= sizes.len() {
                    return Ok(None);
                }
                let start: u64 = sizes[..pos].iter().sum();
                let len = sizes[pos];
                if len == 0 || start + len > shape[0] {
                    return Ok(None);
                }
                let sel = SliceInfo {
                    selections: vec![SliceInfoElem::Slice {
                        start,
                        end: start + len,
                        step: 1,
                    }],
                };
                let bytes = read_slice_as_u8(&ds, &sel)?;
                return Ok(Some(DecodedImage {
                    bytes,
                    kind: 0,
                    width: orig_w,
                    height: orig_h,
                    channels: emb.channels.unwrap_or(3) as i32,
                    is_bgr,
                    orig_width: orig_w,
                    orig_height: orig_h,
                    is_preview: false,
                }));
            }
        }

        // Case 4: Raw pixel tensor `[N, H, W, C]` or `[N, H, W]`
        if (shape.len() == 4 || shape.len() == 3) && (pos as u64) < shape[0] {
            let mut selections = vec![SliceInfoElem::Index(pos as u64)];
            for &dim in &shape[1..] {
                selections.push(SliceInfoElem::Slice {
                    start: 0,
                    end: dim,
                    step: 1,
                });
            }
            let bytes = read_slice_as_u8(&ds, &SliceInfo { selections })?;
            let h = shape[1] as i32;
            let w = shape[2] as i32;
            let c = if shape.len() == 4 { shape[3] as i32 } else { 1 };
            return Ok(Some(DecodedImage {
                bytes,
                kind: 1,
                width: w,
                height: h,
                channels: c,
                is_bgr,
                orig_width: w,
                orig_height: h,
                is_preview: false,
            }));
        }

        Ok(None)
    }
}

fn read_slice_as_u8(ds: &Dataset, sel: &SliceInfo) -> Result<Vec<u8>, String> {
    match ds.dtype() {
        Datatype::FixedPoint {
            size: 1,
            signed: false,
            ..
        } => ds
            .read_slice::<u8>(sel)
            .map(|a| a.into_raw_vec_and_offset().0)
            .map_err(|e| format!("Failed reading u8 slice: {e}")),
        Datatype::FixedPoint {
            size: 1,
            signed: true,
            ..
        } => ds
            .read_slice::<i8>(sel)
            .map(|a| {
                a.into_raw_vec_and_offset()
                    .0
                    .into_iter()
                    .map(|b| b as u8)
                    .collect()
            })
            .map_err(|e| format!("Failed reading i8 slice: {e}")),
        _ => ds
            .read_slice::<RawElem>(sel)
            .map(|a| a.into_iter().flat_map(|e| e.0).collect())
            .map_err(|e| format!("Failed reading raw slice: {e}")),
    }
}

fn read_attr_string(grp: &Group, name: &str) -> Option<String> {
    let attr = grp.attribute(name).ok()?;
    if let Ok(s) = attr.read_string() {
        let trimmed = s.trim_end_matches('\0').trim().to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }
    if let Ok(raw) = String::from_utf8(attr.raw_data.clone()) {
        let trimmed = raw.trim_end_matches('\0').trim().to_string();
        if !trimmed.is_empty() {
            return Some(trimmed);
        }
    }
    None
}

fn read_ds_attr_string(ds: &Dataset, name: &str) -> Option<String> {
    let attr = ds.attribute(name).ok()?;
    attr.read_string()
        .ok()
        .map(|s| s.trim_end_matches('\0').trim().to_string())
        .filter(|s| !s.is_empty())
}

fn read_ds_attr_u64(ds: &Dataset, name: &str) -> Option<u64> {
    let attr = ds.attribute(name).ok()?;
    let v = attr.read_as_f64().ok()?;
    if v.is_finite() && v >= 0.0 {
        Some(v as u64)
    } else {
        None
    }
}

fn read_string_dataset(file: &Hdf5File, path: &str) -> Vec<String> {
    let Ok(ds) = file.dataset(path) else {
        return Vec::new();
    };
    if ds.shape().first().copied().unwrap_or(0) == 0 && !ds.shape().is_empty() {
        return Vec::new();
    }
    if let Ok(v) = ds.read_strings() {
        return v
            .into_iter()
            .map(|s| s.trim_end_matches('\0').trim().to_string())
            .collect();
    }
    if let Ok(s) = ds.read_string() {
        return vec![s.trim_end_matches('\0').trim().to_string()];
    }
    Vec::new()
}

fn parse_skeletons(meta: &Value) -> Vec<SkeletonInfo> {
    let node_names: Vec<String> = meta
        .get("nodes")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|n| {
                    n.get("name")
                        .and_then(|s| s.as_str())
                        .or_else(|| n.as_str())
                        .unwrap_or("")
                        .to_string()
                })
                .collect()
        })
        .unwrap_or_default();

    let Some(skel_entries) = meta.get("skeletons").and_then(|v| v.as_array()) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for (idx, entry) in skel_entries.iter().enumerate() {
        let graph_src = entry
            .get("nx_graph")
            .filter(|v| v.is_object())
            .unwrap_or(entry);

        let entry_node_ids: Vec<usize> = graph_src
            .get("nodes")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|n| {
                        n.get("id")
                            .and_then(|v| v.as_u64())
                            .or_else(|| n.as_u64())
                            .map(|id| id as usize)
                    })
                    .collect()
            })
            .unwrap_or_default();

        let node_order: Vec<usize> = if !entry_node_ids.is_empty() {
            entry_node_ids
        } else {
            (0..node_names.len()).collect()
        };

        let mut node_index_by_id: HashMap<usize, usize> = HashMap::new();
        let mut nodes = Vec::new();
        for &id in &node_order {
            if let Some(name) = node_names.get(id) {
                node_index_by_id.insert(id, nodes.len());
                nodes.push(name.clone());
            }
        }

        let mut edges = Vec::new();
        let mut symmetries = Vec::new();
        let mut type_cache: HashMap<u64, u64> = HashMap::new();
        let mut next_id: u64 = 1;
        let mut seen_sym: HashSet<(usize, usize)> = HashSet::new();

        if let Some(links) = graph_src.get("links").and_then(|v| v.as_array()) {
            for link in links {
                let Some(src_id) = link.get("source").and_then(|v| v.as_u64()) else {
                    continue;
                };
                let Some(dst_id) = link.get("target").and_then(|v| v.as_u64()) else {
                    continue;
                };
                let edge_type = resolve_edge_type(link.get("type"), &mut type_cache, &mut next_id);
                let (Some(&a), Some(&b)) = (
                    node_index_by_id.get(&(src_id as usize)),
                    node_index_by_id.get(&(dst_id as usize)),
                ) else {
                    continue;
                };
                if edge_type == 2 {
                    let key = if a < b { (a, b) } else { (b, a) };
                    if seen_sym.insert(key) {
                        symmetries.push([a, b]);
                    }
                } else {
                    edges.push([a, b]);
                }
            }
        }

        let name = graph_src
            .get("graph")
            .and_then(|g| g.get("name"))
            .and_then(|s| s.as_str())
            .or_else(|| entry.get("name").and_then(|s| s.as_str()))
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("Skeleton {}", idx + 1));

        out.push(SkeletonInfo {
            name,
            nodes,
            edges,
            symmetries,
        });
    }
    out
}

fn resolve_edge_type(
    val: Option<&Value>,
    cache: &mut HashMap<u64, u64>,
    next_id: &mut u64,
) -> u64 {
    let Some(obj) = val.and_then(|v| v.as_object()) else {
        return 1;
    };
    if let Some(reduce) = obj.get("py/reduce").and_then(|v| v.as_array()) {
        let tid = reduce
            .get(1)
            .and_then(|v| v.get("py/tuple"))
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .and_then(|v| v.as_u64())
            .unwrap_or(1);
        cache.insert(*next_id, tid);
        *next_id += 1;
        return tid;
    }
    if let Some(tuple) = obj.get("py/tuple").and_then(|v| v.as_array()) {
        let tid = tuple.first().and_then(|v| v.as_u64()).unwrap_or(1);
        cache.insert(*next_id, tid);
        *next_id += 1;
        return tid;
    }
    if let Some(py_id) = obj.get("py/id").and_then(|v| v.as_u64()) {
        return *cache.get(&py_id).unwrap_or(&py_id);
    }
    1
}

fn extract_provenance_summary(meta: &Value) -> Vec<(String, String)> {
    let Some(prov) = meta.get("provenance").and_then(|v| v.as_object()) else {
        return Vec::new();
    };
    let mut items = Vec::new();
    let keys = [
        ("sleap_version", "SLEAP"),
        ("sleap_io_version", "sleap-io"),
        ("sleap_nn_version", "sleap-nn"),
        ("model_paths", "Models"),
        ("platform", "Platform"),
        ("created_at", "Created"),
    ];
    for (k, label) in keys {
        if let Some(v) = prov.get(k) {
            let s = match v {
                Value::String(s) => s.clone(),
                Value::Array(arr) => arr
                    .iter()
                    .filter_map(|x| x.as_str())
                    .map(|p| {
                        Path::new(p)
                            .file_name()
                            .map(|f| f.to_string_lossy().to_string())
                            .unwrap_or_else(|| p.to_string())
                    })
                    .collect::<Vec<_>>()
                    .join(", "),
                _ => continue,
            };
            if !s.is_empty() {
                items.push((label.to_string(), s));
            }
        }
    }
    items
}

fn read_tracks(file: &Hdf5File, root_ds_set: &HashSet<String>) -> Vec<String> {
    if !root_ds_set.contains("tracks_json") {
        return Vec::new();
    }
    let raw = read_string_dataset(file, "tracks_json");
    raw.into_iter()
        .map(|entry| {
            if let Ok(v) = serde_json::from_str::<Value>(&entry) {
                if let Some(arr) = v.as_array() {
                    if let Some(s) = arr.get(1).or_else(|| arr.first()).and_then(|x| x.as_str()) {
                        return s.to_string();
                    }
                    if let Some(n) = arr.get(1).or_else(|| arr.first()) {
                        return n.to_string();
                    }
                } else if let Some(name) = v.get("name").and_then(|x| x.as_str()) {
                    return name.to_string();
                } else if let Some(s) = v.as_str() {
                    return s.to_string();
                }
            }
            entry
        })
        .collect()
}

fn read_videos(
    file: &Hdf5File,
    root_group_set: &HashSet<String>,
    root_ds_set: &HashSet<String>,
    labels_path: &str,
) -> (
    Vec<VideoInfo>,
    HashMap<usize, EmbeddedVideoIndex>,
    HashMap<usize, usize>,
) {
    let mut videos = Vec::new();
    let mut embedded_videos = HashMap::new();
    let mut group_id_to_index = HashMap::new();

    if !root_ds_set.contains("videos_json") {
        return (videos, embedded_videos, group_id_to_index);
    }

    let entries = read_string_dataset(file, "videos_json");
    for (idx, raw) in entries.into_iter().enumerate() {
        let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let backend = parsed.get("backend").unwrap_or(&Value::Null);

        let filename_raw = backend
            .get("filenames")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .and_then(|v| v.as_str())
            .or_else(|| backend.get("filename").and_then(|v| v.as_str()))
            .or_else(|| parsed.get("filename").and_then(|v| v.as_str()))
            .unwrap_or("")
            .to_string();

        let mut dataset = backend
            .get("dataset")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let embedded = filename_raw == ".";
        if embedded && dataset.is_none() {
            let candidate = format!("video{idx}/video");
            if root_group_set.contains(&format!("video{idx}")) {
                dataset = Some(candidate);
            }
        }

        if let Some(ds_path) = &dataset {
            if let Some(gid) = parse_video_group_id(ds_path) {
                group_id_to_index.insert(gid, idx);
            }
        }
        group_id_to_index.entry(idx).or_insert(idx);

        let shape = backend.get("shape").and_then(|v| v.as_array());
        let mut frame_count = shape.and_then(|s| s.first()).and_then(|v| v.as_u64());
        let mut height = shape.and_then(|s| s.get(1)).and_then(|v| v.as_u64()).map(|v| v as u32);
        let mut width = shape.and_then(|s| s.get(2)).and_then(|v| v.as_u64()).map(|v| v as u32);
        let mut channels = shape.and_then(|s| s.get(3)).and_then(|v| v.as_u64()).map(|v| v as u32);
        let fps = backend.get("fps").and_then(|v| v.as_f64());
        let mut format = backend
            .get("format")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let mut channel_order = backend
            .get("channel_order")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        // Check for source video original filename for nice display when embedded
        let source_name = parsed
            .get("source_video")
            .and_then(|sv| {
                sv.get("backend")
                    .and_then(|b| b.get("filename"))
                    .or_else(|| sv.get("filename"))
                    .and_then(|s| s.as_str())
            })
            .map(|s| s.to_string())
            .or_else(|| {
                dataset.as_ref().and_then(|ds_path| {
                    let grp_name = ds_path.split('/').next()?;
                    let sv_grp = file.group(&format!("{grp_name}/source_video")).ok()?;
                    let json_s = read_attr_string(&sv_grp, "json")?;
                    let sv_val: Value = serde_json::from_str(&json_s).ok()?;
                    sv_val
                        .get("backend")
                        .and_then(|b| b.get("filename"))
                        .or_else(|| sv_val.get("filename"))
                        .and_then(|s| s.as_str())
                        .map(|s| s.to_string())
                })
            });

        let mut embedded_frame_count = 0usize;
        if embedded {
            if let Some(ds_path) = &dataset {
                if let Ok(vds) = file.dataset(ds_path) {
                    if format.is_none() {
                        format = read_ds_attr_string(&vds, "format");
                    }
                    if channel_order.is_none() {
                        channel_order = read_ds_attr_string(&vds, "channel_order");
                    }
                    if width.is_none() {
                        width = read_ds_attr_u64(&vds, "width").map(|v| v as u32);
                    }
                    if height.is_none() {
                        height = read_ds_attr_u64(&vds, "height").map(|v| v as u32);
                    }
                    if channels.is_none() {
                        channels = read_ds_attr_u64(&vds, "channels").map(|v| v as u32);
                    }
                    if frame_count.is_none() {
                        frame_count = read_ds_attr_u64(&vds, "frames");
                    }

                    // Read frame_numbers & frame_sizes sibling datasets
                    let group_prefix = ds_path.rsplit_once('/').map(|(g, _)| g).unwrap_or("");
                    let fn_path = format!("{group_prefix}/frame_numbers");
                    let frame_numbers = read_u64_column(file, &fn_path).unwrap_or_default();
                    let fs_path = format!("{group_prefix}/frame_sizes");
                    let frame_sizes = read_u64_column(file, &fs_path);

                    let ds_shape = vds.shape();
                    embedded_frame_count = if !frame_numbers.is_empty() {
                        frame_numbers.len()
                    } else if let Some(fs) = &frame_sizes {
                        fs.len()
                    } else {
                        ds_shape.first().copied().unwrap_or(0) as usize
                    };

                    if frame_count.is_none() {
                        if let Some(&max_fn) = frame_numbers.iter().max() {
                            frame_count = Some(max_fn + 1);
                        } else if embedded_frame_count > 0 {
                            frame_count = Some(embedded_frame_count as u64);
                        }
                    }

                    let mut frame_to_pos = HashMap::with_capacity(frame_numbers.len());
                    for (pos, &fnum) in frame_numbers.iter().enumerate() {
                        frame_to_pos.entry(fnum).or_insert(pos);
                    }

                    embedded_videos.insert(
                        idx,
                        EmbeddedVideoIndex {
                            dataset_path: ds_path.clone(),
                            format: format.clone().unwrap_or_else(|| "png".into()),
                            channel_order: channel_order.clone().unwrap_or_else(|| "RGB".into()),
                            width,
                            height,
                            channels,
                            frame_numbers,
                            frame_to_pos,
                            frame_sizes,
                        },
                    );
                }
            }
        }

        let filename = if embedded {
            source_name
                .clone()
                .unwrap_or_else(|| labels_path.to_string())
        } else {
            filename_raw
        };

        let display_name = Path::new(&filename)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| format!("Video {}", idx + 1));

        videos.push(VideoInfo {
            index: idx,
            filename,
            display_name,
            dataset,
            embedded,
            embedded_frame_count,
            format,
            width,
            height,
            channels,
            frame_count,
            fps,
            channel_order,
            labeled_frame_count: 0,
        });
    }

    (videos, embedded_videos, group_id_to_index)
}

fn parse_video_group_id(dataset: &str) -> Option<usize> {
    let first = dataset.split('/').next()?;
    let rest = first.strip_prefix("video")?;
    rest.parse::<usize>().ok()
}

fn read_u64_column(file: &Hdf5File, path: &str) -> Option<Vec<u64>> {
    let ds = file.dataset(path).ok()?;
    let arr = ds.read_array::<AnyF64>().ok()?;
    Some(
        arr.into_iter()
            .map(|v| if v.0.is_finite() && v.0 >= 0.0 { v.0 as u64 } else { 0 })
            .collect(),
    )
}

fn read_f64_column_slice(ds: &Dataset, start: usize, end: usize) -> Result<Vec<f64>, String> {
    if end <= start {
        return Ok(Vec::new());
    }
    let sel = SliceInfo {
        selections: vec![SliceInfoElem::Slice {
            start: start as u64,
            end: end as u64,
            step: 1,
        }],
    };
    let arr = ds
        .read_slice::<AnyF64>(&sel)
        .map_err(|e| format!("Failed slicing column: {e}"))?;
    Ok(arr.into_iter().map(|v| v.0).collect())
}

fn read_f64_column_full(ds: &Dataset) -> Result<Vec<f64>, String> {
    let n = ds.shape().first().copied().unwrap_or(0) as usize;
    if n == 0 {
        return Ok(Vec::new());
    }
    let arr = ds
        .read_array::<AnyF64>()
        .map_err(|e| format!("Failed reading column: {e}"))?;
    Ok(arr.into_iter().map(|v| v.0).collect())
}

/// Extract numeric columns from a 1-D compound dataset or 2-D flat float dataset
/// over row range `[start, end)`.
fn read_table_rows_slice(
    ds: &Dataset,
    start: usize,
    end: usize,
) -> Result<HashMap<String, Vec<f64>>, String> {
    let nrows = end.saturating_sub(start);
    let shape = ds.shape();
    if nrows == 0 || shape.is_empty() || shape[0] == 0 {
        return Ok(HashMap::new());
    }

    match ds.dtype() {
        Datatype::Compound { fields, .. } => {
            let sel = SliceInfo {
                selections: vec![SliceInfoElem::Slice {
                    start: start as u64,
                    end: end as u64,
                    step: 1,
                }],
            };
            let arr = ds
                .read_slice::<RawElem>(&sel)
                .map_err(|e| format!("Failed slicing compound table: {e}"))?;
            Ok(decode_compound_columns(arr.as_slice().unwrap_or(&[]), fields))
        }
        _ if shape.len() == 2 => {
            // Flat 2-D table with `field_names` JSON attribute (legacy sleap-io.js writer)
            let field_names_str = read_ds_attr_string(ds, "field_names").unwrap_or_default();
            let fields: Vec<String> = serde_json::from_str(&field_names_str).unwrap_or_default();
            if fields.is_empty() {
                return Ok(HashMap::new());
            }
            let ncols = shape[1] as usize;
            let sel = SliceInfo {
                selections: vec![
                    SliceInfoElem::Slice {
                        start: start as u64,
                        end: end as u64,
                        step: 1,
                    },
                    SliceInfoElem::Slice {
                        start: 0,
                        end: shape[1],
                        step: 1,
                    },
                ],
            };
            let arr = ds
                .read_slice::<AnyF64>(&sel)
                .map_err(|e| format!("Failed slicing 2D table: {e}"))?;
            let flat: Vec<f64> = arr.into_iter().map(|v| v.0).collect();
            let mut cols: HashMap<String, Vec<f64>> = HashMap::new();
            for (c, name) in fields.into_iter().enumerate() {
                if c >= ncols {
                    break;
                }
                let mut col = Vec::with_capacity(nrows);
                for r in 0..nrows {
                    col.push(*flat.get(r * ncols + c).unwrap_or(&f64::NAN));
                }
                cols.insert(name, col);
            }
            Ok(cols)
        }
        _ => Ok(HashMap::new()),
    }
}

fn decode_compound_columns(rows: &[RawElem], fields: &[CompoundField]) -> HashMap<String, Vec<f64>> {
    let mut cols: HashMap<String, Vec<f64>> = HashMap::with_capacity(fields.len());
    for f in fields {
        let off = f.byte_offset as usize;
        let sz = dtype_element_size(&f.datatype).unwrap_or(0);
        if sz == 0 {
            continue;
        }
        let mut col = Vec::with_capacity(rows.len());
        for row in rows {
            if off + sz <= row.0.len() {
                let v = decode_numeric_f64(&row.0[off..off + sz], &f.datatype).unwrap_or(f64::NAN);
                col.push(v);
            } else {
                col.push(f64::NAN);
            }
        }
        cols.insert(f.name.clone(), col);
    }
    cols
}

fn read_frames_table(
    file: &Hdf5File,
    root_group_set: &HashSet<String>,
    root_ds_set: &HashSet<String>,
    video_group_id_to_index: &HashMap<usize, usize>,
    video_count: usize,
) -> Result<Vec<FrameRow>, String> {
    if root_group_set.contains("frames") {
        // Format 3.0 columnar group `/frames`
        let frame_idx_ds = file
            .dataset("frames/frame_idx")
            .map_err(|e| format!("Missing /frames/frame_idx: {e}"))?;
        let n = frame_idx_ds.shape().first().copied().unwrap_or(0) as usize;
        if n == 0 {
            return Ok(Vec::new());
        }
        let video_col = read_f64_column_full(
            &file
                .dataset("frames/video")
                .map_err(|e| format!("Missing /frames/video: {e}"))?,
        )?;
        let frame_idx_col = read_f64_column_full(&frame_idx_ds)?;
        let inst_start_col = read_f64_column_full(
            &file
                .dataset("frames/instance_id_start")
                .map_err(|e| format!("Missing /frames/instance_id_start: {e}"))?,
        )?;
        let inst_end_col = read_f64_column_full(
            &file
                .dataset("frames/instance_id_end")
                .map_err(|e| format!("Missing /frames/instance_id_end: {e}"))?,
        )?;
        let is_neg_col = file
            .dataset("frames/is_negative")
            .ok()
            .and_then(|d| read_f64_column_full(&d).ok());

        let mut rows = Vec::with_capacity(n);
        for i in 0..n {
            let v_idx = video_col.get(i).copied().unwrap_or(0.0).max(0.0) as usize;
            rows.push(FrameRow {
                video_idx: v_idx,
                frame_idx: frame_idx_col.get(i).copied().unwrap_or(0.0).max(0.0) as u64,
                inst_start: inst_start_col.get(i).copied().unwrap_or(0.0).max(0.0) as usize,
                inst_end: inst_end_col.get(i).copied().unwrap_or(0.0).max(0.0) as usize,
                is_negative: is_neg_col
                    .as_ref()
                    .and_then(|c| c.get(i))
                    .map(|&v| v != 0.0)
                    .unwrap_or(false),
            });
        }
        return Ok(rows);
    }

    if !root_ds_set.contains("frames") {
        return Ok(Vec::new());
    }

    let ds = file
        .dataset("frames")
        .map_err(|e| format!("Failed opening /frames: {e}"))?;
    let n = ds.shape().first().copied().unwrap_or(0) as usize;
    if n == 0 {
        return Ok(Vec::new());
    }
    let cols = read_table_rows_slice(&ds, 0, n)?;

    // Check legacy /negative_frames dataset if present
    let mut neg_keys: HashSet<(usize, u64)> = HashSet::new();
    if root_ds_set.contains("negative_frames") {
        if let Ok(nds) = file.dataset("negative_frames") {
            let nn = nds.shape().first().copied().unwrap_or(0) as usize;
            if let Ok(ncols) = read_table_rows_slice(&nds, 0, nn) {
                let nvid = ncols.get("video");
                let nfidx = ncols.get("frame_idx");
                if let (Some(nv), Some(nf)) = (nvid, nfidx) {
                    for i in 0..nv.len().min(nf.len()) {
                        let raw_v = nv[i].max(0.0) as usize;
                        let mapped_v = video_group_id_to_index.get(&raw_v).copied().unwrap_or(raw_v);
                        neg_keys.insert((mapped_v, nf[i].max(0.0) as u64));
                    }
                }
            }
        }
    }

    let video_col = cols.get("video");
    let fidx_col = cols.get("frame_idx");
    let istart_col = cols.get("instance_id_start");
    let iend_col = cols.get("instance_id_end");

    // Check whether video IDs are directly 0..video_count-1
    let use_identity = video_col
        .map(|vc| {
            let max_id = vc.iter().copied().fold(0.0f64, f64::max) as usize;
            video_count > 0 && max_id < video_count && video_group_id_to_index.len() <= video_count
        })
        .unwrap_or(true);

    let mut rows = Vec::with_capacity(n);
    for i in 0..n {
        let raw_v = video_col.and_then(|c| c.get(i)).copied().unwrap_or(0.0).max(0.0) as usize;
        let v_idx = if use_identity && raw_v < video_count {
            video_group_id_to_index.get(&raw_v).copied().unwrap_or(raw_v)
        } else {
            video_group_id_to_index.get(&raw_v).copied().unwrap_or(raw_v)
        };
        let fidx = fidx_col.and_then(|c| c.get(i)).copied().unwrap_or(0.0).max(0.0) as u64;
        rows.push(FrameRow {
            video_idx: v_idx,
            frame_idx: fidx,
            inst_start: istart_col.and_then(|c| c.get(i)).copied().unwrap_or(0.0).max(0.0) as usize,
            inst_end: iend_col.and_then(|c| c.get(i)).copied().unwrap_or(0.0).max(0.0) as usize,
            is_negative: neg_keys.contains(&(v_idx, fidx)),
        });
    }
    Ok(rows)
}

#[derive(Debug, Clone)]
struct InstanceRow {
    instance_type: i32,
    skeleton: i32,
    track: i32,
    score: f64,
    point_start: usize,
    point_end: usize,
}

fn read_instances_slice(
    file: &Hdf5File,
    start: usize,
    end: usize,
) -> Result<Vec<InstanceRow>, String> {
    if end <= start {
        return Ok(Vec::new());
    }
    let nrows = end - start;
    if file.group("instances").is_ok() {
        let itype = read_f64_column_slice(
            &file
                .dataset("instances/instance_type")
                .map_err(|e| format!("{e}"))?,
            start,
            end,
        )?;
        let skel = read_f64_column_slice(
            &file
                .dataset("instances/skeleton")
                .map_err(|e| format!("{e}"))?,
            start,
            end,
        )?;
        let pstart = read_f64_column_slice(
            &file
                .dataset("instances/point_id_start")
                .map_err(|e| format!("{e}"))?,
            start,
            end,
        )?;
        let pend = read_f64_column_slice(
            &file
                .dataset("instances/point_id_end")
                .map_err(|e| format!("{e}"))?,
            start,
            end,
        )?;
        let track = file
            .dataset("instances/track")
            .ok()
            .and_then(|d| read_f64_column_slice(&d, start, end).ok());
        let score = file
            .dataset("instances/score")
            .ok()
            .and_then(|d| read_f64_column_slice(&d, start, end).ok());

        let mut out = Vec::with_capacity(nrows);
        for i in 0..nrows {
            out.push(InstanceRow {
                instance_type: itype.get(i).copied().unwrap_or(0.0) as i32,
                skeleton: skel.get(i).copied().unwrap_or(0.0) as i32,
                track: track
                    .as_ref()
                    .and_then(|c| c.get(i))
                    .copied()
                    .unwrap_or(-1.0) as i32,
                score: score
                    .as_ref()
                    .and_then(|c| c.get(i))
                    .copied()
                    .unwrap_or(f64::NAN),
                point_start: pstart.get(i).copied().unwrap_or(0.0).max(0.0) as usize,
                point_end: pend.get(i).copied().unwrap_or(0.0).max(0.0) as usize,
            });
        }
        return Ok(out);
    }

    let ds = file
        .dataset("instances")
        .map_err(|e| format!("Failed opening /instances: {e}"))?;
    let cols = read_table_rows_slice(&ds, start, end)?;
    let mut out = Vec::with_capacity(nrows);
    for i in 0..nrows {
        out.push(InstanceRow {
            instance_type: cols
                .get("instance_type")
                .and_then(|c| c.get(i))
                .copied()
                .unwrap_or(0.0) as i32,
            skeleton: cols
                .get("skeleton")
                .and_then(|c| c.get(i))
                .copied()
                .unwrap_or(0.0) as i32,
            track: cols
                .get("track")
                .and_then(|c| c.get(i))
                .copied()
                .unwrap_or(-1.0) as i32,
            score: cols
                .get("score")
                .and_then(|c| c.get(i))
                .copied()
                .unwrap_or(f64::NAN),
            point_start: cols
                .get("point_id_start")
                .and_then(|c| c.get(i))
                .copied()
                .unwrap_or(0.0)
                .max(0.0) as usize,
            point_end: cols
                .get("point_id_end")
                .and_then(|c| c.get(i))
                .copied()
                .unwrap_or(0.0)
                .max(0.0) as usize,
        });
    }
    Ok(out)
}

fn read_points_slice(
    file: &Hdf5File,
    table: &str,
    start: usize,
    end: usize,
) -> Result<Vec<PointPose>, String> {
    if end <= start {
        return Ok(Vec::new());
    }
    let nrows = end - start;
    if file.group(table).is_ok() {
        let xs = read_f64_column_slice(
            &file
                .dataset(&format!("{table}/x"))
                .map_err(|e| format!("{e}"))?,
            start,
            end,
        )?;
        let ys = read_f64_column_slice(
            &file
                .dataset(&format!("{table}/y"))
                .map_err(|e| format!("{e}"))?,
            start,
            end,
        )?;
        let vis = file
            .dataset(&format!("{table}/visible"))
            .ok()
            .and_then(|d| read_f64_column_slice(&d, start, end).ok());
        let ver = file
            .dataset(&format!("{table}/verified"))
            .or_else(|_| file.dataset(&format!("{table}/complete")))
            .ok()
            .and_then(|d| read_f64_column_slice(&d, start, end).ok());
        let scores = file
            .dataset(&format!("{table}/score"))
            .ok()
            .and_then(|d| read_f64_column_slice(&d, start, end).ok());

        let mut out = Vec::with_capacity(nrows);
        for i in 0..nrows {
            let x = xs.get(i).copied().unwrap_or(f64::NAN);
            let y = ys.get(i).copied().unwrap_or(f64::NAN);
            let visible = vis
                .as_ref()
                .and_then(|c| c.get(i))
                .map(|&v| v != 0.0)
                .unwrap_or(x.is_finite() && y.is_finite())
                && x.is_finite()
                && y.is_finite();
            let verified = ver
                .as_ref()
                .and_then(|c| c.get(i))
                .map(|&v| v != 0.0)
                .unwrap_or(false);
            let score = scores
                .as_ref()
                .and_then(|c| c.get(i))
                .copied()
                .filter(|s| s.is_finite());
            out.push(PointPose {
                x: if x.is_finite() { x } else { -1.0 },
                y: if y.is_finite() { y } else { -1.0 },
                visible,
                verified,
                score,
            });
        }
        return Ok(out);
    }

    let ds = file
        .dataset(table)
        .map_err(|e| format!("Failed opening /{table}: {e}"))?;
    let cols = read_table_rows_slice(&ds, start, end)?;
    let mut out = Vec::with_capacity(nrows);
    for i in 0..nrows {
        let x = cols.get("x").and_then(|c| c.get(i)).copied().unwrap_or(f64::NAN);
        let y = cols.get("y").and_then(|c| c.get(i)).copied().unwrap_or(f64::NAN);
        let vis_raw = cols
            .get("visible")
            .and_then(|c| c.get(i))
            .map(|&v| v != 0.0)
            .unwrap_or(true);
        let visible = vis_raw && x.is_finite() && y.is_finite();
        let verified = cols
            .get("verified")
            .or_else(|| cols.get("complete"))
            .and_then(|c| c.get(i))
            .map(|&v| v != 0.0)
            .unwrap_or(false);
        let score = cols
            .get("score")
            .and_then(|c| c.get(i))
            .copied()
            .filter(|s| s.is_finite());
        out.push(PointPose {
            x: if x.is_finite() { x } else { -1.0 },
            y: if y.is_finite() { y } else { -1.0 },
            visible,
            verified,
            score,
        });
    }
    Ok(out)
}

fn read_bboxes_map(
    file: &Hdf5File,
    root_group_set: &HashSet<String>,
    root_ds_set: &HashSet<String>,
    video_group_id_to_index: &HashMap<usize, usize>,
) -> HashMap<(usize, u64), Vec<BBoxPose>> {
    let mut map: HashMap<(usize, u64), Vec<BBoxPose>> = HashMap::new();
    let cols = if root_group_set.contains("bboxes") {
        let mut c = HashMap::new();
        for name in ["x1", "y1", "x2", "y2", "video", "frame_idx", "is_predicted", "track", "score"] {
            if let Ok(ds) = file.dataset(&format!("bboxes/{name}")) {
                if let Ok(v) = read_f64_column_full(&ds) {
                    c.insert(name.to_string(), v);
                }
            }
        }
        c
    } else if root_ds_set.contains("bboxes") {
        let Ok(ds) = file.dataset("bboxes") else {
            return map;
        };
        let n = ds.shape().first().copied().unwrap_or(0) as usize;
        read_table_rows_slice(&ds, 0, n).unwrap_or_default()
    } else {
        return map;
    };

    let (Some(x1), Some(y1), Some(x2), Some(y2), Some(vid), Some(fidx)) = (
        cols.get("x1"),
        cols.get("y1"),
        cols.get("x2"),
        cols.get("y2"),
        cols.get("video"),
        cols.get("frame_idx"),
    ) else {
        return map;
    };
    let n = x1.len().min(y1.len()).min(x2.len()).min(y2.len()).min(vid.len()).min(fidx.len());
    let is_pred = cols.get("is_predicted");
    let track = cols.get("track");
    let score = cols.get("score");

    for i in 0..n {
        if !(x1[i].is_finite() && y1[i].is_finite() && x2[i].is_finite() && y2[i].is_finite()) {
            continue;
        }
        let raw_v = vid[i].max(0.0) as usize;
        let v_idx = if root_group_set.contains("bboxes") {
            raw_v
        } else {
            video_group_id_to_index.get(&raw_v).copied().unwrap_or(raw_v)
        };
        let frame_idx = fidx[i].max(0.0) as u64;
        let row = BBoxRow {
            video_idx: v_idx,
            frame_idx,
            pose: BBoxPose {
                x1: x1[i],
                y1: y1[i],
                x2: x2[i],
                y2: y2[i],
                is_predicted: is_pred.and_then(|c| c.get(i)).map(|&v| v != 0.0).unwrap_or(false),
                track_idx: track
                    .and_then(|c| c.get(i))
                    .copied()
                    .filter(|&v| v.is_finite() && v >= 0.0)
                    .map(|v| v as usize),
                score: score.and_then(|c| c.get(i)).copied().filter(|s| s.is_finite()),
            },
        };
        map.entry((row.video_idx, row.frame_idx))
            .or_default()
            .push(row.pose);
    }
    map
}

fn table_row_count(
    file: &Hdf5File,
    table: &str,
    column: &str,
    root_group_set: &HashSet<String>,
    root_ds_set: &HashSet<String>,
) -> usize {
    if root_group_set.contains(table) {
        file.dataset(&format!("{table}/{column}"))
            .ok()
            .and_then(|d| d.shape().first().copied())
            .unwrap_or(0) as usize
    } else if root_ds_set.contains(table) {
        file.dataset(table)
            .ok()
            .and_then(|d| d.shape().first().copied())
            .unwrap_or(0) as usize
    } else {
        0
    }
}

fn dataset_len(file: &Hdf5File, name: &str, root_ds_set: &HashSet<String>) -> usize {
    if !root_ds_set.contains(name) {
        return 0;
    }
    file.dataset(name)
        .ok()
        .and_then(|d| d.shape().first().copied())
        .unwrap_or(0) as usize
}

fn nested_dataset_len(file: &Hdf5File, path: &str, root_group_set: &HashSet<String>) -> usize {
    let Some(top) = path.split('/').next() else {
        return 0;
    };
    if !root_group_set.contains(top) {
        return 0;
    }
    file.dataset(path)
        .ok()
        .and_then(|d| d.shape().first().copied())
        .unwrap_or(0) as usize
}

fn count_user_vs_predicted_instances(
    file: &Hdf5File,
    root_group_set: &HashSet<String>,
    root_ds_set: &HashSet<String>,
    total: usize,
) -> (usize, usize) {
    if total == 0 {
        return (0, 0);
    }
    // Avoid reading massive instance tables in full (>500k rows) during open
    if total > 500_000 {
        return (0, 0);
    }
    if root_group_set.contains("instances") {
        if let Ok(ds) = file.dataset("instances/instance_type") {
            if let Ok(vals) = read_f64_column_full(&ds) {
                let pred = vals.iter().filter(|&&v| (v as i32) == 1).count();
                return (vals.len().saturating_sub(pred), pred);
            }
        }
    } else if root_ds_set.contains("instances") {
        if let Ok(ds) = file.dataset("instances") {
            if let Ok(cols) = read_table_rows_slice(&ds, 0, total) {
                if let Some(vals) = cols.get("instance_type") {
                    let pred = vals.iter().filter(|&&v| (v as i32) == 1).count();
                    return (vals.len().saturating_sub(pred), pred);
                }
            }
        }
    }
    (0, 0)
}

fn read_preview_index(
    file: &Hdf5File,
    root_group_set: &HashSet<String>,
) -> Vec<PreviewImageRecord> {
    if !root_group_set.contains("preview") {
        return Vec::new();
    }
    let (Some(video), Some(frame_idx), Some(data_start), Some(data_end)) = (
        read_u64_column(file, "preview/video"),
        read_u64_column(file, "preview/frame_idx"),
        read_u64_column(file, "preview/data_start"),
        read_u64_column(file, "preview/data_end"),
    ) else {
        return Vec::new();
    };
    let n = video
        .len()
        .min(frame_idx.len())
        .min(data_start.len())
        .min(data_end.len());
    if n == 0 {
        return Vec::new();
    }
    let width = read_u64_column(file, "preview/width");
    let height = read_u64_column(file, "preview/height");
    let orig_width = read_u64_column(file, "preview/orig_width");
    let orig_height = read_u64_column(file, "preview/orig_height");

    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let w = width.as_ref().and_then(|c| c.get(i)).copied().unwrap_or(0) as u32;
        let h = height.as_ref().and_then(|c| c.get(i)).copied().unwrap_or(0) as u32;
        let ow = orig_width
            .as_ref()
            .and_then(|c| c.get(i))
            .copied()
            .unwrap_or(w as u64) as u32;
        let oh = orig_height
            .as_ref()
            .and_then(|c| c.get(i))
            .copied()
            .unwrap_or(h as u64) as u32;
        out.push(PreviewImageRecord {
            video_idx: video[i] as usize,
            frame_idx: frame_idx[i],
            orig_width: ow,
            orig_height: oh,
            width: w,
            height: h,
            data_start: data_start[i],
            data_end: data_end[i],
        });
    }
    out
}

fn build_preview_frames(
    frames: &[FrameRow],
    embedded_videos: &HashMap<usize, EmbeddedVideoIndex>,
    preview_records: &[PreviewImageRecord],
    preview_images: &HashMap<(usize, u64), PreviewImageRecord>,
    max_entries: usize,
) -> Vec<PreviewFrameEntry> {
    if frames.is_empty() {
        // Fallback for video-only .pkg.slp or preview-only linked .slp with no labeled frames
        let mut out = Vec::new();
        let mut seen: HashSet<(usize, u64)> = HashSet::new();
        for rec in preview_records.iter().take(max_entries) {
            if seen.insert((rec.video_idx, rec.frame_idx)) {
                out.push(PreviewFrameEntry {
                    row_idx: None,
                    video_idx: rec.video_idx,
                    frame_idx: rec.frame_idx,
                    instance_count: 0,
                    has_embedded_image: false,
                    has_preview_image: true,
                    is_negative: false,
                });
            }
        }
        let mut vid_keys: Vec<usize> = embedded_videos.keys().copied().collect();
        vid_keys.sort_unstable();
        for v_idx in vid_keys {
            if let Some(emb) = embedded_videos.get(&v_idx) {
                for &fnum in emb
                    .frame_numbers
                    .iter()
                    .take(max_entries.saturating_sub(out.len()))
                {
                    if seen.insert((v_idx, fnum)) {
                        out.push(PreviewFrameEntry {
                            row_idx: None,
                            video_idx: v_idx,
                            frame_idx: fnum,
                            instance_count: 0,
                            has_embedded_image: true,
                            has_preview_image: preview_images.contains_key(&(v_idx, fnum)),
                            is_negative: false,
                        });
                    }
                }
            }
        }
        return out;
    }

    let make_entry = |row_idx: usize, fr: &FrameRow| -> PreviewFrameEntry {
        let has_emb = embedded_videos
            .get(&fr.video_idx)
            .map(|e| e.frame_to_pos.contains_key(&fr.frame_idx) || e.frame_to_pos.is_empty())
            .unwrap_or(false);
        let has_prev = preview_images.contains_key(&(fr.video_idx, fr.frame_idx));
        PreviewFrameEntry {
            row_idx: Some(row_idx),
            video_idx: fr.video_idx,
            frame_idx: fr.frame_idx,
            instance_count: fr.inst_end.saturating_sub(fr.inst_start),
            has_embedded_image: has_emb,
            has_preview_image: has_prev,
            is_negative: fr.is_negative,
        }
    };

    let mut out = if frames.len() <= max_entries {
        frames
            .iter()
            .enumerate()
            .map(|(i, fr)| make_entry(i, fr))
            .collect::<Vec<_>>()
    } else {
        // Evenly sample up to `max_entries` across the file, keeping first & last,
        // AND always include any frame that has a `/preview` image!
        let mut chosen: Vec<usize> = Vec::with_capacity(max_entries + preview_records.len());
        let mut chosen_set: HashSet<usize> = HashSet::new();
        let last = frames.len() - 1;
        for k in 0..max_entries {
            let idx = (k * last) / (max_entries - 1);
            if chosen_set.insert(idx) {
                chosen.push(idx);
            }
        }
        if !preview_images.is_empty() {
            for (i, fr) in frames.iter().enumerate() {
                if preview_images.contains_key(&(fr.video_idx, fr.frame_idx)) && chosen_set.insert(i) {
                    chosen.push(i);
                }
            }
        }
        chosen.sort_unstable();
        chosen.into_iter().map(|i| make_entry(i, &frames[i])).collect()
    };

    // If a /preview image points to an unlabeled frame not present in /frames, include it too!
    if !preview_records.is_empty() {
        let present: HashSet<(usize, u64)> = out.iter().map(|e| (e.video_idx, e.frame_idx)).collect();
        for rec in preview_records {
            if !present.contains(&(rec.video_idx, rec.frame_idx)) {
                out.insert(
                    0,
                    PreviewFrameEntry {
                        row_idx: None,
                        video_idx: rec.video_idx,
                        frame_idx: rec.frame_idx,
                        instance_count: 0,
                        has_embedded_image: false,
                        has_preview_image: true,
                        is_negative: false,
                    },
                );
            }
        }
    }

    out
}

fn build_timeline_histogram(
    frames: &[FrameRow],
    videos: &[VideoInfo],
    bins: usize,
) -> Vec<u32> {
    let mut hist = vec![0u32; bins];
    if frames.is_empty() || bins == 0 {
        return hist;
    }
    // Use video 0's frame extent (or max frame_idx across frames)
    let max_frame = videos
        .first()
        .and_then(|v| v.frame_count)
        .unwrap_or(0)
        .max(frames.iter().map(|f| f.frame_idx + 1).max().unwrap_or(1));
    for fr in frames {
        let b = ((fr.frame_idx as f64 / max_frame as f64) * (bins as f64))
            .floor()
            .clamp(0.0, (bins - 1) as f64) as usize;
        hist[b] = hist[b].saturating_add(1);
    }
    hist
}
