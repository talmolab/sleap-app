/**
 * Correct the color-range tag of an H.264 mp4 written by WebKit's WebCodecs
 * encoder (the macOS desktop app, and Safari).
 *
 * WebKit's encoder converts the canvas's RGB to LIMITED-range YUV (16–235)
 * but tags the stream FULL range (0–255), in both the mp4 `colr` box and the
 * SPS's VUI `video_full_range_flag`. Every decoder (FFmpeg/OpenCV, the
 * browser) trusts the tag, so the clip reads back washed out: a gray of 50
 * decodes as 61, black as 16. Setting the color space on the frames doesn't
 * change it. Clearing the two flags makes the tags match the samples
 * (measured: a clip's mean error vs its source drops from 15.7 to 1.3 levels,
 * ordinary H.264 loss). Both are single bits, rewritten in place.
 */

/** RBSP bits of a NAL unit, with each RBSP byte's position in the NAL. */
function toRbsp(nal: Uint8Array): { rbsp: Uint8Array; nalIndex: number[] } {
  const rbsp: number[] = [];
  const nalIndex: number[] = [];
  let zeros = 0;
  for (let i = 0; i < nal.length; i++) {
    const b = nal[i];
    if (zeros >= 2 && b === 0x03) {
      zeros = 0; // emulation prevention byte: not part of the RBSP
      continue;
    }
    rbsp.push(b);
    nalIndex.push(i);
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return { rbsp: Uint8Array.from(rbsp), nalIndex };
}

class BitReader {
  pos = 0;
  constructor(private bytes: Uint8Array) {}
  u(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      const byte = this.bytes[this.pos >> 3];
      if (byte === undefined) throw new Error("SPS ended early");
      v = (v << 1) | ((byte >> (7 - (this.pos & 7))) & 1);
      this.pos++;
    }
    return v;
  }
  ue(): number {
    let zeros = 0;
    while (this.u(1) === 0) {
      if (++zeros > 31) throw new Error("bad exp-Golomb code");
    }
    return (1 << zeros) - 1 + (zeros > 0 ? this.u(zeros) : 0);
  }
  se(): number {
    const k = this.ue();
    return k & 1 ? (k + 1) / 2 : -(k / 2);
  }
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

/**
 * The NAL byte index and bit (7 = MSB) of `video_full_range_flag` in an SPS
 * NAL unit (header byte included), or null when it has no video signal type.
 */
export function spsFullRangeFlagPosition(
  nal: Uint8Array
): { byte: number; bit: number } | null {
  const { rbsp, nalIndex } = toRbsp(nal);
  const r = new BitReader(rbsp);
  r.u(8); // NAL header
  const profile = r.u(8);
  r.u(16); // constraint flags + level
  r.ue(); // seq_parameter_set_id
  if (HIGH_PROFILES.has(profile)) {
    const chroma = r.ue();
    if (chroma === 3) r.u(1);
    r.ue(); // bit_depth_luma_minus8
    r.ue(); // bit_depth_chroma_minus8
    r.u(1); // qpprime_y_zero_transform_bypass_flag
    if (r.u(1)) {
      // seq_scaling_matrix_present_flag: skip the scaling lists
      for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) {
        if (!r.u(1)) continue;
        const size = i < 6 ? 16 : 64;
        let last = 8;
        let next = 8;
        for (let j = 0; j < size; j++) {
          if (next !== 0) next = (last + r.se() + 256) % 256;
          last = next === 0 ? last : next;
        }
      }
    }
  }
  r.ue(); // log2_max_frame_num_minus4
  const pocType = r.ue();
  if (pocType === 0) {
    r.ue();
  } else if (pocType === 1) {
    r.u(1);
    r.se();
    r.se();
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se();
  }
  r.ue(); // max_num_ref_frames
  r.u(1); // gaps_in_frame_num_value_allowed_flag
  r.ue(); // pic_width_in_mbs_minus1
  r.ue(); // pic_height_in_map_units_minus1
  if (!r.u(1)) r.u(1); // frame_mbs_only_flag, mb_adaptive_frame_field_flag
  r.u(1); // direct_8x8_inference_flag
  if (r.u(1)) {
    r.ue();
    r.ue();
    r.ue();
    r.ue();
  }
  if (!r.u(1)) return null; // vui_parameters_present_flag
  if (r.u(1) && r.u(8) === 255) r.u(32); // aspect ratio (+ extended SAR)
  if (r.u(1)) r.u(1); // overscan
  if (!r.u(1)) return null; // video_signal_type_present_flag
  r.u(3); // video_format
  const pos = r.pos;
  return { byte: nalIndex[pos >> 3], bit: 7 - (pos & 7) };
}

