# 9. What's next

You've been through the whole workflow: label, train, correct, track, proofread
and export. You're done with the tutorial!

## Improve and reuse your model

- **Label more frames and retrain.** Each round of correcting and retraining
  makes the model better.
- **Run it on more videos,** as you did in step 6, or all at once with
  **Inference Target: All videos**. Proofread the tracks of each before you
  analyze them.
- **Explore the app.** The [Guides](../guides/overview.md) cover everything
  it can do.

## Analyze the poses

SLEAP gives you where each body part is on every frame. Two common next steps:

- **Behavior classification:** label behaviors frame by frame from the pose
  trajectories, for example with
  [Keypoint-MoSeq](https://keypoint-moseq.readthedocs.io) (unsupervised) or
  [SimBA](https://github.com/sgoldenlab/simba) (supervised).
- **Movement analysis:** measure speed, posture and coordination from the
  trajectories, for example with
  [movement](https://movement.neuroinformatics.dev).

For data loading and I/O in Python, use [sleap-io](https://io.sleap.ai).

The SLEAP docs keep a longer list of analysis tools, example notebooks and
reading by research area:
[I'm done SLEAPing, now what?](https://docs.sleap.ai/latest/tutorial/i-m-done-sleaping-now-what/)
