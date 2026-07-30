import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  BookOpen,
  Languages,
  ChevronRight,
  Download,
  ExternalLink,
  HeartHandshake,
  Info,
  MessageCircle,
  Upload,
  UserRound,
  X
} from 'lucide-react';
import { EXPORT_PATH } from '../lib/cloud';
import { APP_VERSION, githubUrl } from '../lib/project-links';
import { cloudUrl } from '../lib/runtime-config';
import { siteHref } from '../public-routing';
import { LOCALES, LOCALE_NAMES, useLocale, type Locale } from '../lib/i18n';

interface AppSettingsPanelProps {
  open: boolean;
  onClose: () => void;
  onImport: () => void;
  onMigrate: () => void;
  onPersonas: () => void;
  onWorldbooks: () => void;
}

type SettingsView = 'root' | 'data' | 'about';

export function AppSettingsPanel({
  open,
  onClose,
  onImport,
  onMigrate,
  onPersonas,
  onWorldbooks
}: AppSettingsPanelProps) {
  const { locale, dictionary: t, setLocale } = useLocale();
  const [view, setView] = useState<SettingsView>('root');

  useEffect(() => {
    if (!open) setView('root');
  }, [open]);

  if (!open) return null;

  const title =
    view === 'data'
      ? t.settings.dataTitle
      : view === 'about'
        ? t.settings.aboutTitle
        : t.settings.title;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="app-settings-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t.settings.title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="app-settings-header">
          {/* Grid rows, not inline flow: the back control and the eyebrow used to
              run together on one line and collide. On a sub-view the back control
              replaces the eyebrow rather than stacking with it. */}
          <div className="app-settings-heading">
            {view === 'root' ? (
              <span className="eyebrow">LiteTavern</span>
            ) : (
              <button
                type="button"
                className="app-settings-back"
                aria-label={t.settings.backToSettings}
                onClick={() => setView('root')}
              >
                <ArrowLeft size={17} /> {t.settings.backToSettings}
              </button>
            )}
            <h2>{title}</h2>
          </div>
          <button className="icon-button" aria-label={t.common.close} onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        <div className="app-settings-body">
          {view === 'root' && (
            <nav className="app-settings-list" aria-label={t.settings.sections}>
              {/* Top of the list, not buried in a sub-view: someone who opened
                  Settings because they cannot read the UI must find this first. */}
              <label className="app-settings-locale">
                <span className="app-settings-icon"><Languages size={19} /></span>
                <span>
                  <strong>{t.language.label}</strong>
                  <small>{t.language.description}</small>
                </span>
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
              <button type="button" onClick={onPersonas}>
                <span className="app-settings-icon"><UserRound size={19} /></span>
                <span>
                  <strong>{t.settings.personasTitle}</strong>
                  <small>{t.settings.personasBody}</small>
                </span>
                <ChevronRight size={18} />
              </button>
              <button type="button" onClick={onWorldbooks}>
                <span className="app-settings-icon"><BookOpen size={19} /></span>
                <span>
                  <strong>{t.settings.worldbooksTitle}</strong>
                  <small>{t.settings.worldbooksBody}</small>
                </span>
                <ChevronRight size={18} />
              </button>
              <button type="button" onClick={() => setView('data')}>
                <span className="app-settings-icon"><Upload size={19} /></span>
                <span>
                  <strong>{t.settings.dataTitle}</strong>
                  <small>{t.settings.dataBody}</small>
                </span>
                <ChevronRight size={18} />
              </button>
              <button type="button" onClick={() => setView('about')}>
                <span className="app-settings-icon"><Info size={19} /></span>
                <span>
                  <strong>{t.settings.aboutTitle}</strong>
                  <small>{t.settings.aboutBody}</small>
                </span>
                <ChevronRight size={18} />
              </button>
            </nav>
          )}

          {view === 'data' && (
            <>
              <p className="app-settings-lead">
                {t.settings.dataLead}
              </p>
              <div className="app-settings-list">
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onImport();
                  }}
                >
                  <span className="app-settings-icon"><Upload size={19} /></span>
                  <span>
                    <strong>{t.settings.importCard}</strong>
                    <small>{t.settings.importCardBody}</small>
                  </span>
                  <ChevronRight size={18} />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onMigrate();
                  }}
                >
                  <span className="app-settings-icon"><HeartHandshake size={19} /></span>
                  <span>
                    <strong>{t.settings.migrate}</strong>
                    <small>{t.settings.migrateBody}</small>
                  </span>
                  <ChevronRight size={18} />
                </button>
                <a href={cloudUrl(EXPORT_PATH)} download>
                  <span className="app-settings-icon"><Download size={19} /></span>
                  <span>
                    <strong>{t.settings.exportCloud}</strong>
                    <small>{t.settings.exportCloudBody}</small>
                  </span>
                  <ChevronRight size={18} />
                </a>
              </div>
            </>
          )}

          {view === 'about' && (
            // Self-contained: this panel used to hand off to /about, which showed
            // the same thing again and pushed another page onto the stack.
            <div className="app-about">
              <div className="app-about-identity">
                <span className="app-about-mark"><MessageCircle size={25} /></span>
                <div>
                  <h3>LiteTavern</h3>
                  <span className="app-about-version">{t.settings.version(APP_VERSION)}</span>
                </div>
              </div>
              <p>{t.settings.appTagline}</p>
              <a
                className="app-about-link"
                href={githubUrl()}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t.settings.viewSource} <ExternalLink size={15} />
              </a>
              <section>
                <h4>{t.settings.supportHeading}</h4>
                <p>
                  {t.settings.supportBody}
                </p>
                <a
                  className="secondary-button"
                  href={siteHref('/support?source=website&placement=about')}
                >
                  {t.settings.supportAction} <ChevronRight size={17} />
                </a>
              </section>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
