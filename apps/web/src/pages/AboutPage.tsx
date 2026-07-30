import { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { PublicHeader } from '../components/PublicHeader';
import { SiteFooter } from '../components/SiteFooter';
import { useT } from '../lib/i18n';
import { githubUrl as resolveGithubUrl } from '../lib/project-links';
import { preferredPublicTheme, storePublicTheme, type PublicTheme } from '../lib/public-theme';
import { siteHref } from '../public-routing';

export function AboutPage({ githubUrl = resolveGithubUrl() }: { githubUrl?: string } = {}) {
  const t = useT();
  const [theme, setTheme] = useState<PublicTheme>(preferredPublicTheme);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = t.about.documentTitle;
    return () => {
      document.title = previousTitle;
    };
  }, [t]);

  function changeTheme(next: PublicTheme) {
    setTheme(next);
    storePublicTheme(next);
  }

  return (
    <main className="public-page" data-public-theme={theme}>
      <div className="public-glow public-glow-warm" />

      {/* Shared with the support page, and carrying no support link of its own:
          this page used to offer the same call to action in three places. */}
      <PublicHeader githubUrl={githubUrl} theme={theme} onThemeChange={changeTheme} />

      <article className="about-page">
        <p className="public-eyebrow">{t.about.eyebrow}</p>
        <h1>{t.about.title}</h1>
        <p className="about-lead">{t.about.lead}</p>
        <section className="about-card">
          <div>
            <h2>{t.about.supportHeading}</h2>
            <p>{t.about.supportBody}</p>
          </div>
          <a
            className="support-button support-button-primary"
            href={siteHref('/support?source=website&placement=about')}
          >
            {t.about.supportAction} <ArrowRight size={17} />
          </a>
        </section>
      </article>

      {/* This page is itself the support call to action, so the footer stays out
          of the way instead of repeating it in the bottom corner. */}
      <SiteFooter omit={['about', 'support']} />
    </main>
  );
}