/** Index of a 4-char box type preceded by a plausible box size, or -1. */
function findBox(bytes: Uint8Array, type: string, from = 4): number {
  const t = [...type].map((c) => c.charCodeAt(0));
  for (let i = from; i + 4 <= bytes.length; i++) {
    if (bytes[i] === t[0] && bytes[i + 1] === t[1] && bytes[i + 2] === t[2] && bytes[i + 3] === t[3]) {
      const size = new DataView(bytes.buffer, bytes.byteOffset + i - 4, 4).getUint32(0);
      if (size >= 8 && i - 4 + size <= bytes.length) return i;
    }
  }
  return -1;
}

/** Whether `a` occurs in `bytes` at `at`. */
function matchesAt(bytes: Uint8Array, a: Uint8Array, at: number): boolean {
  for (let k = 0; k < a.length; k++) if (bytes[at + k] !== a[k]) return false;
  return true;
}

/** True when a NAL payload contains a start-code-like 00 00 0x (x ≤ 3). */
function needsEmulationPrevention(nal: Uint8Array): boolean {
  for (let i = 2; i < nal.length; i++) {
    if (nal[i - 2] === 0 && nal[i - 1] === 0 && nal[i] <= 3) return true;
  }
  return false;
}

/**
 * A copy of `mp4` tagged limited range (the `colr` box's `full_range_flag`
 * and every SPS's `video_full_range_flag` cleared), or null when it isn't
 * tagged full range or the tag can't be changed in place.
 */
export function clearFullRangeTag(mp4: Uint8Array): Uint8Array | null {
  const out = new Uint8Array(mp4);
  let changed = false;

  // colr box (nclx): primaries(2) transfer(2) matrix(2) then full_range_flag (MSB).
  const colr = findBox(out, "colr");
  if (colr >= 0 && matchesAt(out, Uint8Array.from([0x6e, 0x63, 0x6c, 0x78]), colr + 4)) {
    const flags = colr + 4 + 4 + 6;
    if (out[flags] & 0x80) {
      out[flags] &= 0x7f;
      changed = true;
    }
  }

  // avcC: version, profile, compat, level, lengthSize, numSPS, then SPS units.
  const avcc = findBox(out, "avcC");
  if (avcc >= 0) {
    let p = avcc + 4 + 5;
    const numSps = out[p] & 0x1f;
    p += 1;
    for (let s = 0; s < numSps; s++) {
      const len = (out[p] << 8) | out[p + 1];
      p += 2;
      const original = mp4.slice(p, p + len);
      let at: { byte: number; bit: number } | null = null;
      try {
        at = spsFullRangeFlagPosition(original);
      } catch {
        at = null;
      }
      if (at && (original[at.byte] >> at.bit) & 1) {
        const patched = original.slice();
        patched[at.byte] &= ~(1 << at.bit);
        // Clearing a bit must not create a byte pattern that needs an extra
        // escape byte (that would change the length); leave such a file alone.
        if (needsEmulationPrevention(patched.subarray(1)) && !needsEmulationPrevention(original.subarray(1))) {
          return null;
        }
        // The same SPS may also be repeated in the stream: patch every copy.
        for (let i = 0; i + len <= out.length; i++) {
          if (matchesAt(out, original, i)) out.set(patched, i);
        }
        changed = true;
      }
      p += len;
    }
  }
  return changed ? out : null;
}

/** Whether this environment's WebCodecs encoder is WebKit's (see the module doc). */
export function isWebKitEncoder(userAgent: string): boolean {
  return /AppleWebKit/.test(userAgent) && !/Chrome|Chromium|Edg\//.test(userAgent);
}
