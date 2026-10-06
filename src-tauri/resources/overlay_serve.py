"""overlay-serve Phase-1 prototype (portable, in-memory raw-pixel input).

A warm sleap-nn top-down predictor behind a tiny loopback HTTP server. The model
is loaded ONCE at startup; each `POST /infer` runs a forward pass on the frame's
raw pixels sent in the request body (NO server-side video read / seek) and returns
the centroid confidence map as raw uint8 bytes, with coordinate metadata in
response headers. CORS headers are set so a crossOriginIsolated app can fetch it.

Portable across two envs (same script, no edits):
  * the app's real sleap-nn (uv-tool release install: sleap_nn 0.3.1, sleap_io
    0.9.2, skia present) -- no shims fire.
  * a scrappy dev checkout env (editable sleap-nn, stale sleap_io 0.2.0, no skia)
    -- the two shims below fire conditionally.
Each shim is guarded so it is a no-op in a clean env.

Request body for POST /infer:
  a one-line JSON header, then a newline, then w*h*ch raw pixel bytes:
    {"w":1024,"h":1024,"ch":1,"dtype":"uint8"}\n<raw bytes...>

Env vars:
  OVERLAY_CENTROID / OVERLAY_CI : model dirs (required in practice).
  OVERLAY_DEVICE                : "mps" (default) | "cpu" | "cuda".
  OVERLAY_SLEAP_IO              : sibling sleap-io checkout to shadow a too-old
                                  sleap_io with (only used if needed).

Run:
  <sleap-nn-python> overlay_serve.py
Prints:  OVERLAY_SERVE_READY port=<port>
"""

import os
import sys
import types
import json
import time
import threading
import importlib.util

import numpy as np

# ---------------------------------------------------------------------------
# Shim 1 (conditional): if the resolved sleap_io on disk is too old (has no
# io/skeleton.py, which newer sleap-nn imports), shadow it with a sibling
# checkout. Checked WITHOUT importing sleap_io (find_spec on a top-level package
# does not execute its __init__), so a clean/new env is untouched.
def _maybe_shadow_sleap_io():
    try:
        spec = importlib.util.find_spec("sleap_io")
    except Exception:
        spec = None
    locs = list(getattr(spec, "submodule_search_locations", []) or []) if spec else []
    has_skeleton = any(os.path.exists(os.path.join(p, "io", "skeleton.py")) for p in locs)
    if has_skeleton:
        return None  # clean env -- nothing to do
    checkout = os.environ.get("OVERLAY_SLEAP_IO", "/Users/amickl/repos/sleap-io")
    if os.path.exists(os.path.join(checkout, "sleap_io", "io", "skeleton.py")):
        if checkout not in sys.path:
            sys.path.insert(0, checkout)
        return checkout
    return None  # nothing better available; let the real import error surface


_SHADOWED_IO = _maybe_shadow_sleap_io()

# ---------------------------------------------------------------------------
# Shim 2 (conditional): sleap-nn's training-time augmentation module does a
# top-level `import skia` (optional dep, unused during inference) and evaluates
# skia.* in function annotations at def-time. If skia isn't installed, inject a
# permissive stub so the import chain survives. No-op when skia is present.
def _maybe_stub_skia():
    try:
        import skia  # noqa: F401
        return False
    except Exception:
        pass

    class _Any:
        def __getattr__(self, _):
            return _Any()

        def __call__(self, *a, **k):
            return _Any()

    def _skia_getattr(name):
        # Let dunders fail normally so inspect/torch don't treat this stub as a
        # real on-disk module while walking sys.modules.
        if name.startswith("__") and name.endswith("__"):
            raise AttributeError(name)
        return _Any()

    mod = types.ModuleType("skia")
    mod.__getattr__ = _skia_getattr  # type: ignore[attr-defined]
    sys.modules["skia"] = mod
    return True


_STUBBED_SKIA = _maybe_stub_skia()

# ---------------------------------------------------------------------------
import torch  # noqa: E402
import torchvision.transforms.functional as F  # noqa: E402
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402
from omegaconf import OmegaConf  # noqa: E402
from sleap_nn.inference.predictors import Predictor  # noqa: E402
from sleap_nn.data.resizing import apply_sizematcher  # noqa: E402

# Model directories: OVERLAY_MODELS is an os.pathsep-joined list (top-down =
# centroid + centered-instance, in any order — from_model_paths detects the type
# from each dir's training_config). Falls back to the flies13 pair for standalone
# runs without OVERLAY_MODELS set.
_models_env = os.environ.get("OVERLAY_MODELS", "")
MODEL_PATHS = [p for p in _models_env.split(os.pathsep) if p] or [
    "/Volumes/talmo/amick/sleap-app-test-files/flies_13/models/260428_082921.centroid.n=2560",
    "/Volumes/talmo/amick/sleap-app-test-files/flies_13/models/260428_113349.centered_instance.n=2560",
]
DEVICE = os.environ.get("OVERLAY_DEVICE", "mps")

_predictor = None
_lock = threading.Lock()  # one model, serialize forward passes


