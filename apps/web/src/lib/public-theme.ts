/**
 * The app shell is dark-only. Public pages are the one surface an unauthenticated
 * visitor lands on from a link, so they honour the visitor's own light/dark
 * preference. The choice is scoped to the public page element and persisted
 * locally; it never touches the app chrome.
 */
export type PublicTheme = 'light' | 'dark';

export const PUBLIC_THEME_STORAGE_KEY = 'litetavern.public-theme';

function isPublicTheme(value: unknown): value is PublicTheme {
  return value === 'light' || value === 'dark';
}

export function readStoredPublicTheme(): PublicTheme | null {
  try {
    const stored = window.localStorage.getItem(PUBLIC_THEME_STORAGE_KEY);
    return isPublicTheme(stored) ? stored : null;
  } catch {
    return null;
  }
}

export function storePublicTheme(theme: PublicTheme): void {
  try {
    window.localStorage.setItem(PUBLIC_THEME_STORAGE_KEY, theme);
  } catch {
    // Private browsing and storage-partitioned embeds simply lose the preference.
  }
}

export function systemPublicTheme(): PublicTheme {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

export function preferredPublicTheme(): PublicTheme {
  return readStoredPublicTheme() ?? systemPublicTheme();
}
