/**
 * Open a fresh app instance in a new window/tab, leaving the current project
 * untouched. Without a file it lands on the Welcome screen (New / Open) — this
 * backs Cmd+N and File > New Project. With a `file`, the new window auto-opens
 * that .slp on mount (used by the "open in a new window" routing, so a running
 * project is never clobbered).
 *
 * One project per isolated instance (separate JS heap), so two large embedded
 * pkg.slp projects never share the ~4 GB WebAssembly budget:
 *   - Browser: a new tab (the browser's own tab UI).
 *   - Desktop (Tauri): a new native window.
 */

import { getPlatform } from "@/platform/index";

/**
 * URL for a new instance that should auto-open `file` on mount. The path rides
 * as an `?openFile=` query param (URL-encoded) — race-free (unlike a shared Rust
 * slot) and works on both the dev origin and the localhost release origin.
 */
export function buildInstanceUrl(base: string, file?: string): string {
  if (!file) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}openFile=${encodeURIComponent(file)}`;
}

export async function openNewInstance(
  opts?: { file?: string }
): Promise<void> {
  const platform = await getPlatform();

  // Load the SAME origin the current instance runs on. In the packaged desktop
  // app that's an http://localhost URL (the trick that yields cross-origin
  // isolation); a bare relative "/" would drop to the app:// protocol and the
  // new window would lose isolation. In the browser it's the site origin +
  // Vite base (e.g. app.sleap.ai/dev/).
  const base = `${location.origin}${import.meta.env.BASE_URL}`;
  const url = buildInstanceUrl(base, opts?.file);

  if (platform.isTauri) {
    // Desktop: spawn a second native window. Each WebviewWindow is its own
    // WebView (isolated JS heap). The label must be unique for the app's
    // lifetime — reusing one throws — so stamp it with the current time. Match
    // the main window's geometry (lib.rs: 1280x800, min 800x600).
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    new WebviewWindow(`main-${Date.now()}`, {
      url,
      title: "SLEAP",
      width: 1280,
      height: 800,
      minWidth: 800,
      minHeight: 600,
    });
    return;
  }

  // Browser: open a new tab. A fresh SPA load shows the Welcome screen; the
  // current tab keeps its project. Fired straight off the user's gesture
  // (keystroke/click) so it isn't treated as an unsolicited pop-up.
  const opened = window.open(url, "_blank");
  if (!opened) {
    const { toast } = await import("@/lib/notify");
    toast.warning("Couldn't open a new window", {
      description:
        "Your browser blocked the pop-up. Allow pop-ups for this site, or open a new tab manually.",
    });
  }
}
