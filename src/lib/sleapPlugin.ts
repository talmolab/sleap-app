/**
 * SPIKE (spike/tauri-localhost-origin): the app's native Rust commands are exposed via
 * the inlined "sleap" Tauri plugin (src-tauri/build.rs + lib.rs) instead of bare app
 * commands, so they stay reachable when the frontend is served from the http://localhost
 * origin — where Tauri blocks bare custom commands as "remote" content. Route every
 * app-command invoke through `sleapCmd()` so the command name carries the `plugin:sleap|`
 * prefix Tauri needs to resolve + ACL-check it.
 */
export const SLEAP_CMD_PREFIX = "plugin:sleap|";

/** Prefix a bare command name for the inlined `sleap` plugin (idempotent). */
export function sleapCmd(name: string): string {
  return name.startsWith(SLEAP_CMD_PREFIX) ? name : `${SLEAP_CMD_PREFIX}${name}`;
}
