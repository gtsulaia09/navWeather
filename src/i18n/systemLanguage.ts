/**
 * The device's language tag ("en-GB", "ru-RU"), wherever this code runs: a browser (`navigator.language`), a
 * React Native app (no `navigator.language`; Hermes has `Intl`), Node or a Web Worker. Never throws; "en" when
 * nothing says otherwise.
 */
export function systemLanguage(): string {
  try {
    const nav = (globalThis as { navigator?: { language?: unknown } }).navigator;
    if (typeof nav?.language === 'string' && nav.language) return nav.language;
  } catch {
    /* no navigator */
  }
  try {
    const locale = Intl.DateTimeFormat().resolvedOptions().locale;
    if (locale) return locale;
  } catch {
    /* no Intl */
  }
  return 'en';
}
