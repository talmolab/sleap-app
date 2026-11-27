#ifndef SLP_QL_CORE_H
#define SLP_QL_CORE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct SlpHandle SlpHandle;

typedef struct SlpImageBuf {
    uint8_t *data;
    size_t len;
    /** 0 = encoded (PNG/JPEG), 1 = raw interleaved pixels */
    int32_t kind;
    /** Pixel dimensions of the stored image (may be downscaled for /preview). */
    int32_t width;
    int32_t height;
    int32_t channels;
    /** 1 if channel order is BGR (needs R/B swap on 3-channel color), 0 otherwise */
    int32_t is_bgr;
    /** Full original video coordinate space (0 if same as width/height or unknown). */
    int32_t orig_width;
    int32_t orig_height;
    /** 1 if sourced from /preview group, 0 if from embedded videoN/video. */
    int32_t is_preview;
} SlpImageBuf;

/**
 * Open an .slp file for Quick Look previewing.
 * On error returns NULL and writes a heap-allocated UTF-8 error message into *err_out
 * (free with slp_free_string).
 */
SlpHandle *slp_open(const char *path_utf8, char **err_out);

/** Close and free a previously opened handle. */
void slp_close(SlpHandle *handle);

/** Return UTF-8 JSON summary of the project (free with slp_free_string). */
char *slp_summary_json(const SlpHandle *handle);

/**
 * Return UTF-8 JSON for poses & annotations on a specific labeled frame row
 * (0 <= frame_row_idx < labeled_frame_count). Free with slp_free_string.
 */
char *slp_frame_poses_json(const SlpHandle *handle, size_t frame_row_idx);

/**
 * Load a single embedded video frame by (video_idx, frame_idx).
 * Returns 1 if an embedded image was found and populated in out_buf (free with slp_free_image),
 * 0 if no embedded image exists for that frame, or -1 on error.
 */
int32_t slp_frame_image(
    const SlpHandle *handle,
    size_t video_idx,
    uint64_t frame_idx,
    SlpImageBuf *out_buf
);

/** Free a string returned by slp_open / slp_summary_json / slp_frame_poses_json. */
void slp_free_string(char *ptr);

/** Free an image buffer populated by slp_frame_image. */
void slp_free_image(SlpImageBuf buf);

#ifdef __cplusplus
}
#endif

#endif /* SLP_QL_CORE_H */
