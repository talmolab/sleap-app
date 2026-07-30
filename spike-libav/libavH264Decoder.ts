/**
 * libav.js-backed H.264 CustomVideoDecoder for mediabunny (SPIKE).
 *
 * Proves this shim, plugged into mediabunny's VideoSampleSink, produces frames
 * matching native WebCodecs on this Mac (correctness). Only Linux perf remains
 * unknown afterward.
 *
 * Strategy:
 *  - Init a bare "h264" decoder (no extradata); convert each AVCC (length-
 *    prefixed) packet to Annex-B and inline the SPS/PPS (parsed from the avcC
 *    `description`) ahead of every keyframe, so the decoder self-configures.
 *  - Decode via ff_decode_multi with copyoutFrame "video_packed" (tight planes),
 *    then emit an I420 VideoSample so the browser does the final YUV->RGB the
 *    same way native does (minimal pixel diff vs native).
 *  - Propagate PTS (seconds) so mediabunny can reorder B-frames / match frames.
 *
 * In production `supports()` must gate on "native cannot decode this config"
 * (async probe, cached) — mediabunny uses a registered decoder unconditionally
 * when supports() is true. Here we gate on a module flag to force on/off.
 */
import { CustomVideoDecoder, EncodedPacket, VideoSample } from "mediabunny";

let FORCED = false;
export function setLibavForced(v: boolean): void {
  FORCED = v;
}

interface LibAVFactory {
  LibAV(opts?: {
    noworker?: boolean;
    nothreads?: boolean;
    base?: string;
  }): Promise<LibAVInstance>;
  base?: string;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LibAVInstance = any;

const PTS_TB = 1_000_000; // microseconds

let libavPromise: Promise<LibAVInstance> | null = null;
async function getLibAV(): Promise<LibAVInstance> {
  if (!libavPromise) {
    libavPromise = (async () => {
      const VARIANT_DIR = "/libav-h264dec";
      const libavUrl = `${location.origin}${VARIANT_DIR}/libav-6.9.8.1-decoder-h264.mjs`;
      const mod = (await import(/* @vite-ignore */ libavUrl)) as {
        default: LibAVFactory;
      };
      const factory = mod.default;
      factory.base = VARIANT_DIR;
      return factory.LibAV({ noworker: true, nothreads: true });
    })();
  }
  return libavPromise;
}

function toU8(buf: AllowSharedBufferSource): Uint8Array {
  if (buf instanceof Uint8Array) return buf;
  if (buf instanceof ArrayBuffer) return new Uint8Array(buf);
  return new Uint8Array((buf as ArrayBufferView).buffer);
}

const START_CODE = new Uint8Array([0, 0, 0, 1]);

export class LibavH264Decoder extends CustomVideoDecoder {
  private libav: LibAVInstance | null = null;
  private c = -1;
  private pkt = -1;
  private frame = -1;
  private nalLen = 4;
  private paramSets = new Uint8Array(0); // SPS/PPS in Annex-B
  private loggedShape = false;

  static supports(codec: string, _config: VideoDecoderConfig): boolean {
    return FORCED && codec === "avc";
  }

  async init(): Promise<void> {
    this.libav = await getLibAV();
    const desc = this.config.description
      ? toU8(this.config.description)
      : undefined;
    if (desc) this.parseAvcC(desc);
    // FFmpeg's h264 decoder is normally registered by name; fall back to the
    // stable codec id (AV_CODEC_ID_H264 = 27) just in case.
    const byName = await this.libav.avcodec_find_decoder_by_name("h264");
    const codecArg = byName ? "h264" : 27;
    [, this.c, this.pkt, this.frame] =
      await this.libav.ff_init_decoder(codecArg);
  }

  /** Parse avcC box -> NAL length size + Annex-B SPS/PPS header. */
  private parseAvcC(d: Uint8Array): void {
    this.nalLen = (d[4] & 0x03) + 1;
    const parts: Uint8Array[] = [];
    let off = 5;
    const numSps = d[off++] & 0x1f;
    for (let i = 0; i < numSps; i++) {
      const len = (d[off] << 8) | d[off + 1];
      off += 2;
      parts.push(START_CODE, d.subarray(off, off + len));
      off += len;
    }
    const numPps = d[off++];
    for (let i = 0; i < numPps; i++) {
      const len = (d[off] << 8) | d[off + 1];
      off += 2;
      parts.push(START_CODE, d.subarray(off, off + len));
      off += len;
    }
    this.paramSets = concat(parts);
  }

