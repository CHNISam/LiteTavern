import { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { PublicHeader } from '../components/PublicHeader';
import { SiteFooter } from '../components/SiteFooter';
import { githubUrl as resolveGithubUrl } from '../lib/project-links';
import { preferredPublicTheme, storePublicTheme, type PublicTheme } from '../lib/public-theme';
import { siteHref } from '../public-routing';

export function AboutPage({ githubUrl = resolveGithubUrl() }: { githubUrl?: string } = {}) {
  const [theme, setTheme] = useState<PublicTheme>(preferredPublicTheme);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = '关于 LiteTavern';
    return () => {
      document.title = previousTitle;
    };
  }, []);

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
        <p className="public-eyebrow">ABOUT LITETAVERN</p>
        <h1>让角色带着共同经历继续生活</h1>
        <p className="about-lead">
          LiteTavern 是一个持续演化的 AI 角色世界。聊天只是入口，角色、玩家行为、
          世界历史与后续演出共同组成一段可以延续的关系。
        </p>
        <section className="about-card">
          <div>
            <h2>支持 LiteTavern</h2>
            <p>
              开源部分可以免费使用。如果项目对你有帮助，可以自愿支持服务器、
              模型调用、域名及持续开发成本；不支持也不会影响正常使用。
            </p>
          </div>
          <a
            className="support-button support-button-primary"
            href={siteHref('/support?source=website&placement=about')}
          >
            支持 LiteTavern <ArrowRight size={17} />
          </a>
        </section>
      </article>

      {/* This page is itself the support call to action, so the footer stays out
          of the way instead of repeating it in the bottom corner. */}
      <SiteFooter omit={['about', 'support']} />
    </main>
  );
}
