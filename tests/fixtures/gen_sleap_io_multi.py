# Run with Python sleap-io 0.10: python gen_sleap_io_multi.py <out dir>
"""Small 2.x packages written by Python sleap-io (legacy_format=True) for the
app's in-place save tests: four videos (two colour of the same size, one
grayscale, one with no labeled frames), and a SLEAP 1.x-style variant without
backend.shape in videos_json and without the frames attribute."""
import sys, json, shutil
import numpy as np, h5py
import sleap_io as sio

out = sys.argv[1]

def mkvid(name, n, h, w):
    yy, xx = np.mgrid[0:h, 0:w]
    frames = np.stack([np.stack([(xx * 7 + yy * 3 + i * 9 + c * 60) % 256 for c in range(3)], -1)
                       for i in range(n)]).astype(np.uint8)
    p = f"{out}/{name}.mp4"
    sio.save_video(frames, p, fps=30)
    return p

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
multi = f"{out}/sleap_io_multi.pkg.slp"
labels.save(multi, embed="user", legacy_format=True)

legacy = f"{out}/sleap_io_multi_noshape.pkg.slp"
shutil.copy(multi, legacy)
with h5py.File(legacy, "r+") as f:
    vj = [json.loads(v) for v in f["videos_json"][:]]
    for i, d in enumerate(vj):
        d["backend"].pop("shape", None)
        ds = d["backend"].get("dataset")
        if ds and ds in f and "frames" in f[ds].attrs:
            del f[ds].attrs["frames"]
    del f["videos_json"]
    f.create_dataset("videos_json", data=np.array([json.dumps(d, separators=(",", ":")) for d in vj], dtype=object), dtype=h5py.string_dtype())

for p in (multi, legacy):
    with h5py.File(p, "r") as f:
        print(p.rsplit("/", 1)[1], "format", f["metadata"].attrs["format_id"], "points", f["points"].dtype, "chunks", f["points"].chunks)
        for i, v in enumerate(f["videos_json"][:]):
            b = json.loads(v).get("backend", {})
            ds = b.get("dataset")
            extra = ""
            if ds and ds in f:
                extra = f" attrs={ {k: (a.item() if hasattr(a, 'item') else a) for k, a in f[ds].attrs.items()} } fn={f[ds.rsplit('/',1)[0] + '/frame_numbers'][:].tolist()}"
            print(f"  v{i} filename={b.get('filename')} dataset={ds} shape={b.get('shape')}{extra}")
