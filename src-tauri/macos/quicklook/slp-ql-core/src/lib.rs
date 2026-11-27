pub mod reader;
pub mod types;

use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::Path;

use crate::reader::SlpDocument;

#[repr(C)]
pub struct SlpImageBuf {
    pub data: *mut u8,
    pub len: usize,
    pub kind: i32,
    pub width: i32,
    pub height: i32,
    pub channels: i32,
    pub is_bgr: i32,
    pub orig_width: i32,
    pub orig_height: i32,
    pub is_preview: i32,
}

pub struct SlpHandle {
    doc: SlpDocument,
}

fn into_c_string(s: String) -> *mut c_char {
    match CString::new(s) {
        Ok(cs) => cs.into_raw(),
        Err(_) => CString::new("(invalid utf8/nul)").unwrap().into_raw(),
    }
}

#[no_mangle]
pub unsafe extern "C" fn slp_open(
    path_utf8: *const c_char,
    err_out: *mut *mut c_char,
) -> *mut SlpHandle {
    if !err_out.is_null() {
        *err_out = std::ptr::null_mut();
    }
    if path_utf8.is_null() {
        if !err_out.is_null() {
            *err_out = into_c_string("Null path pointer".into());
        }
        return std::ptr::null_mut();
    }

    let res = catch_unwind(|| {
        let cstr = CStr::from_ptr(path_utf8);
        let path_str = cstr
            .to_str()
            .map_err(|e| format!("Invalid UTF-8 path: {e}"))?;
        SlpDocument::open(Path::new(path_str))
    });

    match res {
        Ok(Ok(doc)) => Box::into_raw(Box::new(SlpHandle { doc })),
        Ok(Err(msg)) => {
            if !err_out.is_null() {
                *err_out = into_c_string(msg);
            }
            std::ptr::null_mut()
        }
        Err(_) => {
            if !err_out.is_null() {
                *err_out = into_c_string("Internal panic opening SLP file".into());
            }
            std::ptr::null_mut()
        }
    }
}

#[no_mangle]
pub unsafe extern "C" fn slp_close(handle: *mut SlpHandle) {
    if !handle.is_null() {
        let _ = catch_unwind(AssertUnwindSafe(|| {
            drop(Box::from_raw(handle));
        }));
    }
}

#[no_mangle]
pub unsafe extern "C" fn slp_summary_json(handle: *const SlpHandle) -> *mut c_char {
    if handle.is_null() {
        return std::ptr::null_mut();
    }
    let res = catch_unwind(AssertUnwindSafe(|| {
        let h = &*handle;
        serde_json::to_string(h.doc.summary()).ok()
    }));
    match res {
        Ok(Some(json)) => into_c_string(json),
        _ => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub unsafe extern "C" fn slp_frame_poses_json(
    handle: *const SlpHandle,
    frame_row_idx: usize,
) -> *mut c_char {
    if handle.is_null() {
        return std::ptr::null_mut();
    }
    let res = catch_unwind(AssertUnwindSafe(|| {
        let h = &*handle;
        let poses = h.doc.frame_poses(frame_row_idx).ok()?;
        serde_json::to_string(&poses).ok()
    }));
    match res {
        Ok(Some(json)) => into_c_string(json),
        _ => std::ptr::null_mut(),
    }
}

#[no_mangle]
pub unsafe extern "C" fn slp_frame_image(
    handle: *const SlpHandle,
    video_idx: usize,
    frame_idx: u64,
    out_buf: *mut SlpImageBuf,
) -> i32 {
    if handle.is_null() || out_buf.is_null() {
        return -1;
    }
    *out_buf = SlpImageBuf {
        data: std::ptr::null_mut(),
        len: 0,
        kind: 0,
        width: 0,
        height: 0,
        channels: 0,
        is_bgr: 0,
        orig_width: 0,
        orig_height: 0,
        is_preview: 0,
    };

    let res = catch_unwind(AssertUnwindSafe(|| {
        let h = &*handle;
        h.doc.frame_image(video_idx, frame_idx)
    }));

    match res {
        Ok(Ok(Some(img))) => {
            let mut boxed = img.bytes.into_boxed_slice();
            let len = boxed.len();
            let ptr = boxed.as_mut_ptr();
            std::mem::forget(boxed);
            *out_buf = SlpImageBuf {
                data: ptr,
                len,
                kind: img.kind,
                width: img.width,
                height: img.height,
                channels: img.channels,
                is_bgr: if img.is_bgr { 1 } else { 0 },
                orig_width: img.orig_width,
                orig_height: img.orig_height,
                is_preview: if img.is_preview { 1 } else { 0 },
            };
            1
        }
        Ok(Ok(None)) => 0,
        _ => -1,
    }
}

#[no_mangle]
pub unsafe extern "C" fn slp_free_string(ptr: *mut c_char) {
    if !ptr.is_null() {
        let _ = CString::from_raw(ptr);
    }
}

#[no_mangle]
pub unsafe extern "C" fn slp_free_image(buf: SlpImageBuf) {
    if !buf.data.is_null() && buf.len > 0 {
        let slice = std::ptr::slice_from_raw_parts_mut(buf.data, buf.len);
        drop(Box::from_raw(slice));
    }
}
