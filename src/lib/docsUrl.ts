/**
 * Resolves the documentation URL for the build that is actually running.
 *
 * Docs are published on their own version axis (`/docs/stable/`,
 * `/docs/latest/`, `/docs/dev/`, `/docs/v<tag>/` -- see deploy.yml), and the
 * rule is that **a Help link lands on the docs for the channel the app is on**:
 *
 *   web      the channel path the bundle is served under -- app.sleap.ai/latest
 *            links to /docs/latest/, /dev/ to /docs/dev/, root to /docs/stable/
 *   desktop  the update channel the app is on, i.e. whatever the Environment
 *            panel shows -- switch to Dev there and Help follows to /docs/dev/
 *
 * The pure mappings live in lib/version.ts; this module only supplies the three
 * runtime inputs those need (base path, Tauri or not, the store's channel), so
 * version.ts stays a leaf module with no store dependency.
 */

import { useAppStore } from "@/stores/appStore";
import { isTauri } from "@/lib/platform";
import {
  APP_VERSION,
  docsUrlFor,
  docsVersionForBasePath,
  docsVersionForDesktop,
  type DocsVersion,
} from "@/lib/version";

/**
 * Which docs folder this build should open, without subscribing to anything.
 *
 * `import.meta.env` is read with `?.` so this stays a total function wherever
 * Vite's define is not in play (same guard as lib/transport.ts).
 */
export function resolveDocsVersion(): DocsVersion {
  // Running from source (`bun run dev` / `bun run tauri:dev`) means working off
  // main, whatever the committed package.json version happens to say -- and it
  // drifts, since nothing on main bumps it. /docs/dev/ tracks main, so that is
  // the honest target for both shells in dev mode.
  //
  // Compared strictly against `true`: Vite replaces DEV with a real boolean
  // (`true` in dev, `false` in a production build), but `bun test` puts the
  // STRING "true" there, which would otherwise short-circuit every test of the
  // branches below.
  if (import.meta.env?.DEV === true) return "dev";

  if (isTauri) {
    const { updateChannel, updateChannelExplicitlySet } = useAppStore.getState();
    return docsVersionForDesktop(
      updateChannel,
      updateChannelExplicitlySet,
      APP_VERSION,
    );
  }

  return docsVersionForBasePath(import.meta.env?.BASE_URL ?? "/");
}

/**
 * Documentation URL for the running build. Call this inside an event handler
 * (a menu item's onClick) so a channel switched mid-session is picked up on the
 * next click; use {@link useDocsUrl} when the URL is rendered into markup.
 */
export function getDocsUrl(): string {
  return docsUrlFor(resolveDocsVersion());
}

/**
 * Documentation URL for the running build, re-rendering if the desktop update
 * channel changes while the link is on screen.
 */
export function useDocsUrl(): string {
  // Subscribed unconditionally -- hooks cannot be called behind the isTauri
  // branch, and on web these two are simply never read by resolveDocsVersion().
  useAppStore((s) => s.updateChannel);
  useAppStore((s) => s.updateChannelExplicitlySet);
  return getDocsUrl();
}
