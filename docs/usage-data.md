# Usage Data

SLEAP App shares a small amount of usage data with the SLEAP team: which
features are used, which errors occur, and what kind of machine it is running
on. It helps us decide what to build and fix, and it is how we find out that
something is broken for people who never file a bug report.

**It never includes your videos, images, labels, or the names of your files,
projects, videos, skeleton nodes or tracks.**

You can turn it off at any time: **Help ▸ Share Usage Data**. The first time
you start the app, a notice says the same thing and lets you choose **Make SLEAP
better** or **Turn off**; nothing is sent, or even saved to disk, before that
notice has been shown.

## What is sent

| What | Example | Why |
|---|---|---|
| App version, update channel, desktop or browser | `0.2.0`, `stable`, `desktop` | To know which versions are in use and where a problem started |
| Operating system and CPU type | `macOS 14.5`, `arm64` | Most "it doesn't work here" reports depend on these |
| Browser or WebView family and major version | `chrome 131` | Same reason |
| Language (not region), CPU core count, memory size, screen size | `en`, `10`, `16 GB`, `1728×1117` | To prioritize translation, performance and layout work |
| Whether the browser supports the features the app relies on | WebCodecs: yes, WebGPU: no | Video decoding and large projects depend on them |
| GPU and SLEAP-NN setup (desktop) | `cuda`, `NVIDIA RTX 4090`, `sleap-nn 0.3.2` | Training and inference problems are usually environment problems |
| Which menu items, commands, and sidebar panels you use, as counts | `File ▸ Save: 12`, `Label QC: 3` | To see which features matter and which nobody finds |
| That a project was opened, with its rough size and video reader type | `6–20 videos`, `101–500 labeled frames`, `media` | To know what scale of project and video formats to design for. Ranges only, never exact counts |
| Training and inference runs: model type, local or remote (Connect), outcome, coarse failure category, and duration | `training finished, top_down, 14 min, 2 models` | Failed runs are the most common reason people need help |
| Remote worker (Connect) connection outcomes and transport | `iroh`, `connected` | To measure remote-compute reliability |
| Errors: the scrubbed message, where in the app's code it happened, and the last command used | `Cannot read properties of undefined`, after `Add Instance` | To fix crashes, including ones nobody reports (kept private for the SLEAP team; never published on `stats.sleap.ai`) |
| Whether the app closed unexpectedly last time (desktop) | yes / no | To measure how often it crashes |
| How long the app was open and in use | `42 min` | To tell a quick look from a working session |
| Tutorial progress | `step 4 of 9, exited` | To find where the tutorial loses people |

Each report also carries two random IDs: one made the first time the app runs
on a computer, and one made each time it starts. They let us count installs
and sessions and tell one from another. They are random numbers, not derived
from your name, your computer or your network.

## What is never sent

- Videos, frames, images or thumbnails
- Labels, coordinates, predictions or models
- File names, folder paths or URLs
- Project, video, skeleton, node or track names, or anything else you type
- Your name, email address, user name or computer name
- Your full IP address (see [Where it goes](#where-it-goes))

Error messages often quote the file that failed. Before a message is stored,
file paths, file names, URLs and email addresses in it are replaced with
placeholders such as `<path>`, so `Failed to open /Users/jane/mouse.slp`
becomes `Failed to open <path>`.

## Where it goes

Reports are sent over HTTPS to `analytics.sleap.ai`, a service run by the
[Talmo Lab](https://talmolab.org) at the Salk Institute, and stored in a
database only the SLEAP team can read. They are not shared with or sold to
anyone, and no third-party analytics service is involved. High-level aggregate
numbers, such as how many people use each version, are published at
[stats.sleap.ai](https://stats.sleap.ai). Scrubbed error messages and stack
frames are never published to `stats.sleap.ai`; they stay in private SLEAP team
storage for debugging.

Like any server, the service sees the IP address a report arrives from. It
keeps only the network part of it (for example `203.0.113.0/24`), which is
enough to tell which country a report came from and not enough to identify a
computer.

## Turning it off

**Help ▸ Share Usage Data** turns sharing off or back on. When you turn it
off:

- nothing further is collected or sent;
- anything collected but not yet sent is deleted from your computer;
- the setting is kept when you update the app, and by **File ▸ Reset
  Preferences to Defaults**.

If your browser sends a **Do Not Track** or **Global Privacy Control** signal,
sharing starts out off in the web app, and you can turn it on from the same
menu item.

Running the app from source (`bun run dev`) never sends anything.

## Your Support ID

**Help ▸ About SLEAP Label** shows a **Support ID**. This is the random
install ID described above. If you include it when you
[report an issue](https://github.com/talmolab/sleap-app/issues), we can look
up the errors your install reported, which often saves a round of questions.
It is also written into the file **Help ▸ Collect Diagnostics…** makes.

Sharing it is up to you. On its own it tells nobody anything about you.

## The start-up report

The Qt GUI (SLEAP 1.x) sends one small report each time it starts: its
version, the Python version and the operating system. Its setting is separate,
under that application's own Help menu.

The desktop app can send that same start-up report, and nothing else, in one
situation: when the service has not yet been updated to receive the reports
described on this page. It contains the app version, the Python version SLEAP-NN
uses and the operating system. Unlike everything above, the older part of the
service records the full IP address a start-up report arrives from, as it
always has for SLEAP 1.x. **Help ▸ Share Usage Data** turns this off too.
