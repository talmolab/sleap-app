/**
 * Guard against an invalid `navigator.language` before any other module loads.
 *
 * On Linux with no locale configured (`LANG` unset or `LANG=C`, common in
 * remote-desktop sessions and minimal VMs), the GTK3 WebKitGTK build that
 * Tauri uses reports `navigator.language === "C"`. That isn't a BCP 47 tag, so
 * `new Intl.NumberFormat("C")` throws `RangeError: invalid language tag: C`.
 * uPlot makes exactly that call at module scope, so the whole bundle failed to
 * evaluate and the desktop window stayed blank (dark background, empty
 * `#root`). Chrome and the GTK4 WebKit build map the C locale to a real tag
 * themselves, which is why the bug only showed up in the desktop app.
 *
 * Imported first in `main.tsx`: ES modules evaluate in import order, so this
 * runs before uPlot (or anything else) reads `navigator.language`.
 */

const FALLBACK_LOCALE = "en-US";

/** True if `tag` is a locale `Intl` accepts. */
export function isValidLocale(tag: string | undefined): boolean {
  if (!tag) return false;
  try {
    new Intl.NumberFormat(tag);
    return true;
  } catch {
    return false;
  }
}

/**
 * If `navigator.language` isn't a valid locale, shadow `navigator.language`
 * and `navigator.languages` with the first valid entry of `navigator.languages`
 * (or `en-US`). A valid `navigator.language` is left untouched.
 */
export function sanitizeNavigatorLanguage(): void {
  if (typeof navigator === "undefined" || isValidLocale(navigator.language)) return;

  const valid = (navigator.languages ?? []).filter(isValidLocale);
  const language = valid[0] ?? FALLBACK_LOCALE;
  const languages = Object.freeze(valid.length > 0 ? [...valid] : [language]);

  try {
    Object.defineProperty(navigator, "language", { get: () => language, configurable: true });
    Object.defineProperty(navigator, "languages", { get: () => languages, configurable: true });
    console.warn(
      `[locale] navigator.language was not a valid locale; using "${language}" instead.`,
    );
  } catch {
    // A navigator we can't redefine is no worse off than before.
  }
}

sanitizeNavigatorLanguage();
