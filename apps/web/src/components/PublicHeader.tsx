import { ArrowLeft, Languages, Moon, Sparkles, Sun } from 'lucide-react';
import { LOCALES, LOCALE_NAMES, useLocale, type Locale } from '../lib/i18n';
import type { PublicTheme } from '../lib/public-theme';
import { siteHref } from '../public-routing';

/** lucide-react dropped brand glyphs, so the GitHub mark ships with the header. */
function GithubMark({ size = 17 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M12 .5C5.73.5.99 5.24.99 11.51c0 4.86 3.15 8.98 7.52 10.43.55.1.75-.24.75-.53
        0-.26-.01-1.13-.02-2.05-3.06.67-3.71-1.3-3.71-1.3-.5-1.27-1.22-1.61-1.22-1.61-1-.68.08-.67.08-.67
        1.1.08 1.68 1.13 1.68 1.13.98 1.68 2.58 1.2 3.21.92.1-.71.38-1.2.7-1.48-2.44-.28-5.01-1.22-5.01-5.44
        0-1.2.43-2.19 1.13-2.96-.11-.28-.49-1.4.11-2.92 0 0 .92-.3 3.02 1.13a10.4 10.4 0 0 1 5.5 0c2.1-1.43
        3.02-1.13 3.02-1.13.6 1.52.22 2.64.11 2.92.7.77 1.13 1.76 1.13 2.96 0 4.23-2.58 5.16-5.03 5.43.39.34.74
        1.01.74 2.04 0 1.47-.01 2.66-.01 3.02 0 .29.2.64.76.53a10.53 10.53 0 0 0 7.51-10.43C23.01 5.24 18.27.5
        12 .5Z" />
    </svg>
  );
}

interface PublicHeaderProps {
  githubUrl: string;
  theme: PublicTheme;
  onThemeChange: (theme: PublicTheme) => void;
}

export function PublicHeader({ githubUrl, theme, onThemeChange }: PublicHeaderProps) {
  const { locale, dictionary: t, setLocale } = useLocale();
  return (
    <header className="public-header">
      {/* One way back, on the left where a back control belongs. The brand and the
          "return to LiteTavern" link pointed at the same place, so they are one
          control instead of two — the second one sat in the top-right corner. */}
      <a className="public-brand" href={siteHref('/')} aria-label={t.publicChrome.backToApp}>
        <span className="public-brand-back"><ArrowLeft size={16} /></span>
        <Sparkles size={21} />
        <span>LiteTavern</span>
      </a>

      <div className="public-header-actions">
        <a
          className="public-header-link"
          href={githubUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          <GithubMark /> GitHub
        </a>

        {/* A visitor who cannot read the page needs this before anything else, so
            it sits in the header rather than behind a settings panel. */}
        <label className="locale-select">
          <Languages size={15} />
          <span className="visually-hidden">{t.language.ariaLabel}</span>
          <select
            aria-label={t.language.ariaLabel}
            value={locale}
            onChange={(event) => setLocale(event.target.value as Locale)}
          >
            {LOCALES.map((option) => (
              <option key={option} value={option}>{LOCALE_NAMES[option]}</option>
            ))}
          </select>
        </label>

        <div className="theme-switch" role="group" aria-label={t.publicChrome.appearance}>
          <button
            type="button"
            aria-label={t.publicChrome.lightMode}
            aria-pressed={theme === 'light'}
            onClick={() => onThemeChange('light')}
          >
            <Sun size={15} />
          </button>
          <button
            type="button"
            aria-label={t.publicChrome.darkMode}
            aria-pressed={theme === 'dark'}
            onClick={() => onThemeChange('dark')}
          >
            <Moon size={15} />
          </button>
        </div>
      </div>
    </header>
  );
}
