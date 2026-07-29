import { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Code2,
  Globe,
  Heart,
  HeartHandshake,
  MessagesSquare,
  QrCode,
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
import { githubUrl as resolveGithubUrl } from '../lib/project-links';
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
  qrView: (attribution: SupportMethodAttribution) => void;
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

const supportUses = [
  {
    icon: Server,
    title: '服务器与基础设施',
    body: '让服务稳定在线，你随时打开都能用。'
  },
  {
    icon: Zap,
    title: '模型调用与体验优化',
    body: '更充足的模型额度，更少的等待与限制。'
  },
  {
    icon: Globe,
    title: '域名及必要服务',
    body: '域名、证书与 CDN，保证访问顺畅安全。'
  },
  {
    icon: Code2,
    title: '持续开发与维护',
    body: '新功能、问题修复与长期维护投入。'
  }
] as const;

const supportThanks = [
  {
    icon: Sparkles,
    title: '把进展交回给你',
    body: '每个版本的更新日志都会写清楚这段时间做了什么、改了什么。'
  },
  {
    icon: MessagesSquare,
    title: '优先听见你的声音',
    body: '支持者提出的问题与建议，我们会优先阅读并回复。'
  },
  {
    icon: Heart,
    title: '记住每一份心意',
    body: '愿意留名的支持者会出现在后续的致谢名单里，也可以选择匿名。'
  }
] as const;

const supportNotes = [
  {
    icon: ShieldCheck,
    title: '完全自愿',
    body: '支持与否完全由你决定，我们感谢每一份心意。'
  },
  {
    icon: Sparkles,
    title: '不影响使用',
    body: '不支持也可以完整使用开源部分的所有功能。'
  },
  {
    icon: HeartHandshake,
    title: '用于项目发展',
    body: '你的支持会用于项目的持续开发与维护。'
  }
] as const;

interface SupportPageProps {
  source?: string | null;
  placement?: string | null;
  config?: SupportConfig;
  tracker?: SupportTracker;
  isAuthenticated?: boolean;
  githubUrl?: string;
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
  isAuthenticated = readCachedStatus()?.registered ?? false,
  githubUrl = resolveGithubUrl()
}: SupportPageProps) {
  const source = normalizeSupportSource(sourceValue);
  const placement = normalizeSupportPlacement(
    placementValue ?? (source === 'github' ? 'readme' : null)
  );
  const [qrFailed, setQrFailed] = useState(false);
  const [amount, setAmount] = useState('');
  const [theme, setTheme] = useState<PublicTheme>(preferredPublicTheme);
  const [claimOpen, setClaimOpen] = useState(false);
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

  function openClaim() {
    setClaimOpen(true);
    tracker.claimOpened(commonAttribution);
  }

  function changeTheme(next: PublicTheme) {
    setTheme(next);
    storePublicTheme(next);
  }

  const showQr = Boolean(config.wechatQrUrl) && !qrFailed;

  return (
    <main className="public-page support-page" data-public-theme={theme}>
      <div className="public-glow public-glow-warm" />
      <div className="public-glow public-glow-cool" />

      <PublicHeader githubUrl={githubUrl} theme={theme} onThemeChange={changeTheme} />

      <div className="support-shell">
        <section className="support-hero">
          <div className="support-hero-copy">
            <p className="public-eyebrow">VOLUNTARY SUPPORT</p>
            <h1>
              支持 <span className="hero-mark">LiteTavern</span> 持续开发
            </h1>
            <p>LiteTavern 是一个开源、免费的 AI 客户端与 Web 工具。</p>
            <p>
              你的每一份支持，都会变成更稳定的服务、更快的更新，
              以及更多值得期待的可能性。
            </p>
            <p className="support-pledge">
              <Heart size={16} />
              支持不会消失在账单里，它会变成下一个版本里看得见的改进。
            </p>
          </div>
          <SupportOrbit />
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

        <section className="support-section" aria-labelledby="uses-title">
          <h2 className="support-section-title" id="uses-title">
            你的支持将用于
          </h2>
          <div className="support-grid support-grid-4">
            {supportUses.map(({ icon: Icon, title, body }) => (
              <article className="support-tile" key={title}>
                <span className="support-icon">
                  <Icon size={20} />
                </span>
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="support-section" aria-labelledby="methods-title">
          <h2 className="support-section-title" id="methods-title">
            支持方式
          </h2>
          <div className="support-methods">
            <section className="support-card support-card-primary" aria-labelledby="wechat-title">
              <div className="support-card-heading">
                <span className="support-icon">
                  <QrCode size={20} />
                </span>
                <div>
                  <p className="support-kicker">一次性支持</p>
                  <h3 className="support-card-title" id="wechat-title">使用微信扫码支持</h3>
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

              <button type="button" className="claim-entry" onClick={openClaim}>
                已经支持？认领 Founding Supporter 身份
              </button>
            </section>

            <section className="support-card" aria-labelledby="afdian-title">
              <div className="support-card-heading">
                <span className="support-icon">
                  <HeartHandshake size={20} />
                </span>
                <div>
                  <p className="support-kicker">持续支持</p>
                  <h3 className="support-card-title" id="afdian-title">通过爱发电支持</h3>
                </div>
              </div>
              <p className="support-card-copy">
                适合希望按月或长期支持 LiteTavern 的用户，也让我们更容易规划下一步。
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
              <h4 className="support-card-subtitle">为什么选择持续支持</h4>
              <ul className="support-uses">
                <li>
                  <Server size={15} />让服务器与额度有稳定的预期
                </li>
                <li>
                  <Zap size={15} />优先投入到体验优化上
                </li>
                <li>
                  <HeartHandshake size={15} />随时可以调整或取消
                </li>
              </ul>
            </section>
          </div>
        </section>

        <section className="support-section" aria-labelledby="thanks-title">
          <h2 className="support-section-title" id="thanks-title">
            我们怎么感谢你
          </h2>
          <div className="support-grid support-grid-3">
            {supportThanks.map(({ icon: Icon, title, body }) => (
              <article className="support-tile" key={title}>
                <span className="support-icon">
                  <Icon size={20} />
                </span>
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="support-section" aria-labelledby="notes-title">
          <h2 className="support-section-title" id="notes-title">
            支持说明
          </h2>
          <div className="support-notes">
            <ul>
              {supportNotes.map(({ icon: Icon, title, body }) => (
                <li key={title}>
                  <span className="support-note-icon">
                    <Icon size={17} />
                  </span>
                  <div>
                    <strong>{title}</strong>
                    <span>{body}</span>
                  </div>
                </li>
              ))}
            </ul>
            <p className="support-fineprint">
              一次性支持不等于购买 Pro 套餐，也不承诺投资、分红或任何收益。
              支持者身份与未来可能存在的套餐身份相互独立；Founding Supporter
              等身份本次不会自动授予，后续将另行设计。
            </p>
          </div>
        </section>
      </div>

      <SiteFooter />

      <SupporterClaimDialog
        open={claimOpen}
        onClose={() => setClaimOpen(false)}
        onSubmitted={() => tracker.claimSubmitted(commonAttribution)}
      />
    </main>
  );
}
