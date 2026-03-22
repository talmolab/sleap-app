This is a SLEAP web-based frontend app.

It is deployed to a static page endpoint (app.sleap.ai), as well as compiled to a Tauri-based desktop app. There are many code paths that vary depending on the runtime environment, especially for I/O.

# Development
- `main` is protected. You must work on branches, PR, and squash merge.
- This app makes extensive use of `sleap-io.js` for I/O, data model, SLP file handling, video decoding, playback, HDF5 ops.
    - Source: https://github.com/talmolab/sleap-io.js
    - Docs: https://iojs.sleap.ai/usage.md, https://iojs.sleap.ai/api.md

# Deployment
- On merge to `main`:
  - Deployed to: `https://app.sleap.ai/dev/`
- On GitHub Release:
  - Deployed to: `https://app.sleap.ai`
  - Tauri installer is built and attached to the release.
