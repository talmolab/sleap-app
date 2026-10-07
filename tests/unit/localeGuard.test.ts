import { describe, it, expect, afterEach } from "bun:test";
import { isValidLocale, sanitizeNavigatorLanguage } from "@/lib/localeGuard";

const realLanguage = Object.getOwnPropertyDescriptor(navigator, "language");
const realLanguages = Object.getOwnPropertyDescriptor(navigator, "languages");

function fakeNavigator(language: string, languages: string[]) {
  Object.defineProperty(navigator, "language", { get: () => language, configurable: true });
  Object.defineProperty(navigator, "languages", { get: () => languages, configurable: true });
}

afterEach(() => {
  // Drop the own-property shadows so later tests see happy-dom's defaults.
  delete (navigator as unknown as Record<string, unknown>).language;
  delete (navigator as unknown as Record<string, unknown>).languages;
  if (realLanguage) Object.defineProperty(navigator, "language", realLanguage);
  if (realLanguages) Object.defineProperty(navigator, "languages", realLanguages);
});

describe("isValidLocale", () => {
  it("rejects the POSIX C locale that WebKitGTK reports under LANG=C", () => {
    expect(isValidLocale("C")).toBe(false);
    expect(isValidLocale("")).toBe(false);
  });

  it("accepts real BCP 47 tags", () => {
    expect(isValidLocale("en-US")).toBe(true);
    expect(isValidLocale("de")).toBe(true);
  });
});

describe("sanitizeNavigatorLanguage", () => {
  it("replaces an invalid navigator.language with en-US", () => {
    fakeNavigator("C", ["C"]);
    sanitizeNavigatorLanguage();
    expect(navigator.language).toBe("en-US");
    expect([...navigator.languages]).toEqual(["en-US"]);
    // The exact call uPlot makes at module load must no longer throw.
    expect(() => new Intl.NumberFormat(navigator.language)).not.toThrow();
  });

  it("prefers a valid entry from navigator.languages over en-US", () => {
    fakeNavigator("C", ["C", "fr-FR"]);
    sanitizeNavigatorLanguage();
    expect(navigator.language).toBe("fr-FR");
    expect([...navigator.languages]).toEqual(["fr-FR"]);
  });

  it("leaves a valid navigator.language alone", () => {
    fakeNavigator("de-DE", ["de-DE", "en"]);
    sanitizeNavigatorLanguage();
    expect(navigator.language).toBe("de-DE");
    expect([...navigator.languages]).toEqual(["de-DE", "en"]);
  });
});
