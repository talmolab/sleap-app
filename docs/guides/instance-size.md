# Instance Size Distribution

**Analyze ▸ Instance Size Distribution…**

How big are your animals, in pixels? You need the answer to pick a **crop size**
for a [top-down model](training.md), and guessing it is a common way to waste a
training run — too small and you cut off body parts, too large and you spend
capacity and memory on background.

This dialog measures every instance in the project, predictions included, and
shows you the distribution. To size crops from your own labels only, run it
before you load or generate predictions.

## What is measured

For each instance, the axis-aligned bounding box of its **visible** points, and
then `size = max(width, height)`. Invisible points are ignored; instances with no
finite coordinates are skipped.

## Rotation augmentation

If you train with rotation augmentation, the crop has to be big enough for the
animal at *any* angle, not just the angle it was labeled at. The **Rotation
augmentation** control accounts for that:

| Preset | Meaning |
|---|---|
| **Off** | Sizes as labeled |
| **±15°** | Sizes inflated for ±15° of rotation |
| **±180°** | Full rotation — the worst case |
| **Custom** | Any angle you like |

Beyond 90° the geometry repeats by symmetry, so the range is clamped there.

Set this to match the augmentation you actually plan to train with, then read the
crop size off the result.

## The two views

**Size Distribution** — a scatter of size against instance index. Useful for
spotting a cluster of oddly small or large instances, which usually means a
labeling problem rather than a real size difference.

**Size Histogram** — the distribution itself, with configurable bin count (5–100)
and optional manual X-axis bounds.

## Statistics

| Statistic | Use it for |
|---|---|
| **Mean ± Std** | The typical size |
| **Median** | The typical size, robust to outliers |
| **Range** | The extremes |
| **90th / 95th / 99th percentile** | **Choosing a crop size** — cover 95–99% of instances |
| **Outliers (> 2σ)** | Instances worth looking at individually |

!!! tip "Reading a crop size off this"

    Take the **95th or 99th percentile** at the rotation setting you'll train
    with, then round up to what your model wants. Sizing at the mean truncates
    half your animals.

## Choosing a crop size

1. Set **Rotation augmentation** to match what you'll train with.
2. Read the **95th percentile**: it covers 95% of instances without letting a
   few extremes decide.
3. Add **10–20%** for animals near the frame edge and for prediction error.
   For example, a 95th percentile of 200 px suggests a crop of 220–240 px.

Then set **Crop Size** in the training configuration. Left on **Auto**, the
app sizes the crop from your single largest labeled instance, so check the
scatter for outliers first: one stray point can make the crop far bigger than
it needs to be. See [Training](training.md#key-ideas).

A few situations to watch for:

- **Very different sizes,** such as pups and adults: use a crop big enough for
  the largest, or train separate models.
- **Several videos recorded differently:** the dialog pools every video. Click
  the outliers to see whether they all come from one video.
- **A cluster of very large instances** is usually a labeling mistake, not big
  animals. Check them before you size around them.

## Jumping to an instance

Click any point in the scatter and the dialog shows that instance's details —
size, raw width and height, video, frame, and instance index — and the main
window navigates to it. That's how you check whether an outlier is a big animal
or a bad label.

Outliers here often turn out to be duplicate or malformed instances, which
[Label Quality Check](label-qc.md) will name explicitly.