  /** AVCC (length-prefixed) -> Annex-B, optionally prefixing SPS/PPS. */
  private avccToAnnexB(data: Uint8Array, includeParams: boolean): Uint8Array {
    const parts: Uint8Array[] = [];
    if (includeParams && this.paramSets.length) parts.push(this.paramSets);
    let off = 0;
    while (off + this.nalLen <= data.length) {
      let len = 0;
      for (let i = 0; i < this.nalLen; i++) len = (len << 8) | data[off + i];
      off += this.nalLen;
      if (len <= 0 || off + len > data.length) break;
      parts.push(START_CODE, data.subarray(off, off + len));
      off += len;
    }
    return concat(parts);
  }

  async decode(packet: EncodedPacket): Promise<void> {
    const isKey = packet.type === "key";
    const annexb = this.avccToAnnexB(toU8(packet.data), isKey);
    const pts = Math.round(packet.timestamp * PTS_TB);
    const frames: LibavFrame[] = await this.libav.ff_decode_multi(
      this.c,
      this.pkt,
      this.frame,
      [
        {
          data: annexb,
          pts,
          ptshi: 0,
          dts: pts,
          dtshi: 0,
          stream_index: 0,
          flags: isKey ? 1 : 0,
        },
      ],
      { fin: false, copyoutFrame: "video_packed" },
    );
    for (const f of frames) this.emit(f);
  }

  async flush(): Promise<void> {
    if (!this.libav || this.c < 0) return;
    const frames: LibavFrame[] = await this.libav.ff_decode_multi(
      this.c,
      this.pkt,
      this.frame,
      [],
      { fin: true, copyoutFrame: "video_packed" },
    );
    for (const f of frames) this.emit(f);
  }

  private emit(f: LibavFrame): void {
    const width = f.width;
    const height = f.height;
    const ptsMicros = f.pts ?? 0;
    const tsSec = ptsMicros / PTS_TB;

    // Propagate non-square pixels (SAR) into displayWidth/Height, matching how
    // native WebCodecs presents the frame.
    let displayWidth = width;
    let displayHeight = height;
    const sar = f.sample_aspect_ratio;
    if (sar && sar[0] > 0 && sar[1] > 0 && sar[0] !== sar[1]) {
      if (sar[0] > sar[1]) displayWidth = Math.round((width * sar[0]) / sar[1]);
      else displayHeight = Math.round((height * sar[1]) / sar[0]);
    }

    if (!this.loggedShape) {
      this.loggedShape = true;
      const expectedI420 = width * height + 2 * ((width >> 1) * (height >> 1));
      // eslint-disable-next-line no-console
      console.log(
        `[libav] frame: coded ${width}x${height} display ${displayWidth}x${displayHeight} sar=${sar} format=${f.format} data=${f.data.length}B expectedI420=${expectedI420}B`,
      );
    }

    // Build a WebCodecs VideoFrame (lets us set displayWidth for SAR), then wrap
    // in a mediabunny VideoSample (which adopts it — don't close vf ourselves).
    const vf = new VideoFrame(f.data as BufferSource, {
      format: "I420",
      codedWidth: width,
      codedHeight: height,
      timestamp: ptsMicros,
      displayWidth,
      displayHeight,
    });
    this.onSample(new VideoSample(vf, { timestamp: tsSec }));
  }

  async close(): Promise<void> {
    if (this.libav && this.c >= 0) {
      try {
        await this.libav.ff_free_decoder(this.c, this.pkt, this.frame);
      } catch {
        /* ignore */
      }
    }
    this.c = this.pkt = this.frame = -1;
  }
}

interface LibavFrame {
  data: Uint8Array;
  width: number;
  height: number;
  format: number;
  pts?: number;
  ptshi?: number;
  sample_aspect_ratio?: [number, number];
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
