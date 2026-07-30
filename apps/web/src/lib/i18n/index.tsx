import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode
} from 'react';
import { en } from './en';
import { zhCN, type Dictionary } from './zh-CN';
import {
  applyDocumentLocale,
  preferredLocale,
  storeLocale,
  type Locale
} from './locale';

export type { Dictionary } from './zh-CN';
export {
  LOCALES,
  LOCALE_NAMES,
  DEFAULT_LOCALE,
  isLocale,
  preferredLocale,
  type Locale
} from './locale';

const DICTIONARIES: Record<Locale, Dictionary> = { 'zh-CN': zhCN, en };

/**
 * The active dictionary, also readable outside React.
 *
 * Error messages and quota copy are produced in plain modules (`lib/api`,
 * `lib/cloud`) that have no component to hang a hook off. They read through
 * `t()`; the provider keeps this in step with the rendered tree.
 */
let activeLocale: Locale = preferredLocale();

export function t(): Dictionary {
  return DICTIONARIES[activeLocale];
}

export function currentLocale(): Locale {
  return activeLocale;
}

/** Set outside React only for tests and for the pre-render bootstrap. */
export function setActiveLocale(locale: Locale): void {
  activeLocale = locale;
  applyDocumentLocale(locale);
}

interface LocaleContextValue {
  locale: Locale;
  dictionary: Dictionary;
  setLocale: (locale: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({
  children,
  initialLocale
}: {
  children: ReactNode;
  initialLocale?: Locale;
}) {
  const [locale, setLocaleState] = useState<Locale>(() => {
    const resolved = initialLocale ?? preferredLocale();
    setActiveLocale(resolved);
    return resolved;
  });

  const setLocale = useCallback((next: Locale) => {
    setActiveLocale(next);
    storeLocale(next);
    setLocaleState(next);
  }, []);

  const value = useMemo(
    () => ({ locale, dictionary: DICTIONARIES[locale], setLocale }),
    [locale, setLocale]
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

/**
 * Components rendered outside a provider (isolated in tests) fall back to the
 * module-level locale rather than throwing: a missing provider must never be the
 * reason a screen fails to render.
 */
export function useLocale(): LocaleContextValue {
  const context = useContext(LocaleContext);
  if (context) return context;
  return {
    locale: activeLocale,
    dictionary: DICTIONARIES[activeLocale],
    setLocale: setActiveLocale
  };
}

/** The dictionary, for components that only read copy. */
export function useT(): Dictionary {
  return useLocale().dictionary;
}
