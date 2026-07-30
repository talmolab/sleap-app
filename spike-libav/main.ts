/**
 * Linux perf harness for the libav.js H.264 CustomVideoDecoder.
 *
 * Correctness is already proven byte-exact vs native on Mac. This measures the
 * one thing the Mac can't: how fast the WASM decoder runs on Linux hardware.
 *
 * ⚠️ Run this in **Epiphany / GNOME Web** (WebKitGTK) — the same engine the Tauri
 * desktop app uses on Linux — for a representative number. Chrome/Firefox use a
 * faster engine and will read optimistically.
 *
 * For each clip it reports, libav vs native (native = the browser's own decoder,
 * shown only as a reference; on real WebKitGTK-without-codec native may be 0):
 *   • Sequential decode throughput (fps)  → playback / scrubbing
 *   • Jump-to-frame latency (ms)          → the dominant labeling interaction
 *   • A correctness sanity check (max pixel Δ vs native)
 */
import {
  Input,
  BlobSource,
  ALL_FORMATS,
  VideoSampleSink,
  EncodedPacketSink,
  registerDecoder,
} from "mediabunny";
import { LibavH264Decoder, setLibavForced } from "./libavH264Decoder";

const CLIPS = [
  { name: "720p", url: "/perf_720p.mp4" },
  { name: "1080p", url: "/perf_1080p.mp4" },
];
const SEQ_FRAMES = 120; // frames to decode for the throughput number
const SEEK_COUNT = 10; // random jump-to-frame samples

const logEl = document.getElementById("log")!;
const rowsEl = document.getElementById("rows")!;
const verdictEl = document.getElementById("verdict")!;

function log(msg: string): void {
  logEl.textContent += msg + "\n";
  // eslint-disable-next-line no-console
  console.log(msg);
}

registerDecoder(LibavH264Decoder);

async function loadInput(url: string): Promise<Input> {
  const buf = await (await fetch(url)).arrayBuffer();
  return new Input({ source: new BlobSource(new Blob([buf])), formats: ALL_FORMATS });
}

async function frameTimes(input: Input): Promise<number[]> {
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("no video track");
  const ps = new EncodedPacketSink(track);
  const times: number[] = [];
  for await (const p of ps.packets()) times.push(p.timestamp);
  times.sort((a, b) => a - b);
  return times;
}

/** Sequential decode throughput (frames pulled from the sink, timed). */
async function perfSequential(
  url: string,
  n: number,
  useLibav: boolean,
): Promise<{ fps: number; frames: number; dims: string }> {
  setLibavForced(useLibav);
  const input = await loadInput(url);
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("no track");
  const sink = new VideoSampleSink(track);
  let count = 0;
  let dims = "";
  const t0 = performance.now();
  for await (const sample of sink.samples()) {
    if (!dims) dims = `${sample.displayWidth}x${sample.displayHeight}`;
    sample.close();
    if (++count >= n) break;
  }
  const ms = performance.now() - t0;
  return { fps: (count / ms) * 1000, frames: count, dims };
}

/** Jump-to-frame latency: each getSample = keyframe seek + decode forward. */
async function perfSeeks(
  url: string,
  count: number,
  useLibav: boolean,
): Promise<{ avgMs: number; worstMs: number; n: number }> {
  setLibavForced(useLibav);
  const input = await loadInput(url);
  const times = await frameTimes(input);
  const track = await input.getPrimaryVideoTrack();
  if (!track) throw new Error("no track");
  const sink = new VideoSampleSink(track);
  // Spread the seeks across the whole clip (deterministic, no RNG).
  const indices: number[] = [];
  for (let i = 0; i < count; i++) {
    indices.push(Math.floor(((i + 1) / (count + 1)) * times.length));
  }
  const perMs: number[] = [];
  for (const idx of indices) {
    const t0 = performance.now();
    const s = await sink.getSample(times[idx]);
    perMs.push(performance.now() - t0);
    s?.close();
  }
  const avg = perMs.reduce((a, b) => a + b, 0) / perMs.length;
  const worst = Math.max(...perMs);
  return { avgMs: avg, worstMs: worst, n: perMs.length };
}

/** Correctness sanity: sequential decode of a square-pixel clip → byte-exact vs
 * native expected (maxΔ 0). Uses sequential (not seek) so both decoders return
 * the same frame index. */
