import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Check,
  HeartHandshake,
  MessageCircle,
  QrCode,
  Server,
  Sparkles
} from 'lucide-react';
import { SiteFooter } from '../components/SiteFooter';
import { analytics } from '../lib/analytics';
import { readCachedStatus } from '../lib/cloud';
import {
  normalizeSupportPlacement,
  normalizeSupportSource,
  supportConfig,
  type SupportConfig,
  type SupportMethod,
  type SupportPlacement,
  type SupportSource
} from '../lib/support-config';
import { siteHref } from '../public-routing';

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
  qrView: (attribution: SupportMethodAttribution) => void;
}

let publicAnalyticsInitialization: Promise<void> | null = null;

function initializePublicAnalytics(): Promise<void> {
  publicAnalyticsInitialization ??= analytics.initialize({
    userId: '',
    anonymousId: '',
    url: window.location.href,
    referrer: document.referrer,
    appVersion: '0.1.0'
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
  qrView(attribution) {
    void initializePublicAnalytics().then(() =>
      analytics.supportEvent('support_qr_view', {
        ...attribution,
        isAuthenticated: attribution.is_authenticated
      })
    );
  }
};

const sourceContent: Record<
  SupportSource,
  { title: string; body: string; method?: 'bilibili' | 'douyin'; button?: string }
> = {
  bilibili: {
    title: '在 B 站看到 LiteTavern？',
    body: '你也可以直接在 B 站为创作者充电，这通常是最方便的支持方式。',
    method: 'bilibili',
    button: '前往 B 站支持'
  },
  douyin: {
    title: '在抖音看到 LiteTavern？',
    body: '直播或内容平台内的礼物与支持通常更加方便。',
    method: 'douyin',
    button: '前往抖音支持'
  },
  github: {
    title: '感谢你关注 LiteTavern 的开源开发。',
    body: 'GitHub Sponsors 等开发者赞助入口将在后续根据实际需要增加。'
  },
  website: {
    title: '感谢你愿意了解 LiteTavern。',
    body: '你可以选择最适合自己的方式；不支持也不会影响任何功能。'
  },
  other: {
    title: '感谢你愿意了解 LiteTavern。',
    body: '你可以选择最适合自己的方式；不支持也不会影响任何功能。'
  }
};

interface SupportPageProps {
  source?: string | null;
  placement?: string | null;
  config?: SupportConfig;
  tracker?: SupportTracker;
  isAuthenticated?: boolean;
}

function platformUrl(config: SupportConfig, method?: 'bilibili' | 'douyin') {
  if (method === 'bilibili') return config.bilibiliUrl;
  if (method === 'douyin') return config.douyinUrl;
  return null;
}

export function SupportPage({
  source: sourceValue,
  placement: placementValue,
  config = supportConfig(),
  tracker = defaultTracker,
  isAuthenticated = readCachedStatus()?.registered ?? false
}: SupportPageProps) {
  const source = normalizeSupportSource(sourceValue);
  const placement = normalizeSupportPlacement(
    placementValue ?? (source === 'github' ? 'readme' : null)
  );
  const [qrFailed, setQrFailed] = useState(false);
  const [amount, setAmount] = useState('');
  const pageTracked = useRef(false);
  const qrTracked = useRef(false);
  const content = sourceContent[source];
  const configuredPlatformUrl = platformUrl(config, content.method);
  const commonAttribution = {
    source,
    placement,
    is_authenticated: isAuthenticated
  } satisfies SupportAttribution;

  useEffect(() => {
    if (pageTracked.current) return;
    pageTracked.current = true;
    tracker.pageView(commonAttribution);
  }, [isAuthenticated, placement, source, tracker]);

  useEffect(() => {
    const previousTitle = document.title;
    document.title = '支持 LiteTavern 持续开发';
    return () => {
      document.title = previousTitle;
    };
  }, []);

  useEffect(() => {
    setQrFailed(false);
    qrTracked.current = false;
  }, [config.wechatQrUrl]);

  function trackMethod(method: SupportMethod) {
    tracker.methodClick({ ...commonAttribution, method });
  }

  function trackQrView() {
    if (qrTracked.current) return;
    qrTracked.current = true;
    tracker.qrView({ ...commonAttribution, method: 'wechat' });
  }

  const showQr = Boolean(config.wechatQrUrl) && !qrFailed;

  return (
    <main className="public-page support-page">
      <div className="public-glow public-glow-warm" />
      <div className="public-glow public-glow-cool" />
      <header className="public-header">
        <a className="public-brand" href={siteHref('/')}>
          <MessageCircle size={22} />
          <span>LiteTavern</span>
        </a>
        <a className="public-header-link" href={siteHref('/')}>
          <ArrowLeft size={15} /> 返回 LiteTavern
        </a>
      </header>

      <div className="support-shell">
        <section className="support-hero">
          <p className="public-eyebrow">VOLUNTARY SUPPORT</p>
          <h1>支持 LiteTavern 持续开发</h1>
          <p>
            LiteTavern 的开源部分可以免费使用。
          </p>
          <p>
            自愿支持将用于服务器、模型调用、域名及项目开发成本。支持完全自愿，
            不影响任何已有功能，也不代表购买套餐、投资或获得收益承诺。
          </p>
        </section>

        <section className="source-notice" aria-labelledby="source-title">
          <Sparkles size={18} />
          <div>
            <h2 id="source-title">{content.title}</h2>
            <p>{content.body}</p>
          </div>
          {content.method && configuredPlatformUrl && (
            <a
              className="support-button support-button-secondary"
              href={configuredPlatformUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => trackMethod(content.method!)}
            >
              {content.button} <ArrowUpRight size={16} />
            </a>
          )}
        </section>

        <div className="support-methods">
          <section className="support-card support-card-primary" aria-labelledby="wechat-title">
            <div className="support-card-heading">
              <span className="support-icon"><QrCode size={20} /></span>
              <div>
                <p className="support-kicker">一次性支持</p>
                <h2 id="wechat-title">使用微信扫码支持</h2>
              </div>
            </div>

            {showQr ? (
              <a
                className="wechat-qr"
                href={config.wechatQrUrl!}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="在新窗口打开微信二维码"
                onClick={() => trackMethod('wechat')}
              >
                <img
                  src={config.wechatQrUrl!}
                  alt="微信收款二维码"
                  onLoad={trackQrView}
                  onError={() => setQrFailed(true)}
                />
              </a>
            ) : (
              <div className="support-unavailable" role="status">
                <QrCode size={28} />
                <strong>微信支持入口暂未开放</strong>
                <span>配置完成后将在这里显示二维码。</span>
              </div>
            )}

            <div className="amount-fieldset">
              <span>建议金额</span>
              <div className="amount-options" aria-label="建议支持金额">
                {[5, 10, 20].map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    aria-pressed={amount === String(suggestion)}
                    onClick={() => setAmount(String(suggestion))}
                  >
                    ¥{suggestion}
                  </button>
                ))}
              </div>
              <label>
                <span>自定义支持金额</span>
                <span className="custom-amount">
                  <b>¥</b>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    inputMode="numeric"
                    aria-label="自定义支持金额"
                    placeholder="其他金额"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                  />
                </span>
              </label>
              <small>金额仅供参考，请在微信支付页中确认；页面不会记录金额。</small>
            </div>

            <p className="support-voluntary">
              <Check size={15} /> 完全自愿，不影响功能使用。
            </p>
          </section>

          <section className="support-card" aria-labelledby="afdian-title">
            <div className="support-card-heading">
              <span className="support-icon"><HeartHandshake size={20} /></span>
              <div>
                <p className="support-kicker">持续支持</p>
                <h2 id="afdian-title">通过爱发电支持</h2>
              </div>
            </div>
            <p className="support-card-copy">
              适合希望按月或长期支持 LiteTavern 的用户。
            </p>
            {config.afdianUrl ? (
              <a
                className="support-button support-button-primary"
                href={config.afdianUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => trackMethod('afdian')}
              >
                通过爱发电持续支持 <ArrowUpRight size={16} />
              </a>
            ) : (
              <p className="support-inline-unavailable">爱发电支持入口暂未开放</p>
            )}
            <div className="support-divider" />
            <h3>资金用途</h3>
            <ul className="support-uses">
              <li><Server size={15} />服务器与基础设施</li>
              <li><Sparkles size={15} />模型调用与体验额度</li>
              <li><MessageCircle size={15} />域名及必要服务</li>
              <li><HeartHandshake size={15} />持续开发与维护</li>
            </ul>
          </section>
        </div>

        <section className="support-notes" aria-labelledby="notes-title">
          <h2 id="notes-title">支持说明</h2>
          <ul>
            <li>支持完全自愿，不支持也不影响正常使用。</li>
            <li>一次性支持不等于购买 Pro 套餐。</li>
            <li>不承诺投资、分红或任何收益。</li>
            <li>支持者身份与未来可能存在的套餐身份相互独立。</li>
            <li>Founding Supporter 等身份本次不会自动授予，后续将另行设计。</li>
          </ul>
        </section>
      </div>

      <SiteFooter />
    </main>
  );
}
