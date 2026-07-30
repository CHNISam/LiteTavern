import { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Code2,
  Globe,
  Heart,
  HeartHandshake,
  MessagesSquare,
  Server,
  ShieldCheck,
  Sparkles,
  Zap
} from 'lucide-react';
import { PublicHeader } from '../components/PublicHeader';
import { SiteFooter } from '../components/SiteFooter';
import { SupporterClaimDialog } from '../components/SupporterClaimDialog';
import { SupportOrbit } from '../components/SupportOrbit';
import { analytics } from '../lib/analytics';
import { readCachedStatus } from '../lib/cloud';
import { useLocale, type Dictionary } from '../lib/i18n';
import { APP_VERSION, githubUrl as resolveGithubUrl } from '../lib/project-links';
import { preferredPublicTheme, storePublicTheme, type PublicTheme } from '../lib/public-theme';
import {
  normalizeSupportPlacement,
  normalizeSupportSource,
  supportConfig,
  type SupportConfig,
  type SupportMethod,
  type SupportPlacement,
  type SupportSource
} from '../lib/support-config';

interface SupportAttribution {
  source: SupportSource;
  placement: SupportPlacement;
  is_authenticated: boolean;
}

interface SupportMethodAttribution extends SupportAttribution {
  method: SupportMethod;
}

export interface SupportTracker {
  pageView: (attribution: SupportAttribution) => void;
  methodClick: (attribution: SupportMethodAttribution) => void;
  claimOpened: (attribution: SupportAttribution) => void;
  claimSubmitted: (attribution: SupportAttribution) => void;
}

let publicAnalyticsInitialization: Promise<void> | null = null;

function initializePublicAnalytics(): Promise<void> {
  publicAnalyticsInitialization ??= analytics.initialize({
    userId: '',
    anonymousId: '',
    url: window.location.href,
    referrer: document.referrer,
    appVersion: APP_VERSION
  });
  return publicAnalyticsInitialization;
}

const defaultTracker: SupportTracker = {
  pageView(attribution) {
    void initializePublicAnalytics().then(() =>
      analytics.supportEvent('support_page_view', {
        ...attribution,
        isAuthenticated: attribution.is_authenticated
      })
    );
  },
  methodClick(attribution) {
    void initializePublicAnalytics().then(() =>
      analytics.supportEvent('support_method_click', {
        ...attribution,
        isAuthenticated: attribution.is_authenticated
      })
    );
  },
  claimOpened(attribution) {
    void initializePublicAnalytics().then(() =>
      analytics.supporterClaimEvent('supporter_claim_opened', {
        ...attribution,
        isAuthenticated: attribution.is_authenticated
      })
    );
  },
  claimSubmitted(attribution) {
    void initializePublicAnalytics().then(() =>
      analytics.supporterClaimEvent('supporter_claim_submitted', {
        ...attribution,
        isAuthenticated: attribution.is_authenticated
      })
    );
  }
};

function sourceContent(t: Dictionary, source: SupportSource): { title: string; body: string } {
  const s = t.support.sources;
  if (source === 'github') return { title: s.githubTitle, body: s.githubBody };
  return { title: s.websiteTitle, body: s.websiteBody };
}

interface SupportPageProps {
  source?: string | null;
  placement?: string | null;
  config?: SupportConfig;
  tracker?: SupportTracker;
  isAuthenticated?: boolean;
  githubUrl?: string;
}

