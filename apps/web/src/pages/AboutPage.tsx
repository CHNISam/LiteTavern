import { useEffect } from 'react';
import { ArrowRight, MessageCircle } from 'lucide-react';
import { SiteFooter } from '../components/SiteFooter';
import { siteHref } from '../public-routing';

export function AboutPage() {
  useEffect(() => {
    const previousTitle = document.title;
    document.title = '关于 LiteTavern';
    return () => {
      document.title = previousTitle;
    };
  }, []);

  return (
    <main className="public-page">
      <div className="public-glow public-glow-warm" />
      <header className="public-header">
        <a className="public-brand" href={siteHref('/')}>
          <MessageCircle size={22} />
          <span>LiteTavern</span>
        </a>
        <a className="public-header-link" href={siteHref('/support?source=website')}>
          支持 LiteTavern
        </a>
      </header>

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

      <SiteFooter />
    </main>
  );
}
