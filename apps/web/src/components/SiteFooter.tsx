import { siteHref } from '../public-routing';

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <span>LiteTavern 开源部分可免费使用</span>
      <nav aria-label="页脚导航">
        <a href={siteHref('/about')}>关于 LiteTavern</a>
        <a href={siteHref('/support?source=website&placement=footer')}>
          支持 LiteTavern
        </a>
      </nav>
    </footer>
  );
}
