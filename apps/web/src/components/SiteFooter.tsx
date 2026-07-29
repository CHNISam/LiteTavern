import { siteHref } from '../public-routing';

export type SiteFooterLink = 'about' | 'support';

/**
 * `omit` lists the destinations the surrounding page already covers — either
 * because it *is* that page, or because it already makes that call to action in
 * its own content. The footer never repeats one: doing so put the same link in
 * two corners of one screen and let a reader pile identical entries onto the
 * history stack by clicking it again.
 */
export function SiteFooter({ omit = [] }: { omit?: readonly SiteFooterLink[] } = {}) {
  return (
    <footer className="site-footer">
      <span>LiteTavern 开源部分可免费使用</span>
      <nav aria-label="页脚导航">
        {!omit.includes('about') && <a href={siteHref('/about')}>关于 LiteTavern</a>}
        {!omit.includes('support') && (
          <a href={siteHref('/support?source=website&placement=footer')}>
            支持 LiteTavern
          </a>
        )}
      </nav>
    </footer>
  );
}
