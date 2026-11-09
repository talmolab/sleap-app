# 1. Setup

Labeling works anywhere. Training needs [sleap-nn](https://nn.sleap.ai), and a
GPU makes it much faster: an NVIDIA GPU on Linux or Windows, or the built-in GPU
of an Apple Silicon Mac.

=== "Desktop app"

    1. [Install the app](../installation.md#desktop-app) and open it.
    2. Open the **Environment** panel from the sidebar.
    3. If **uv** isn't installed, click **Install** next to it. Then install
       **sleap-nn** the same way.
    4. Under sleap-nn, check **Accelerator**: a green light means a GPU was
       found. Without one, training runs on the CPU and is much slower.

=== "Browser"

    Go to [app.sleap.ai](https://app.sleap.ai). There's nothing to install.

    The browser can't train models itself. To follow the training steps, pair
    it with a [remote worker](../guides/remote-compute.md) that has a GPU, or
    use the desktop app.

*Next up: [Create a project](new-project.md)*
