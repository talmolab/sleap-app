import { isMac, isTauri } from "@/lib/platform";

/**
 * Whether this build shows its menus in the native menu bar (macOS desktop)
 * instead of the in-window menu bar. Its own module, with no imports beyond
 * the platform, so anything (the tutorial steps, the app shell) can check it
 * without pulling in the whole menu definition.
 */
export const NATIVE_MENU_BAR = isTauri && isMac;