def build_predictor(device):
    # from_model_paths -> from_trained_models assumes a non-None preprocess_config
    # (it assigns preprocess_config["scale"] with no None-guard, in both 0.3.1 and
    # the dev checkout), so supply one explicitly. Must be OmegaConf: it is read by
    # subscript AND by attribute (.crop_size). All keys=None => each stage falls
    # back to its own trained value.
    pc = OmegaConf.create(
        {"scale": None, "ensure_rgb": None, "ensure_grayscale": None,
         "max_height": None, "max_width": None, "crop_size": None}
    )
    return Predictor.from_model_paths(
        MODEL_PATHS, return_confmaps=True, device=device, preprocess_config=pc
    )


def infer_pixels(frame):
    """Run the WARM predictor on an already-decoded frame (no video read).

    `frame`: uint8 ndarray, shape (H, W) or (H, W, C) (channels_last, like sio).
    Returns a single (H_out, W_out) float32 confmap — the centroid map for a
    top-down pipeline, or the max-projected node map for a single-instance model
    — or None if the frame produced no detections (top-down only).

    Mirrors VideoReader.run + Predictor._process_batch so the tensor handed to the
    model is byte-identical to the video-read path. The centroid input_scale (0.5)
    and pad-to-stride happen INSIDE the model (CentroidCrop.forward), not here.
    """
    if frame.ndim == 2:
        frame = frame[:, :, None]  # (H, W) -> (H, W, 1)
    img = np.transpose(frame, (2, 0, 1))     # C,H,W
    img = np.expand_dims(img, axis=0)        # (1,C,H,W)
    image = torch.from_numpy(np.ascontiguousarray(img))  # uint8

    pc = _predictor.preprocess_config
    orig_size = torch.Tensor(list(image.shape[-2:])).unsqueeze(0)  # (1,2)=[H,W] pre-sizematch
    image, eff_scale = apply_sizematcher(image, pc["max_height"], pc["max_width"])
    if pc["ensure_rgb"] and image.shape[-3] != 3:
        image = image.repeat(1, 3, 1, 1)
    elif pc["ensure_grayscale"] and image.shape[-3] != 1:
        image = F.rgb_to_grayscale(image, num_output_channels=1)

    imgs = [image.unsqueeze(0)]                       # (1,1,C,H,W)
    fidxs = [torch.tensor(0, dtype=torch.int32)]
    vidxs = [torch.tensor(0, dtype=torch.int32)]
    org_szs = [orig_size.unsqueeze(0)]               # (1,1,2)
    instances = []                                   # instances_key is False for topdown
    eff_scales = [torch.tensor(eff_scale)]

    with _lock:
        _predictor.preprocess = False  # model does its own scale/pad (video-path parity)
        try:
            outputs = list(
                _predictor._run_inference_on_batch(
                    imgs, fidxs, vidxs, org_szs, instances, eff_scales
                )
            )
        except Exception as e:  # noqa: BLE001
            # sleap-nn raises (e.g. torch.cat on an empty instance list, predictors.py)
            # when the model finds NO detections — expected for a blank warmup frame or
            # any frame with no animals. Degrade to "no overlay for this frame" instead
            # of crashing the sidecar.
            print(
                f"[overlay-serve] no detections in frame ({type(e).__name__}: {e}); "
                "skipping confmap",
                flush=True,
            )
            return None
    if not outputs:
        return None
    return _extract_confmap(outputs[0])


# The active head keys we know how to read a confmap from, in priority order.
_HEAD_KEYS = (
    "centroid", "single_instance", "centered_instance",
    "bottomup", "multi_class_bottomup", "multi_class_topdown",
)


def _active_config():
    """The trained config driving the overlay + its head key.

    Top-down uses the CENTROID stage (`centroid_config`); a top-down predictor
    also has a `confmap_config` (the centered-instance stage) which we ignore.
    Single-instance / bottom-up predictors have no `centroid_config`, so fall
    back to `confmap_config` and detect the single non-null head.
    """
    cfg = getattr(_predictor, "centroid_config", None)
    if cfg is not None:
        return cfg, "centroid"
    cfg = getattr(_predictor, "confmap_config", None)
    if cfg is None:
        raise RuntimeError("predictor has neither centroid_config nor confmap_config")
    hc = cfg.model_config.head_configs
    head = next((k for k in _HEAD_KEYS if getattr(hc, k, None) is not None), None)
    if head is None:
        raise RuntimeError("no non-null head in confmap_config.head_configs")
    return cfg, head


def _extract_confmap(output):
    """Reduce a batch-output dict to one (H, W) float32 confmap, or None.

    Handles the top-down centroid map (`pred_centroid_confmaps`, (n_inst, 1, H, W))
    and the single-instance / bottom-up node maps (`pred_confmaps`, (B, N, H, W)):
    take the first batch/instance element and max-project the channel/node dim, so
    a single-instance overlay shows where any node is likely. For top-down the
    channel dim is 1, so this is byte-identical to the old `cc[0, 0]`.
    """
    for key in ("pred_centroid_confmaps", "pred_confmaps"):
        if key not in output or output[key] is None:
            continue
        arr = np.asarray(output[key])
        if arr.ndim == 4:      # (B|n_inst, C|N, H, W)
            return arr[0].max(axis=0).astype(np.float32)
        if arr.ndim == 3:      # (C|N, H, W)
            return arr.max(axis=0).astype(np.float32)
        if arr.ndim == 2:      # (H, W)
            return arr.astype(np.float32)
    return None


