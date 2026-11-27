use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct SlpSummary {
    pub path: String,
    pub filename: String,
    pub file_size_bytes: u64,
    pub format_id: f64,
    pub sleap_version: String,
    pub is_format3: bool,
    pub is_pkg: bool,
    pub has_preview_images: bool,
    pub preview_image_count: usize,
    pub skeletons: Vec<SkeletonInfo>,
    pub tracks: Vec<String>,
    pub videos: Vec<VideoInfo>,
    pub counts: CountsInfo,
    pub provenance_summary: Vec<(String, String)>,
    /// Compact list of previewable frames (capped for JSON transport if huge,
    /// keeping embedded frames and evenly-spaced labeled frames).
    pub preview_frames: Vec<PreviewFrameEntry>,
    /// 48-bin density histogram across labeled frames for the timeline sparkline.
    pub timeline_bins: Vec<u32>,
    /// Total time in milliseconds to open & index this file.
    pub open_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkeletonInfo {
    pub name: String,
    pub nodes: Vec<String>,
    pub edges: Vec<[usize; 2]>,
    pub symmetries: Vec<[usize; 2]>,
}

#[derive(Debug, Clone, Serialize)]
pub struct VideoInfo {
    pub index: usize,
    pub filename: String,
    pub display_name: String,
    pub dataset: Option<String>,
    pub embedded: bool,
    pub embedded_frame_count: usize,
    pub format: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub channels: Option<u32>,
    pub frame_count: Option<u64>,
    pub fps: Option<f64>,
    pub channel_order: Option<String>,
    pub labeled_frame_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct CountsInfo {
    pub labeled_frames: usize,
    pub negative_frames: usize,
    pub instances: usize,
    pub user_instances: usize,
    pub predicted_instances: usize,
    pub user_points: usize,
    pub predicted_points: usize,
    pub tracks: usize,
    pub videos: usize,
    pub embedded_videos: usize,
    pub suggestions: usize,
    pub sessions: usize,
    pub identities: usize,
    pub categories: usize,
    pub bboxes: usize,
    pub masks: usize,
    pub rois: usize,
    pub label_images: usize,
    pub events: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct PreviewFrameEntry {
    /// Row index in `/frames` table (passed back to `slp_frame_poses_json`), or None if video-only.
    pub row_idx: Option<usize>,
    /// Video array index (passed back to `slp_frame_image`).
    pub video_idx: usize,
    /// Frame number within that video.
    pub frame_idx: u64,
    pub instance_count: usize,
    pub has_embedded_image: bool,
    pub has_preview_image: bool,
    pub is_negative: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct FramePoses {
    pub row_idx: usize,
    pub video_idx: usize,
    pub frame_idx: u64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub instances: Vec<InstancePose>,
    pub bboxes: Vec<BBoxPose>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InstancePose {
    pub is_predicted: bool,
    pub skeleton_idx: usize,
    pub track_idx: Option<usize>,
    pub score: Option<f64>,
    pub points: Vec<PointPose>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PointPose {
    pub x: f64,
    pub y: f64,
    pub visible: bool,
    pub verified: bool,
    pub score: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BBoxPose {
    pub x1: f64,
    pub y1: f64,
    pub x2: f64,
    pub y2: f64,
    pub is_predicted: bool,
    pub track_idx: Option<usize>,
    pub score: Option<f64>,
}

#[derive(Debug, Clone)]
pub struct DecodedImage {
    pub bytes: Vec<u8>,
    /// 0 = encoded PNG/JPEG, 1 = raw pixels
    pub kind: i32,
    pub width: i32,
    pub height: i32,
    pub channels: i32,
    pub is_bgr: bool,
    pub orig_width: i32,
    pub orig_height: i32,
    pub is_preview: bool,
}
