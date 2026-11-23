import { en, type Messages } from './en';
import { systemLanguage } from './systemLanguage';

export type Locale = 'en' | 'ru' | 'ka';
export const LOCALES: { id: Locale; name: string }[] = [
  { id: 'en', name: 'English' },
  { id: 'ru', name: 'Русский' },
  { id: 'ka', name: 'ქართული' },
];

/**
 * English ships with the app; Russian and Georgian load on demand, so nobody
 * downloads a language they don't use.
 */
const table: Partial<Record<Locale, Messages>> = { en };
const loaders: Record<Exclude<Locale, 'en'>, () => Promise<Messages>> = {
  ru: () => import('./ru').then((mod) => mod.ru),
  ka: () => import('./ka').then((mod) => mod.ka),
};

export function getMessages(locale: Locale): Messages {
  return table[locale] ?? en;
}

export function isLocaleLoaded(locale: Locale): boolean {
  return !!table[locale];
}

export async function loadLocale(locale: Locale): Promise<void> {
  if (table[locale] || locale === 'en') return;
  table[locale] = await loaders[locale]();
}

/** Best supported locale for the device language. */
export function detectLocale(lang = systemLanguage()): Locale {
  const base = lang.slice(0, 2).toLowerCase();
  if (base === 'ru' || base === 'ka') return base;
  return 'en';
}

export { en };
export type { Messages };
