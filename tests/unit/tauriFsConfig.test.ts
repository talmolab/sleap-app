import { describe, it, expect } from "bun:test";
import tauriConf from "../../src-tauri/tauri.conf.json";

describe("tauri.conf.json fs plugin", () => {
  // tauri-plugin-fs defaults requireLiteralLeadingDot to true on Unix, so the
  // `**` scope silently skips hidden directories. On Linux the app's own data
  // lives in ~/.local/share/org.sleap.app and ~/.cache/org.sleap.app, so the
  // sample-video cache, session logs, autosave drafts and transcode cache were
  // all denied there (macOS paths have no leading dot, which hid the bug).
  it("lets the ** scope match hidden directories", () => {
    const plugins = tauriConf.plugins as { fs?: { requireLiteralLeadingDot?: boolean } };
    expect(plugins.fs?.requireLiteralLeadingDot).toBe(false);
  });
});
