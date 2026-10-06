# Social LEAP Estimates Animal Poses (SLEAP)

<div class="hero" markdown>
![SLEAP pose estimation demo](assets/sleap_movie.gif)
</div>

<div class="badges" markdown>
[![Release](https://img.shields.io/github/v/release/talmolab/sleap-app?label=Stable)](https://github.com/talmolab/sleap-app/releases/)
[![GitHub stars](https://img.shields.io/github/stars/talmolab/sleap-app)](https://github.com/talmolab/sleap-app)
[![License](https://img.shields.io/badge/license-BSD--3--Clause-blue)](https://github.com/talmolab/sleap-app/blob/main/LICENSE)
</div>

**SLEAP** is an open-source deep learning framework for multi-animal pose tracking
([Pereira et al., Nature Methods, 2022](https://www.nature.com/articles/s41592-022-01426-1)).
It provides an end-to-end workflow from labeling to trained models, with a
purpose-built GUI for active learning and proofreading.

**SLEAP App** is that GUI, rebuilt as a web app. It runs **entirely in your
browser** — no server, no Python, no install — or as a **Desktop app** when
you want native file dialogs, local GPU training, and offline use.

!!! note "Using a different version of SLEAP?"

    These docs cover **SLEAP App**, the web-based GUI. For the Qt/Python GUI:

    - **SLEAP v1.5–1.6** — [docs.sleap.ai](https://docs.sleap.ai)
    - **SLEAP v1.4.1 or earlier** — [legacy.sleap.ai](https://legacy.sleap.ai)

## 🚀 Get some SLEAP

=== "🌐 In the browser"

    Go to **[app.sleap.ai](https://app.sleap.ai)** and drag a `.slp` file onto
    the window. Nothing to install — that is the whole setup.

=== "💻 Desktop app"

    Native file dialogs, local GPU training, in-app updates, and offline use.
    One command installs it:

    **macOS / Linux**

    ```bash
    curl -fsSL https://app.sleap.ai/install.sh | sh
    ```

    **Windows**

    ```powershell
    irm https://app.sleap.ai/install.ps1 | iex
    ```

    Prefer a specific release channel? See
    [Installation](installation.md).

!!! tip "Try the built-in tutorial"

    Click **Start Tutorial** in the menu bar and the app walks you through the
    whole loop in place — creating a project, building a skeleton, training,
    correcting predictions, and re-training — advancing only once you have
    actually done each step. Works in the browser too.

For a written walkthrough, follow the
[Quick Start](getting-started/quickstart.md) — open a project, move through
frames, and place your first instance in a few minutes.

---

## 📚 Explore the docs

<div class="grid cards" markdown>

-   :material-pencil:{ .lg .middle } **Labeling**

    ---

    Place instances, build skeletons, correct predictions.

    [:octicons-arrow-right-24: Start Labeling](guides/labeling.md)

-   :material-keyboard:{ .lg .middle } **Keyboard Shortcuts**

    ---

    Every binding, plus canvas pan and zoom gestures.

    [:octicons-arrow-right-24: View Shortcuts](reference/shortcuts.md)

-   :material-brain:{ .lg .middle } **Training**

    ---

    Run [sleap-nn](https://nn.sleap.ai) training with live loss curves.

    [:octicons-arrow-right-24: Train a Model](guides/training.md)

-   :material-flash:{ .lg .middle } **Inference**

    ---

    Predict locally, or on a remote GPU worker.

    [:octicons-arrow-right-24: Run Inference](guides/inference.md)

-   :material-chart-box:{ .lg .middle } **Analysis**

    ---

    Instance size distributions and geometric label quality checks.

    [:octicons-arrow-right-24: Analyze Labels](guides/label-qc.md)

-   :material-swap-horizontal:{ .lg .middle } **Import & Export**

    ---

    SLP, NWB, COCO, DeepLabCut, and analysis files.

    [:octicons-arrow-right-24: File Formats](reference/formats.md)

</div>

---

## 🧩 How it fits with the rest of SLEAP

| Package | What it does | Docs |
|---|---|---|
| **sleap-app** | Labeling GUI, training/inference launcher (this site) | [docs.app.sleap.ai](https://docs.app.sleap.ai) |
| **sleap-nn** | PyTorch training and inference backend | [nn.sleap.ai](https://nn.sleap.ai) |
| **sleap-io** | Python data model and file I/O | [io.sleap.ai](https://io.sleap.ai) |
| **sleap-io.js** | The TypeScript port this app reads and writes SLP with | [iojs.sleap.ai](https://iojs.sleap.ai) |
| **sleap** | The original Qt/Python GUI this app replaces | [docs.sleap.ai](https://docs.sleap.ai) |

Projects are plain `.slp` files, so you can move between the app, the legacy GUI,
and the Python API freely.

---

## Get help

<div class="grid cards" markdown>

-   :material-frequently-asked-questions:{ .lg } **FAQ**

    Common questions answered. [View FAQ](help/faq.md)

-   :material-wrench:{ .lg } **Troubleshooting**

    Video won't play? Update stuck? [Start here](help/troubleshooting.md)

-   :fontawesome-brands-github:{ .lg } **Report an issue**

    Found a bug? [Create an issue](https://github.com/talmolab/sleap-app/issues/new)

</div>

---

## References

SLEAP is the successor to the single-animal pose estimation software
[LEAP (Pereira et al., Nature Methods, 2019)](https://www.nature.com/articles/s41592-018-0234-5).
If you use SLEAP in your research, please cite:

> T.D. Pereira, N. Tabris, A. Matsliah, D. M. Turner, J. Li, S. Ravindranath,
> E. S. Papadoyannis, E. Normand, D. S. Deutsch, Z. Y. Wang, G. C. McKenzie-Smith,
> C. C. Mitelut, M. D. Castro, J. D'Uva, M. Kislin, D. H. Sanes, S. D. Kocher,
> S. S-H, A. L. Falkner, J. W. Shaevitz, and M. Murthy. **SLEAP: A deep learning
> system for multi-animal pose tracking.** *Nature Methods*, 19(4), 2022.
> [:octicons-link-external-16:](https://www.nature.com/articles/s41592-022-01426-1)

??? note "BibTeX"

    ```bibtex
    @ARTICLE{Pereira2022sleap,
       title={SLEAP: A deep learning system for multi-animal pose tracking},
       author={Pereira, Talmo D and Tabris, Nathaniel and Matsliah, Arie and
          Turner, David M and Li, Junyu and Ravindranath, Shruthi and
          Papadoyannis, Eleni S and Normand, Edna and Deutsch, David S and
          Wang, Z. Yan and McKenzie-Smith, Grace C and Mitelut, Catalin C and
          Castro, Marielisa Diez and D'Uva, John and Kislin, Mikhail and
          Sanes, Dan H and Kocher, Sarah D and Samuel S-H and
          Falkner, Annegret L and Shaevitz, Joshua W and Murthy, Mala},
       journal={Nature Methods},
       volume={19},
       number={4},
       year={2022},
       publisher={Nature Publishing Group}
    }
    ```

---

## Contributors

SLEAP was created in the [Murthy](https://murthylab.princeton.edu) and
[Shaevitz](https://shaevitzlab.princeton.edu) labs at the
[Princeton Neuroscience Institute](https://pni.princeton.edu) at Princeton
University.

SLEAP is currently being developed and maintained in the
[Talmo Lab](https://talmolab.org) at the
[Salk Institute for Biological Studies](https://salk.edu), in collaboration with
the Murthy and Shaevitz labs at Princeton University.

See the
[contributors graph](https://github.com/talmolab/sleap-app/graphs/contributors)
for everyone who has worked on SLEAP App.

??? note "Funding"

    This work was made possible through our funding sources, including:

    - NIH BRAIN Initiative R01 NS104899
    - Princeton Innovation Accelerator Fund

---

## License

SLEAP App is released under a
[BSD 3-Clause License](https://github.com/talmolab/sleap-app/blob/main/LICENSE).
