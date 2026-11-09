# Sample Datasets

Labeled datasets to practice on, compare against, or start a project from.

## The tutorial videos

The [Tutorial](../tutorial/index.md) uses two videos of a pair of mice in a home
cage, from the
[sleap-tutorial-data](https://github.com/talmolab/sleap-tutorial-data)
repository:

| File | Frames | Used for |
|---|---|---|
| `mice.mp4` | 14,100 (5 min at 47 fps) | Labeling and training. **Use sample video** in **New Project** downloads it for you |
| `new_data/mice_new.mp4` | 2,820 (1 min) | Running a trained model on a new video |

## The SLEAP paper datasets

These are the labeled datasets from the SLEAP paper
([Pereira et al., 2022](https://www.nature.com/articles/s41592-022-01426-1)).
Each is a `.pkg.slp` labels package, with the images embedded, so it opens in
the app on its own (**File ▸ Open Project…**). Each comes split into training,
validation and test sets.

| Dataset | Animal | Nodes | Animals per frame | Identity | Labeled instances |
|---|---|---|---|---|---|
| **fly32** | Fruit fly, single, animal-centered | 32 | 1 | no | 1,500 |
| **flies13** | Fruit flies, courting pairs | 13 | 2 | yes | 4,000 |
| **mice_of** | Mice in an open field, filmed from below | 11 | 1–5 | no | 2,950 |
| **mice_hc** | Mice in a home cage, filmed from above | 5 | 2 | no | 2,948 |
| **bees** | Bumblebees in a petri dish | 21 | 2 | no | 1,604 |
| **gerbils** | Gerbils, pups and adults, in a home cage | 14 | 4 | yes | 1,588 |

"Identity" means the animals can be told apart by appearance, so these
datasets suit the **+ ID** model types.

The [skeleton templates](../guides/skeletons.md#starting-from-a-template) in
**New Project** and the **Skeleton** panel are these datasets' skeletons, so you
can start a similar project with the same body parts.

Download links, frame rates, resolutions and credits for each dataset are on
the SLEAP docs' [Datasets page](https://docs.sleap.ai/latest/reference/datasets/).
The full labeled data and trained models from the paper are on
[OSF](https://osf.io/36har/).