export function SupportPage({
  source: sourceValue,
  placement: placementValue,
  config = supportConfig(),
  tracker = defaultTracker,
  isAuthenticated = readCachedStatus()?.registered ?? false,
  githubUrl = resolveGithubUrl()
}: SupportPageProps) {
  const { dictionary: t } = useLocale();
  const source = normalizeSupportSource(sourceValue);
  const placement = normalizeSupportPlacement(
    placementValue ?? (source === 'github' ? 'readme' : null)
  );
  const [theme, setTheme] = useState<PublicTheme>(preferredPublicTheme);
  const [claimOpen, setClaimOpen] = useState(false);
  const pageTracked = useRef(false);
  const content = sourceContent(t, source);
  const commonAttribution = {
    source,
    placement,
    is_authenticated: isAuthenticated
  } satisfies SupportAttribution;

  const supportUses = [
    { icon: Server, title: t.support.uses.infraTitle, body: t.support.uses.infraBody },
    { icon: Zap, title: t.support.uses.modelTitle, body: t.support.uses.modelBody },
    { icon: Globe, title: t.support.uses.domainTitle, body: t.support.uses.domainBody },
    { icon: Code2, title: t.support.uses.devTitle, body: t.support.uses.devBody }
  ];

  const supportThanks = [
    { icon: MessagesSquare, title: t.support.thanks.voiceTitle, body: t.support.thanks.voiceBody },
    { icon: Heart, title: t.support.thanks.rememberTitle, body: t.support.thanks.rememberBody }
  ];

  const supportNotes = [
    { icon: ShieldCheck, title: t.support.notes.voluntaryTitle, body: t.support.notes.voluntaryBody },
    { icon: Sparkles, title: t.support.notes.noGateTitle, body: t.support.notes.noGateBody },
    { icon: HeartHandshake, title: t.support.notes.projectTitle, body: t.support.notes.projectBody }
  ];

  useEffect(() => {
    if (pageTracked.current) return;
    pageTracked.current = true;
    tracker.pageView(commonAttribution);
  }, [isAuthenticated, placement, source, tracker]);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = t.support.documentTitle;
    return () => {
      document.title = previousTitle;
    };
  }, [t]);

  function trackMethod(method: SupportMethod) {
    tracker.methodClick({ ...commonAttribution, method });
  }

  function openClaim() {
    setClaimOpen(true);
    tracker.claimOpened(commonAttribution);
  }

  function changeTheme(next: PublicTheme) {
    setTheme(next);
    storePublicTheme(next);
  }

  return (
    <main className="public-page support-page" data-public-theme={theme}>
      <div className="public-glow public-glow-warm" />
      <div className="public-glow public-glow-cool" />

      <PublicHeader githubUrl={githubUrl} theme={theme} onThemeChange={changeTheme} />

      <div className="support-shell">
        <section className="support-hero">
          <div className="support-hero-copy">
            <p className="public-eyebrow">{t.support.eyebrow}</p>
            <h1>{t.support.heroTitle}</h1>
            <p>{t.support.heroLead}</p>
            <p>{t.support.heroBody}</p>
          </div>
          <SupportOrbit />
        </section>

        <section className="source-notice" aria-labelledby="source-title">
          <Sparkles size={18} />
          <div>
            <h2 id="source-title">{content.title}</h2>
            <p>{content.body}</p>
          </div>
        </section>

        <section className="support-section" aria-labelledby="uses-title">
          <h2 className="support-section-title" id="uses-title">{t.support.usesTitle}</h2>
          <div className="support-grid support-grid-4">
            {supportUses.map(({ icon: Icon, title, body }) => (
              <article className="support-tile" key={title}>
                <span className="support-icon"><Icon size={20} /></span>
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="support-section" aria-labelledby="methods-title">
          <h2 className="support-section-title" id="methods-title">{t.support.methodsTitle}</h2>
          <div className="support-methods">
            <section className="support-card support-card-primary" aria-labelledby="afdian-title">
              <div className="support-card-heading">
                <span className="support-icon"><HeartHandshake size={20} /></span>
                <div>
                  <h3 className="support-card-title" id="afdian-title">{t.support.afdian.title}</h3>
                  <p className="support-kicker">{t.support.cadenceMonthly}</p>
                </div>
              </div>
              <p className="support-card-copy">{t.support.afdian.body}</p>
              {config.afdianUrl ? (
                <a
                  className="support-button support-button-primary"
                  href={config.afdianUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => trackMethod('afdian')}
                >
                  {t.support.afdian.action} <ArrowUpRight size={16} />
                </a>
              ) : (
                <p className="support-inline-unavailable">{t.support.afdian.unavailable}</p>
              )}
            </section>
          </div>

          <button type="button" className="claim-entry" onClick={openClaim}>
            {t.claim.open}
          </button>
        </section>

        <section className="support-section" aria-labelledby="thanks-title">
          <h2 className="support-section-title" id="thanks-title">{t.support.thanksTitle}</h2>
          <div className="support-grid support-grid-2">
            {supportThanks.map(({ icon: Icon, title, body }) => (
              <article className="support-tile" key={title}>
                <span className="support-icon"><Icon size={20} /></span>
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="support-section" aria-labelledby="notes-title">
          <h2 className="support-section-title" id="notes-title">{t.support.notesTitle}</h2>
          <div className="support-notes">
            <ul>
              {supportNotes.map(({ icon: Icon, title, body }) => (
                <li key={title}>
                  <span className="support-note-icon"><Icon size={17} /></span>
                  <div>
                    <strong>{title}</strong>
                    <span>{body}</span>
                  </div>
                </li>
              ))}
            </ul>
            <p className="support-fineprint">{t.support.fineprint}</p>
          </div>
        </section>
      </div>

      <SiteFooter omit={['support']} />

      <SupporterClaimDialog
        open={claimOpen}
        onClose={() => setClaimOpen(false)}
        onSubmitted={() => tracker.claimSubmitted(commonAttribution)}
      />
    </main>
  );
}
