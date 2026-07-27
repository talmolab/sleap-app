/**
 * Open a fresh, empty app instance — the Welcome screen (New / Open over the
 * logo) — leaving the current project untouched. This backs Cmd+N and File >
 * New Project, replacing the old "reset this window to an empty project" flow.
 *
 * One project per isolated instance (separate JS heap), so two large embedded
 * pkg.slp projects never share the ~4 GB WebAssembly budget:
 *   - Browser: a new tab (the browser's own tab UI).
 *   - Desktop (Tauri): a new native window.
 */

import { getPlatform } from "@/platform/index";

export async function openNewInstance(): Promise<void> {
  const platform = await getPlatform();

  // Load the SAME origin the current instance runs on. In the packaged desktop
  // app that's an http://localhost URL (the trick that yields cross-origin
  // isolation); a bare relative "/" would drop to the app:// protocol and the
  // new window would lose isolation. In the browser it's the site origin +
  // Vite base (e.g. app.sleap.ai/dev/).
  const base = `${location.origin}${import.meta.env.BASE_URL}`;

  if (platform.isTauri) {
    // Desktop: spawn a second native window. Each WebviewWindow is its own
    // WebView (isolated JS heap). The label must be unique for the app's
    // lifetime — reusing one throws — so stamp it with the current time. Match
    // the main window's geometry (lib.rs: 1280x800, min 800x600).
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    new WebviewWindow(`main-${Date.now()}`, {
      url: base,
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
  const opened = window.open(base, "_blank");
  if (!opened) {
    const { toast } = await import("@/lib/notify");
    toast.warning("Couldn't open a new window", {
      description:
        "Your browser blocked the pop-up. Allow pop-ups for this site, or open a new tab manually.",
    });
  }
}
