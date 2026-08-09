import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  ArrowDown,
  ArrowUp,
  BookOpen,
  Languages,
  ChevronRight,
  Download,
  ExternalLink,
  HeartHandshake,
  Info,
  MessageCircle,
  MessageSquarePlus,
  Plus,
  Trash2,
  Upload,
  UserRound,
  Zap,
  X
} from 'lucide-react';
import { EXPORT_PATH } from '../lib/cloud';
import { APP_VERSION, githubUrl } from '../lib/project-links';
import { cloudUrl } from '../lib/runtime-config';
import { siteHref } from '../public-routing';
import { LOCALES, LOCALE_NAMES, useLocale, type Locale } from '../lib/i18n';
import { createId } from '../lib/id';
import {
  MAX_QUICK_REPLIES,
  moveQuickReply,
  type QuickReplySettings
} from '../lib/quick-replies';
import type { ReplySuggestionsSettings } from '../lib/reply-suggestions';

interface AppSettingsPanelProps {
  open: boolean;
  onClose: () => void;
  onImport: () => void;
  onMigrate: () => void;
  onPersonas: () => void;
  onWorldbooks: () => void;
  onFeedback: () => void;
  quickReplies: QuickReplySettings;
  onQuickRepliesChange: (settings: QuickReplySettings) => void;
  replySuggestions: ReplySuggestionsSettings;
  onReplySuggestionsChange: (settings: ReplySuggestionsSettings) => void;
}

type SettingsView = 'root' | 'data' | 'quickReplies' | 'about';

export function AppSettingsPanel({
  open,
  onClose,
  onImport,
  onMigrate,
  onPersonas,
  onWorldbooks,
  onFeedback,
  quickReplies,
  onQuickRepliesChange,
  replySuggestions,
  onReplySuggestionsChange
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
      : view === 'quickReplies'
        ? t.settings.quickRepliesTitle
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
              <button type="button" onClick={() => setView('quickReplies')}>
                <span className="app-settings-icon"><Zap size={19} /></span>
                <span>
                  <strong>{t.settings.quickRepliesTitle}</strong>
                  <small>{t.settings.quickRepliesBody}</small>
                </span>
                <ChevronRight size={18} />
              </button>
              {/* On phones the floating launcher is hidden — it covered the
                  composer — so this is the way in to feedback there. */}
              <button type="button" onClick={onFeedback}>
                <span className="app-settings-icon"><MessageSquarePlus size={19} /></span>
                <span>
                  <strong>{t.settings.feedbackTitle}</strong>
                  <small>{t.settings.feedbackBody}</small>
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

          {view === 'quickReplies' && (
            <div className="quick-reply-settings">
              <p className="app-settings-lead">{t.settings.quickRepliesLead}</p>
              <div className="quick-reply-preferences">
                <label>
                  <span>
                    <strong>{t.settings.replySuggestionsTrigger}</strong>
                    {/* The cost is stated here rather than discovered from a
                        shrinking allowance: automatic is one extra model call per
                        reply, and opting in to that has to be a knowing choice. */}
                    <small>{t.settings.replySuggestionsTriggerBody}</small>
                  </span>
                  <select
                    value={replySuggestions.trigger}
                    onChange={(event) => onReplySuggestionsChange({
                      ...replySuggestions,
                      trigger:
                        event.target.value === 'AUTOMATIC' ? 'AUTOMATIC' : 'MANUAL'
                    })}
                  >
                    <option value="MANUAL">{t.settings.replySuggestionsManual}</option>
                    <option value="AUTOMATIC">
                      {t.settings.replySuggestionsAutomatic}
                    </option>
                  </select>
                </label>
                <label>
                  <span>
                    <strong>{t.settings.quickRepliesEnabled}</strong>
                    <small>{t.settings.quickRepliesEnabledBody}</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={quickReplies.enabled}
                    onChange={(event) => onQuickRepliesChange({
                      ...quickReplies,
                      enabled: event.target.checked
                    })}
                  />
                </label>
                <label>
                  <span>
                    <strong>{t.settings.quickRepliesBehavior}</strong>
                    <small>{t.settings.quickRepliesBehaviorBody}</small>
                  </span>
                  <select
                    value={quickReplies.behavior}
                    onChange={(event) => onQuickRepliesChange({
                      ...quickReplies,
                      behavior: event.target.value === 'SEND' ? 'SEND' : 'FILL'
                    })}
                  >
                    <option value="FILL">{t.settings.quickRepliesFill}</option>
                    <option value="SEND">{t.settings.quickRepliesSend}</option>
                  </select>
                </label>
              </div>
              <div className="quick-reply-editor-list">
                {quickReplies.replies.map((reply, index) => (
                  <article className="quick-reply-editor" key={reply.id}>
                    <label className="quick-reply-enabled">
                      <input
                        type="checkbox"
                        checked={reply.enabled}
                        aria-label={t.settings.quickReplyEnabled(reply.label || String(index + 1))}
                        onChange={(event) => onQuickRepliesChange({
                          ...quickReplies,
                          replies: quickReplies.replies.map((item) => item.id === reply.id
                            ? { ...item, enabled: event.target.checked }
                            : item)
                        })}
                      />
                    </label>
                    <div className="quick-reply-fields">
                      <input
                        value={reply.label}
                        maxLength={80}
                        aria-label={t.settings.quickReplyLabel(index + 1)}
                        placeholder={t.settings.quickReplyLabelPlaceholder}
                        onChange={(event) => onQuickRepliesChange({
                          ...quickReplies,
                          replies: quickReplies.replies.map((item) => item.id === reply.id
                            ? { ...item, label: event.target.value }
                            : item)
                        })}
                      />
                      <textarea
                        value={reply.message}
                        maxLength={2000}
                        rows={2}
                        aria-label={t.settings.quickReplyMessage(index + 1)}
                        placeholder={t.settings.quickReplyMessagePlaceholder}
                        onChange={(event) => onQuickRepliesChange({
                          ...quickReplies,
                          replies: quickReplies.replies.map((item) => item.id === reply.id
                            ? { ...item, message: event.target.value }
                            : item)
                        })}
                      />
                    </div>
                    <div className="quick-reply-order">
                      <button
                        type="button"
                        disabled={index === 0}
                        aria-label={t.settings.moveQuickReplyUp}
                        onClick={() => onQuickRepliesChange({
                          ...quickReplies,
                          replies: moveQuickReply(quickReplies.replies, reply.id, -1)
                        })}
                      ><ArrowUp size={15} /></button>
                      <button
                        type="button"
                        disabled={index === quickReplies.replies.length - 1}
                        aria-label={t.settings.moveQuickReplyDown}
                        onClick={() => onQuickRepliesChange({
                          ...quickReplies,
                          replies: moveQuickReply(quickReplies.replies, reply.id, 1)
                        })}
                      ><ArrowDown size={15} /></button>
                      <button
                        type="button"
                        aria-label={t.settings.deleteQuickReply}
                        onClick={() => onQuickRepliesChange({
                          ...quickReplies,
                          replies: quickReplies.replies.filter((item) => item.id !== reply.id)
                        })}
                      ><Trash2 size={15} /></button>
                    </div>
                  </article>
                ))}
              </div>
              <button
                type="button"
                className="quick-reply-add"
                disabled={quickReplies.replies.length >= MAX_QUICK_REPLIES}
                onClick={() => onQuickRepliesChange({
                  ...quickReplies,
                  replies: [...quickReplies.replies, {
                    id: createId(), label: '', message: '', enabled: true
                  }]
                })}
              >
                <Plus size={16} /> {t.settings.addQuickReply}
              </button>
            </div>
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
