/**
 * Keyboard shortcut definitions matching SLEAP's shortcuts.yaml.
 */

export const DEFAULT_SHORTCUTS: Record<string, string> = {
  // File
  new: "$mod+KeyN",
  open: "$mod+KeyO",
  save: "$mod+KeyS",
  "save as": "$mod+Shift+KeyS",
  close: "$mod+KeyQ",

  // Navigation - frames
  "frame next": "ArrowRight",
  "frame prev": "ArrowLeft",
  "frame next medium step": "$mod+ArrowRight",
  "frame prev medium step": "$mod+ArrowLeft",
  "frame next large step": "$mod+Shift+ArrowRight",
  "frame prev large step": "$mod+Shift+ArrowLeft",
  "goto start": "Home",
  "goto end": "End",

  // Navigation - labeled frames
  "goto next labeled": "Alt+ArrowRight",
  "goto prev labeled": "Alt+ArrowLeft",
  "goto last interacted": "$mod+KeyA",
  "goto next user": "$mod+KeyU",
  "goto next suggestion": "Space",
  "goto prev suggestion": "Shift+Space",
  "goto next track spawn": "$mod+KeyE",

  // Navigation - videos
  "next video": "Alt+Shift+ArrowRight",
  "prev video": "Alt+Shift+ArrowLeft",

  // Navigation - other
  "goto frame": "$mod+KeyJ",
  "select to frame": "$mod+Shift+KeyJ",
  "select next": "Backquote",
  "clear selection": "Escape",

  // Labels
  "add instance": "$mod+KeyI",
  "delete instance": "$mod+Backspace",

  // View
  fit: "$mod+Equal",
  "show instances": "KeyH",
  "show labels": "$mod+Tab",
  "show edges": "$mod+Shift+Tab",
  "toggle node visibility": "KeyV",
  "toggle pan mode": "KeyM",
  "toggle place mode": "KeyP",

  // Tracks
  transpose: "$mod+KeyT",
  "add track": "$mod+Digit0",
  "delete track": "$mod+Shift+Backspace",

  // Predict
  learning: "$mod+KeyL",

  // Export
  "export clip": "",
  "export_analysis_current": "$mod+Alt+KeyE",

  // Prediction management
  "delete frame predictions": "",
  "delete clip predictions": "",
  "delete area predictions": "",

  // Add videos
  "add videos": "",
  "replace videos": "",

  // Copy/paste
  "copy instance": "$mod+KeyC",
  "paste instance": "$mod+KeyV",
  "copy track": "$mod+Shift+KeyC",
  "paste track": "$mod+Shift+KeyV",

  // Color
  "color predicted": "",
  "show trails": "",
};

/** Frame step sizes for keyboard navigation. */
export const STEP_SIZES = {
  small: 1,
  medium: 10,
  large: 100,
};
