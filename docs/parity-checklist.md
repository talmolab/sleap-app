# SLEAP PyQt GUI vs sleap-app — Feature Parity Checklist

Use this to track which PyQt features have been ported to sleap-app.

**Legend:** ✅ = Complete | 🟡 = Partial | ❌ = Missing | N/A = Not applicable

---

## Table 1: Menu Bar

### File Menu

- [x] New Project (Ctrl+N)
- [x] Open Project... (Ctrl+O)
- [ ] Import > COCO dataset...
- [ ] Import > DeepLabCut dataset...
- [ ] Import > Multiple DLC from folder...
- [ ] Import > NWB dataset...
- [ ] Import > SLEAP Analysis HDF5...
- [ ] Merge into Project... (stub exists)
- [x] Add Videos... (in Videos panel)
- [x] Replace Videos... (submenu per-video, uses resolveVideoFile)
- [x] Save (Ctrl+S)
- [x] Save As... (Ctrl+Shift+S)
- [ ] Export Analysis HDF5 > Current Video
- [ ] Export Analysis HDF5 > All Videos
- [x] Export Analysis CSV (partial — no current/all distinction)
- [ ] Export NWB...
- [ ] Reset preferences to defaults...
- [ ] Open Preferences Directory...
- [x] Quit (Ctrl+Q)

### Go Menu