async function correctness(): Promise<number> {
  const url = "/fixture_synth.mp4";
  const decodeSeq = async (useLibav: boolean, n: number): Promise<ImageData> => {
    setLibavForced(useLibav);
    const input = await loadInput(url);
    const track = await input.getPrimaryVideoTrack();
    const sink = new VideoSampleSink(track!);
    let last: ImageData | null = null;
    let i = 0;
    for await (const s of sink.samples()) {
      const vf = s.toVideoFrame();
      const w = vf.displayWidth || vf.codedWidth;
      const h = vf.displayHeight || vf.codedHeight;
      const cv = new OffscreenCanvas(w, h);
      const ctx = cv.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(vf, 0, 0, w, h);
      last = ctx.getImageData(0, 0, w, h);
      vf.close();
      s.close();
      if (++i >= n) break;
    }
    return last!;
  };
  const a = await decodeSeq(false, 12);
  const b = await decodeSeq(true, 12);
  if (a.width !== b.width || a.height !== b.height) return Infinity;
  let max = 0;
  for (let p = 0; p < a.data.length; p += 4)
    for (let c = 0; c < 3; c++)
      max = Math.max(max, Math.abs(a.data[p + c] - b.data[p + c]));
  return max;
}

function tableRow(cells: string[], head = false): void {
  const row = document.createElement("div");
  row.className = "trow" + (head ? " thead" : "");
  for (const c of cells) {
    const cell = document.createElement("span");
    cell.className = "tcell";
    cell.textContent = c;
    row.appendChild(cell);
  }
  rowsEl.appendChild(row);
}

async function run(): Promise<void> {
  try {
    const ua = navigator.userAgent;
    const isWebKit = /AppleWebKit/.test(ua) && !/Chrome|Chromium/.test(ua);
    log(`User agent: ${ua}`);
    log(
      isWebKit
        ? "✅ Looks like WebKitGTK/Safari-family — representative of the Tauri desktop engine."
        : "⚠️ NOT WebKitGTK (looks like Chrome/Chromium/Firefox) — number is an optimistic upper bound. Prefer Epiphany.",
    );
    verdictEl.className = "pending";
    verdictEl.textContent = "measuring…";

    log("Warming up (loading + compiling the 1.1 MB WASM decoder)…");
    const w0 = performance.now();
    await perfSequential(CLIPS[0].url, 3, true);
    log(`  warmup done in ${Math.round(performance.now() - w0)} ms`);

    const maxD = await correctness().catch(() => Infinity);
    log(
      `Correctness (synthetic clip, byte-exact expected): maxΔ=${maxD} ${maxD <= 6 ? "✅" : "❌ unexpected — report this"}`,
    );

    tableRow(
      ["clip", "decode fps (libav)", "fps (native ref)", "seek ms avg/worst (libav)", "native ref"],
      true,
    );

    const summary: string[] = [];
    for (const clip of CLIPS) {
      log(`\n=== ${clip.name} ===`);
      const seqL = await perfSequential(clip.url, SEQ_FRAMES, true);
      const seqN = await perfSequential(clip.url, SEQ_FRAMES, false).catch(() => null);
      const seekL = await perfSeeks(clip.url, SEEK_COUNT, true);
      const seekN = await perfSeeks(clip.url, SEEK_COUNT, false).catch(() => null);

      log(`  ${clip.name} (${seqL.dims}):`);
      log(`    sequential libav = ${seqL.fps.toFixed(1)} fps  (native ${seqN ? seqN.fps.toFixed(1) : "n/a"} fps)`);
      log(`    jump-to-frame libav = ${seekL.avgMs.toFixed(0)} ms avg / ${seekL.worstMs.toFixed(0)} ms worst  (native ${seekN ? seekN.avgMs.toFixed(0) + " ms" : "n/a"})`);

      tableRow([
        `${clip.name} (${seqL.dims})`,
        `${seqL.fps.toFixed(1)}`,
        seqN ? seqN.fps.toFixed(1) : "n/a",
        `${seekL.avgMs.toFixed(0)} / ${seekL.worstMs.toFixed(0)}`,
        seekN ? `${seekN.avgMs.toFixed(0)}` : "n/a",
      ]);
      summary.push(
        `${clip.name}: ${seqL.fps.toFixed(0)}fps seq, ${seekL.avgMs.toFixed(0)}ms/seek`,
      );
    }

    verdictEl.className = "pass";
    verdictEl.textContent = `DONE — ${summary.join("  ·  ")}  (${isWebKit ? "WebKitGTK ✓" : "not WebKitGTK ⚠️"})`;
    log("\nScreenshot this page (or copy the table) back to Claude.");
  } catch (e) {
    verdictEl.className = "fail";
    verdictEl.textContent = "harness error — see log";
    log(`✗ ${(e as Error).stack ?? String(e)}`);
  }
}

run();
