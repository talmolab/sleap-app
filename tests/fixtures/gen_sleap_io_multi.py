# Run with Python sleap-io 0.10: python gen_sleap_io_multi.py <out dir>
"""Small 2.x packages written by Python sleap-io (legacy_format=True) for the
app's in-place save tests: four videos (two colour of the same size, one
grayscale, one with no labeled frames), and a SLEAP 1.x-style variant without
backend.shape in videos_json and without the frames attribute.

Everything is written from inside the output directory with relative names,
so the packages record no path of the machine they were made on: any
absolute path the save still records is made relative, each package is
copied into a fresh file (so no stale bytes remain), and the script fails if
a path of this machine (its directories, the home directory) or a /home/,
/Users/ or /tmp/ path is left in the raw bytes or in any decoded string.
"""
import json
import os
import sys

import h5py
import numpy as np
import sleap_io as sio

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
START_DIR = os.getcwd()
os.chdir(sys.argv[1])
OUT_DIR = os.getcwd()
# Paths of the machine running this (worked out here, not written in), and
# the usual roots of user paths.
FORBIDDEN = sorted(
    {OUT_DIR, SCRIPT_DIR, START_DIR, os.path.expanduser("~"), "/home/", "/Users/", "/tmp/"}
    - {"", "/", "~"}
)


def mkvid(name, n, h, w):
    yy, xx = np.mgrid[0:h, 0:w]
    frames = np.stack(
        [np.stack([(xx * 7 + yy * 3 + i * 9 + c * 60) % 256 for c in range(3)], -1) for i in range(n)]
    ).astype(np.uint8)
    path = f"{name}.mp4"
    sio.save_video(frames, path, fps=30)
    return path


def relative(text):
    """Make every path under the output directory relative to it."""
    return text.replace(OUT_DIR + os.sep, "").replace(OUT_DIR, ".")


def scrub(src, dst, edit_videos=None):
    """Copy `src` into a fresh file `dst`, with paths made relative.

    String datasets and string attributes are rewritten; `edit_videos` may
    change the parsed videos_json entries and the file before copying.
    """
    tmp = dst + ".tmp"
    with h5py.File(src, "r") as fin, h5py.File(tmp, "w") as fout:
        for key in fin.keys():
            fin.copy(fin[key], fout, name=key)
        for k, v in fin.attrs.items():
            fout.attrs[k] = v

        def fix_attrs(obj):
            for k, v in list(obj.attrs.items()):
                if isinstance(v, bytes):
                    v = v.decode()
                if isinstance(v, str) and relative(v) != v:
                    obj.attrs[k] = relative(v)

        def fix_strings(name, obj):
            fix_attrs(obj)
            if isinstance(obj, h5py.Dataset) and h5py.check_string_dtype(obj.dtype):
                values = [x.decode() if isinstance(x, bytes) else x for x in obj[()].ravel()]
                fixed = [relative(x) for x in values]
                if fixed != values:
                    data = np.array(fixed, dtype=object).reshape(obj.shape)
                    parent, leaf = obj.parent, name.rsplit("/", 1)[-1]
                    attrs = dict(obj.attrs)
                    del parent[leaf]
                    new = parent.create_dataset(leaf, data=data, dtype=h5py.string_dtype())
                    for k, v in attrs.items():
                        new.attrs[k] = v

        fix_attrs(fout)
        fout.visititems(fix_strings)

        if edit_videos:
            vj = [json.loads(v) for v in fout["videos_json"][:]]
            vj = edit_videos(fout, vj)
            del fout["videos_json"]
            fout.create_dataset(
                "videos_json",
                data=np.array([json.dumps(d, separators=(",", ":")) for d in vj], dtype=object),
                dtype=h5py.string_dtype(),
            )
    # Copy once more so the edits above leave no stale bytes behind.
    with h5py.File(tmp, "r") as fin, h5py.File(dst, "w") as fout:
        for key in fin.keys():
            fin.copy(fin[key], fout, name=key)
        for k, v in fin.attrs.items():
            fout.attrs[k] = v
    os.remove(tmp)


def check_no_paths(path):
    raw = open(path, "rb").read()
    for bad in FORBIDDEN:
        assert bad.encode() not in raw, f"{path} holds {bad!r} in its bytes"
    found = []

    def look(text, where):
        for bad in FORBIDDEN:
            if bad in text:
                found.append(f"{where}: {bad}")

    def visit(name, obj):
        for k, v in obj.attrs.items():
            look(v.decode() if isinstance(v, bytes) else str(v), f"{name}@{k}")
        if isinstance(obj, h5py.Dataset) and h5py.check_string_dtype(obj.dtype):
            for x in obj[()].ravel():
                look(x.decode() if isinstance(x, bytes) else str(x), name)

    with h5py.File(path, "r") as f:
        for k, v in f.attrs.items():
            look(str(v), f"/@{k}")
        f.visititems(visit)
    assert not found, f"{path} holds absolute paths: {found}"


pa, pb, pc, pd = mkvid("vA", 12, 24, 32), mkvid("vB", 12, 24, 32), mkvid("vC", 12, 24, 32), mkvid("vD", 15, 30, 40)
skel = sio.Skeleton(["head", "tail"])
va, vb, vc, vd = (sio.Video.from_filename(p) for p in (pa, pb, pc, pd))
vc.grayscale = True


def inst(x):
    return sio.Instance.from_numpy(np.array([[x, 10.0], [x + 5, 20.0]]), skeleton=skel)


lfs = [
    sio.LabeledFrame(video=va, frame_idx=2, instances=[inst(5)]),
    sio.LabeledFrame(video=va, frame_idx=5, instances=[inst(6)]),
    sio.LabeledFrame(video=vb, frame_idx=3, instances=[inst(7)]),
    sio.LabeledFrame(video=vc, frame_idx=4, instances=[inst(8)]),
]
labels = sio.Labels(labeled_frames=lfs, videos=[va, vb, vc, vd], skeletons=[skel])
MULTI = "sleap_io_multi.pkg.slp"
LEGACY = "sleap_io_multi_noshape.pkg.slp"
labels.save(MULTI, embed="user", legacy_format=True)
scrub(MULTI, "scrubbed.pkg.slp")
os.replace("scrubbed.pkg.slp", MULTI)


def noshape(f, vj):
    for d in vj:
        d["backend"].pop("shape", None)
        ds = d["backend"].get("dataset")
        if ds and ds in f and "frames" in f[ds].attrs:
            del f[ds].attrs["frames"]
    return vj


scrub(MULTI, LEGACY, edit_videos=noshape)

for p in (MULTI, LEGACY):
    check_no_paths(p)
    with h5py.File(p, "r") as f:
        print(p, "format", f["metadata"].attrs["format_id"], "points", f["points"].dtype, "chunks", f["points"].chunks)
        for i, v in enumerate(f["videos_json"][:]):
            d = json.loads(v)
            b = d.get("backend", {})
            ds = b.get("dataset")
            extra = ""
            if ds and ds in f:
                attrs = {k: (a.item() if hasattr(a, "item") else a) for k, a in f[ds].attrs.items()}
                extra = f" attrs={attrs} fn={f[ds.rsplit('/', 1)[0] + '/frame_numbers'][:].tolist()}"
            src = d.get("source_video", {}).get("backend", {}).get("filename")
            print(f"  v{i} filename={b.get('filename')} dataset={ds} shape={b.get('shape')} source={src}{extra}")