- [x] Next Labeled Frame (Alt+Right)
- [x] Previous Labeled Frame (Alt+Left)
- [x] Last Interacted Frame (Ctrl+A)
- [x] Next User Labeled Frame (Ctrl+U)
- [x] Next Suggestion (Space)
- [x] Previous Suggestion (Shift+Space)
- [x] Next Track Spawn Frame (Ctrl+E)
- [x] Next Video (Alt+Shift+Right)
- [x] Previous Video (Alt+Shift+Left)
- [x] Go to Frame... (Ctrl+J)
- [x] Select to Frame... (Ctrl+Shift+J)
- [x] Select Next Instance (`)
- [x] Clear Selection (Esc)

### View Menu

- [x] Fit View to Instances (Ctrl+=)
- [x] Fit View to Selection
- [x] Color Predicted Instances
- [x] Color Palette (submenu)
- [x] Apply Distinct Colors To (submenu)
- [x] Show Instances (H)
- [x] Show Non-Visible Nodes
- [x] Show Node Names (Ctrl+Tab)
- [x] Show Edges (Ctrl+Shift+Tab)
- [x] Edge Style (Line/Wedge)
- [x] Node Marker Size
- [x] Node Label Size
- [x] Trail Length
- [x] Trail Shade (in View panel only, not menu)
- [ ] Render Video Clip with Instances...
- [ ] Per-dock toggle actions (single sidebar toggle only)

### Labels Menu

- [x] Add Instance (Ctrl+I)
- [x] Instance Placement Method (6 methods: Best, Template, Force Directed, Random, Copy Prior, Copy Predictions)
- [x] Delete Instance (Ctrl+Backspace)
- [x] Custom Instance Delete... (scope/type/track filters — in Delete Predictions dialog)
- [ ] Extract Clip and Labels...
- [ ] Extract Clip Labels Package...
- [ ] Add Instances from All Predictions on Current Frame
- [x] Copy Instance (Ctrl+C) — in Edit menu
- [x] Paste Instance (Ctrl+V) — in Edit menu
- [x] Delete Predictions on Current Frame
- [x] Delete All Predictions...
- [x] Delete Predictions with Low Score... (in dialog)
- [ ] Delete Predictions from Clip...
- [x] Delete Predictions from Area... (Ctrl+K)
- [x] Delete Predictions beyond Max Instances... (in Delete Predictions dialog)
- [ ] Delete Predictions beyond Frame Limit...
- [x] Delete Predictions on User-Labeled Frames... (in Delete Predictions dialog)

### Predict Menu

- [x] Run Training...
- [x] Run Inference...
- [ ] Evaluation Metrics for Trained Models...
- [ ] Export Labels Package (3 levels: labeled, labeled+suggested, all)
- [ ] Train on Google Colab...

### Analyze Menu

- [ ] Instance Size Distribution...
- [ ] Label QC...

### Tracks Menu

- [x] Set Instance Track (Ctrl+1-9) — via shortcuts + context menu
- [x] Propagate Track Labels
- [x] Transpose Instance Tracks (Ctrl+T)
- [x] Delete Instance and Track (Ctrl+Shift+Backspace)
- [x] Delete Track (per-track submenu)
- [x] Delete Multiple Tracks (Unused/All)
- [x] Copy Instance Track (Ctrl+Shift+C)
- [x] Paste Instance Track (Ctrl+Shift+V)
- [x] Seekbar Header stat selection (12 options)
- [x] New Track (Ctrl+0)

### Help Menu

- [x] Documentation
- [x] GitHub (links to issues)
- [x] Releases link
- [x] Check for Updates (auto-updater instead)
- [ ] Share usage data toggle
- [x] Keyboard Shortcuts
- [x] Debug mode (sidebar panel instead of toggle)

---

## Table 2: Dialogs

- [x] Training Configuration Dialog (LearningDialog training mode)
- [x] Inference Configuration Dialog (LearningDialog inference mode)
- [x] Training Monitor (live loss plots) — PR #128 (per-batch scatter + per-epoch train/val curves, best-val marker, runtime/ETA/plateau, validation-image panel)
- [x] Custom Instance Delete Dialog (enhanced Delete Predictions dialog with type/track filters)
- [ ] Delete User-Frame Predictions Dialog
- [ ] Merge Projects Dialog (MergeDialog)
- [ ] Replace Skeleton Table Dialog
- [x] Missing Files Dialog (PathResolutionDialog — different scope)
- [x] Keyboard Shortcuts Dialog (view-only, no editing)
- [ ] Evaluation Metrics Dialog (MetricsTableDialog)
- [ ] Detailed Metrics Dialog
- [ ] Label QC Panel (QCDockWidget)
- [ ] Instance Size Distribution Dialog
- [ ] Update Checker Dialog (auto-updater instead)
- [ ] Import Videos Dialog (file picker only)
- [ ] Render Clip Dialog
- [ ] Export Clip Dialog
- [ ] Frame Range Dialog
- [x] Go to Frame Dialog
- [x] Select to Frame Dialog

---

## Table 3: Sidebar Panels

### Panel Presence

- [x] Videos panel
- [x] Skeleton panel
- [x] Suggestions panel
- [x] Instances panel
- [ ] QC panel (Label Quality Control)

### Panel Content Gaps

**Skeleton Panel:**
- [x] Node CRUD (add, delete, rename)
- [x] Edge CRUD (add, delete)
- [x] Template skeletons
- [ ] Symmetry editing
- [ ] Load/Save skeleton files (JSON/HDF5)

**Suggestions Panel:**
- [x] Stride sampling
- [x] Random sampling
- [ ] Image features method (PCA + K-means)
- [ ] Prediction score method
- [ ] Velocity method
- [ ] Frame chunk method
- [ ] Max point displacement method
- [ ] Add current frame as suggestion

**Videos Panel:**
- [x] Video list with details
- [x] Add videos
- [x] Locate missing videos
- [ ] Toggle grayscale
- [ ] HDF5 dataset selection
- [ ] Remove video (functional)

**Instances Panel:**
- [x] Instance list with track/score
- [x] Add/Delete instance
- [ ] Inline track rename

---

## Table 4: Canvas Overlays & Interactions

### Overlays

- [x] Skeleton nodes + edges
- [x] Node name labels
- [x] Track trails
- [x] Track name legend (Ctrl hold)
- [x] Predicted instance coloring
- [x] Seekbar marks (labeled, predicted, suggestions)
- [x] Track occupancy bars
- [ ] Confidence map overlay
- [ ] PAF (Part Affinity Field) overlay
- [x] Seekbar header stats (12 options)

### Canvas Interactions

- [x] Click to select instance
- [x] Drag nodes
- [x] Alt+drag move entire instance
- [x] Alt+scroll rotate instance
- [x] Double-click prediction → user instance
- [ ] Double-click user instance → complete missing nodes
- [x] Right-click context menu
- [x] Scroll zoom
- [x] Pan (Space+drag / middle-click)
- [ ] Alt+drag zoom box
- [ ] Shift+click mark all nodes complete
- [x] Ctrl+K area delete (draw rectangle)
- [ ] Drag-and-drop video files (SLP only currently)

---

## Table 5: Keyboard Shortcuts

### Matching (both apps)

- [x] Ctrl+N (New), Ctrl+O (Open), Ctrl+S (Save), Ctrl+Shift+S (Save As), Ctrl+Q (Quit)
- [x] Arrow keys (frame ±1), Ctrl+arrows (±10)
- [x] Alt+arrows (labeled frames), Alt+Shift+arrows (videos)
- [x] Space / Shift+Space (suggestions)
- [x] Ctrl+A (last interacted), Ctrl+U (next user), Ctrl+E (next track spawn)
- [x] Ctrl+J (go to frame), ` (next instance), Esc (clear selection)
- [x] Ctrl+I (add), Ctrl+Backspace (delete), Ctrl+C/V (copy/paste)
- [x] Ctrl+T (transpose), Ctrl+0 (new track), Ctrl+1-9 (set track)
- [x] Ctrl+Shift+C/V (copy/paste track)
- [x] H (instances), Ctrl+Tab (names), Ctrl+Shift+Tab (edges), Ctrl+= (fit)

### Different modifiers

- [ ] Frame ±100: PyQt uses Ctrl+Alt+arrows, sleap-app uses Ctrl+Shift+arrows

### Missing in sleap-app

- [x] Ctrl+K (delete area predictions)
- [ ] Ctrl+M / Ctrl+Shift+M (mark/go-to marked frame)
- [x] Ctrl+Shift+Backspace (delete instance and track)

---

## Table 6: Status Bar / Chrome

- [x] Frame X/Y display
- [x] Selection range display
- [x] Instance count on current frame
- [x] Video X/Y (current index / total)
- [x] Labeled frames (in-video vs in-project split)
- [x] Predicted frames count + percentage
- [x] [Hidden] warning when instances hidden
- [x] [NEGATIVE FRAME] indicator
- [x] Window title with filename (also kept in status bar)
- [ ] Dock floating/undocking — **by design / won't-do** (single-sidebar model, no docking library; see status-chrome-design.md §1/§9)
- [ ] Window state persistence (dock positions/sizes) — **partial**: panel layout + UI scale **persisted** (panelOrder/sidebarCollapsed/sidebarActivePanel/uiScale); OS window geometry **by design / won't-do** here (needs tauri-plugin-window-state, phase-2)

---

## sleap-app Only Features (not in PyQt)

These exist in sleap-app but NOT in PyQt:

- [x] Undo/Redo (Ctrl+Z / Ctrl+Shift+Z)
- [x] Node Placement Mode (N key)
- [x] Zoomed Inset Magnifier
- [x] LUT / Intensity Adjustment (histogram + sliders)
- [x] Colormap support (Viridis, Inferno, etc.)
- [x] Virtual Rotation (0/90/180/270)
- [x] Marquee multi-node selection
- [x] Pan mode toggle (P key)
- [x] Playback speed control (0.25x-8x)
- [x] UI Scale (75%-150%)
- [x] Web deployment (app.sleap.ai)
- [x] Remote training/inference (WebRTC)
- [x] Auto-updater
- [x] Environment manager (uv, Python, sleap-nn)
- [x] Connect panel (worker management)
- [x] Notifications panel
- [x] Debug panel (console capture)
- [x] Toast notifications
- [x] Welcome screen
- [x] Export JSON
- [x] Export Labels Package dialog
