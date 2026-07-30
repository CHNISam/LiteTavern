import { useT } from '../lib/i18n';
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
  const t = useT();
  return (
    <footer className="site-footer">
      <span>{t.publicChrome.footerNote}</span>
      <nav aria-label={t.publicChrome.footerNav}>
        {!omit.includes('about') && (
          <a href={siteHref('/about')}>{t.publicChrome.aboutLink}</a>
        )}
        {!omit.includes('support') && (
          <a href={siteHref('/support?source=website&placement=footer')}>
            {t.publicChrome.supportLink}
          </a>
        )}
      </nav>
    </footer>
  );
}
