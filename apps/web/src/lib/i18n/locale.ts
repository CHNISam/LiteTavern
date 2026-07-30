/**
 * Locale resolution and storage.
 *
 * Kept free of dictionary imports so non-React modules can read the active
 * locale without dragging the whole translation table into their bundle graph.
 */

export const LOCALES = ['zh-CN', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = 'zh-CN';

/** What each locale calls itself. Never translated — a switcher is only usable
 *  if every option is legible to the person who needs it. */
export const LOCALE_NAMES: Record<Locale, string> = {
  'zh-CN': '简体中文',
  en: 'English'
};

const STORAGE_KEY = 'litetavern.locale.v1';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function isLocale(value: string | null | undefined): value is Locale {
  return LOCALES.includes(value as Locale);
}

/**
 * The stored choice wins; otherwise the browser's preference decides. Anything
 * that is not a Chinese variant gets English, because a half-understood UI is
 * worse than a foreign one the reader can actually read.
 */
export function preferredLocale(): Locale {
  const stored = storage()?.getItem(STORAGE_KEY);
  if (isLocale(stored)) return stored;
  const languages =
    typeof navigator === 'undefined'
      ? []
      : [navigator.language, ...(navigator.languages ?? [])].filter(Boolean);
  for (const language of languages) {
    const tag = language.toLowerCase();
    if (tag.startsWith('zh')) return 'zh-CN';
    if (tag.startsWith('en')) return 'en';
  }
  return languages.length > 0 ? 'en' : DEFAULT_LOCALE;
}

export function storeLocale(locale: Locale): void {
  try {
    storage()?.setItem(STORAGE_KEY, locale);
  } catch {
    // A blocked or full storage must never break the product.
  }
}

/** Keeps assistive tech, hyphenation and font selection in step with the UI. */
export function applyDocumentLocale(locale: Locale): void {
  if (typeof document !== 'undefined') document.documentElement.lang = locale;
}
