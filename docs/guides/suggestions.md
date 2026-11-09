# Suggestions

Suggestions are a list of frames worth labeling. They exist because the naive
approach — label frames 1 through 200 — produces 200 nearly identical training
examples and a model that only works on the first eight seconds of your video.

Open the **Suggestions** panel to generate and work through them, and move
between them with ++space++ / ++shift+space++.

## Generation methods

| Method | Picks | Use when |
|---|---|---|
| **Stride** | Evenly spaced frames | Default. Broad, cheap coverage |
| **Random** | Uniform random sample | You want unbiased sampling |
| **Frame chunk** | A contiguous range | You care about one specific interval |
| **Image features** | Decodes frames, reduces with PCA, clusters with k-means, samples across clusters | You want *visually diverse* frames — different poses, lighting, positions |
| **Prediction score** | Frames where the model was least confident | You already have predictions and want to fix the hard cases |
| **Velocity** | Frames where a chosen node moved fast | Fast motion is where tracking and pose both fail |
| **Max displacement** | Frames with the largest per-track mean node displacement | Hunting for tracking breaks and identity swaps |

**Image features** is the strongest choice for a first labeling pass — it
actually looks at the pixels, so it will not hand you twenty frames of the same
resting animal. It decodes frames in a worker, so it takes a moment on long
videos.

**Prediction score**, **Velocity**, and **Max displacement** are for *later*
rounds, once a model exists. They are how you spend the second hundred labels
much better than the first.

## Parameters

Depending on the method:

- **Per video** — how many frames to sample (stride/random, default 20)
- **Frame range** — **Frame chunk** takes its own range; for the other methods,
  tick **Limit to frame range**
- **Score limit** and **instance count bounds** — for prediction score, what
  counts as "low confidence" and how many low-confidence instances a frame needs
- **Node** and **threshold** — for velocity, which node's motion to measure
- **Displacement threshold** — for max displacement
- **Target** — **All videos** (the default) or **Current video**
- **On Generate** — **Add** (the default) appends the new frames to the existing
  list; **Replace** swaps the list out

### Image features settings

| Setting | What it does |
|---|---|
| **Sample** | How many frames per video to decode and compare (default 200) |
| **Sample by** | **Stride** or **Random** — how those frames are picked |
| **Resolution** | Frames are shrunk so their long side is at most this many pixels before comparing (default 128) |
| **Clusters** | How many groups of similar-looking frames to form (default 5) |
| **Frames per cluster** | How many suggestions to take from each group (default 5) |
| **Seed** | Fixes the random choices so a run is repeatable; ⟳ picks a new one |
| **Set region** | Drag a box on the frame so only that area is compared |
| **PCA components** | Under **▸ Advanced** — how many dimensions to reduce each frame to before clustering (default 5) |

You get about **Clusters × Frames per cluster** suggestions per video — the
panel shows the number.

## Managing the list

The panel also lets you:

- **Sort** by video, frame, or score
- **Add current frame** as a suggestion
- **Remove** the selected suggestion, or **Remove unlabeled** ones once you're
  done
- **Shuffle** the order, so you don't systematically label the start of the video
  first
- **Add labeled frames** — put every frame you've already labeled into the list

## Prediction-assisted labeling

Labeling every frame by hand is slow. Instead, label a few frames, train a
model, and let it predict the rest. Correcting a prediction is much faster than
placing every node yourself, and each round gives you a better model that needs
fewer corrections.

1. Generate ~20 stride or image-feature suggestions.
2. Label them completely.
3. Train a small model ([Training](training.md)).
4. Run inference over the video ([Inference](inference.md)).
5. Generate new suggestions by **prediction score** or **max displacement**.
6. Correct those predictions instead of labeling from scratch.
7. Retrain, and repeat from step 4.

Each round targets the frames the model actually finds hard, which is where your
labeling time is worth the most.

!!! warning "Predictions don't train the model until you accept them"

    Training only uses your own labels. Double-click a prediction (or press
    ++cmd+shift+a++ / ++ctrl+shift+a++ for the whole frame) to turn it into a
    label, then fix what's wrong. An accepted node is red until you touch it,
    then green, so you can see which ones you've checked. See
    [Working with predictions](labeling.md#working-with-predictions).

### Reading the seekbar

The seekbar shows where your work stands:

| Mark | Means |
|---|---|
| Yellow flag along the top | A suggested frame |
| Blue tick | A frame with your labels |
| Light-blue tick | A frame with predictions only |
| Red tick | A [negative frame](labeling.md#negative-frames) |

A yellow flag over a light-blue tick is a suggestion the model has predicted
on, ready for you to correct.

### Tips

- **Generate fresh suggestions each round.** Once a model exists,
  **Prediction score** and **Max displacement** find the frames it struggles
  with, which are more useful to label than more evenly spaced ones.
- **Correct the failures.** Sort the panel's **Mean Score** column and work
  through low-scoring frames first. Check some high-scoring ones too, since a
  model can be confidently wrong.
- **Don't over-polish.** Fix points that are clearly off. A point a pixel or
  two from where you'd put it isn't worth the time.
- **Keep rounds small.** Correcting 10–20 frames and retraining often beats
  correcting 100 before you retrain.
- **Run [Label Quality Check](label-qc.md) before retraining.** It catches
  mistakes, like left/right swaps, that are easy to miss while correcting.