def _stride_scale():
    cfg, head = _active_config()
    stride = int(getattr(cfg.model_config.head_configs, head).confmaps.output_stride)
    scale = float(cfg.data_config.preprocessing.scale)
    return stride, scale


def _warmup_frame_hw_ch():
    """Synthetic (H, W, C) size for a video-free warmup, from the active config."""
    pc = _predictor.preprocess_config
    cc, _ = _active_config()
    H = pc["max_height"] or cc.data_config.preprocessing.max_height or 256
    W = pc["max_width"] or cc.data_config.preprocessing.max_width or 256
    # Channels = backbone in_channels (grayscale=1, rgb=3); default 1.
    ch = 1
    try:
        bb = cc.model_config.backbone_config
        for k in ("unet", "convnext", "swint"):
            sub = getattr(bb, k, None)
            if sub is not None and getattr(sub, "in_channels", None) is not None:
                ch = int(sub.in_channels)
                break
    except Exception:
        pass
    return int(H), int(W), int(ch)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Expose-Headers", "*")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            body = b'{"status":"ok"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self._cors()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self._cors()
            self.end_headers()

    def _bad(self, code, msg):
        self.send_response(code)
        self._cors()
        self.end_headers()
        self.wfile.write(str(msg).encode())

    def do_POST(self):
        if self.path != "/infer":
            self.send_response(404)
            self._cors()
            self.end_headers()
            return

        # Body = one JSON header line, a newline, then w*h*ch raw pixel bytes.
        try:
            n = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(n)
            nl = raw.find(b"\n")
            if nl < 0:
                raise ValueError("missing newline between JSON header and pixel bytes")
            hdr = json.loads(raw[:nl] or b"{}")
            pix = raw[nl + 1:]
            w = int(hdr["w"])
            h = int(hdr["h"])
            ch = int(hdr.get("ch", 1))
            dtype = np.dtype(hdr.get("dtype", "uint8"))
            need = w * h * ch * dtype.itemsize
            if len(pix) != need:
                raise ValueError(f"expected {need} pixel bytes, got {len(pix)}")
            frame = np.frombuffer(pix, dtype=dtype).reshape(h, w, ch)
        except Exception as e:  # noqa: BLE001
            self._bad(400, f"bad request: {e}")
            return

        t0 = time.time()
        try:
            cmap = infer_pixels(frame)
        except Exception as e:  # noqa: BLE001
            self._bad(500, f"inference error: {e}")
            return
        ms = (time.time() - t0) * 1000.0

        if cmap is None:
            body = b'{"detections":0}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("X-Infer-Ms", f"{ms:.1f}")
            self._cors()
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        stride, scale = _stride_scale()
        mn, mx = float(cmap.min()), float(cmap.max())
        u8 = (np.clip(cmap, 0.0, 1.0) * 255.0).astype(np.uint8)
        data = u8.tobytes()

        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("X-Shape", f"{cmap.shape[0]},{cmap.shape[1]}")
        self.send_header("X-Output-Stride", str(stride))
        self.send_header("X-Input-Scale", str(scale))
        self.send_header("X-Raw-Min", f"{mn:.4f}")
        self.send_header("X-Raw-Max", f"{mx:.4f}")
        self.send_header("X-Infer-Ms", f"{ms:.1f}")
        self._cors()
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    global _predictor
    shims = []
    if _SHADOWED_IO:
        shims.append(f"sleap_io<-{_SHADOWED_IO}")
    if _STUBBED_SKIA:
        shims.append("skia-stub")
    print(f"[overlay-serve] shims: {shims or 'none (clean env)'}", flush=True)
    print(f"[overlay-serve] sleap_nn={__import__('sleap_nn').__version__} "
          f"torch={torch.__version__} loading on device={DEVICE} ...", flush=True)

    t0 = time.time()
    try:
        _predictor = build_predictor(DEVICE)
        used = DEVICE
    except Exception as e:  # noqa: BLE001
        print(f"[overlay-serve] {DEVICE} build failed ({type(e).__name__}: {e}); using cpu", flush=True)
        _predictor = build_predictor("cpu")
        used = "cpu"

    # Video-free warmup: push a synthetic zero frame through the in-memory path to
    # JIT the centroid kernels. No video is ever opened by this server.
    H, W, ch = _warmup_frame_hw_ch()
    warm_frame = np.zeros((H, W, ch), dtype=np.uint8)
    _ = infer_pixels(warm_frame)
    _ = infer_pixels(warm_frame)  # second pass = steady-state kernels
    print(f"[overlay-serve] model ready on {used} in {time.time() - t0:.1f}s; "
          f"warmup frame=({H},{W},{ch}) (synthetic, video-free)", flush=True)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    print(f"OVERLAY_SERVE_READY port={port} device={used}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
