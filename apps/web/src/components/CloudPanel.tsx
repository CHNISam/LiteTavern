import { useEffect, useState } from 'react';
import { CloudOff, Gift, HeartHandshake, KeyRound, LoaderCircle, X } from 'lucide-react';
import {
  ALPHA_DISCLAIMER,
  EXPORT_PATH,
  fetchSupportInfo,
  joinAlphaWaitlist,
  membershipNotice,
  type CloudStatus,
  type SupportInfo
} from '../lib/cloud';
import { analytics } from '../lib/analytics';
import { cloudUrl } from '../lib/runtime-config';

interface CloudPanelProps {
  open: boolean;
  status: CloudStatus | null;
  offline: boolean;
  onClose: () => void;
  onStatusChanged: (status: CloudStatus) => void;
  onLogin: () => void;
  onProvider: () => void;
}

function percent(ratio: number): number {
  return Math.round(Math.max(0, Math.min(1, ratio)) * 100);
}

/**
 * The one place that tells the user the truth about their LiteTavern Cloud state:
 * which pool is paying, how much is left, where they stand in the Alpha program, and
 * what they can actually do next. It never shows a price, never names a plan that
 * does not exist, and never presents the waitlist as if it were an entitlement.
 */
export function CloudPanel({
  open,
  status,
  offline,
  onClose,
  onStatusChanged,
  onLogin,
  onProvider
}: CloudPanelProps) {
  const [support, setSupport] = useState<SupportInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || offline) return;
    let cancelled = false;
    void fetchSupportInfo()
      .then((info) => {
        if (cancelled) return;
        setSupport(info);
        if (info.enabled) {
          analytics.criticalAction('support_entry_viewed', 'model_config', {
            result: 'success'
          });
        }
      })
      .catch(() => setSupport(null));
    return () => {
      cancelled = true;
    };
  }, [open, offline]);

  if (!open) return null;

  async function join() {
    setBusy(true);
    setError(null);
    try {
      const result = await joinAlphaWaitlist('app');
      onStatusChanged(result.cloud);
      analytics.criticalAction('alpha_waitlist_joined', 'model_config', {
        result: result.joined ? 'success' : 'already'
      });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败，请稍后重试。');
    } finally {
      setBusy(false);
    }
  }

  const notice = membershipNotice(status);
  const quota = status?.quota;
  const showJoin =
    status?.registered === true &&
    status.membership_status === 'REGISTERED_WAITLIST' &&
    !status.waitlist_joined_at;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="cloud-panel"
        role="dialog"
        aria-modal="true"
        aria-label="LiteTavern Cloud"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="cloud-header">
          <div>
            <span className="eyebrow">LiteTavern Cloud</span>
            <h2>{status ? `Cloud ${status.stage}` : 'LiteTavern Cloud'}</h2>
          </div>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        <div className="cloud-body">
          {offline && (
            <p className="cloud-offline" role="status">
              <CloudOff size={16} /> LiteTavern Cloud 暂时不可用，以下是最近一次已知状态。
              本地角色、已缓存的对话和自带模型不受影响，你的数据没有丢失。
            </p>
          )}

          {notice && <p className="cloud-notice">{notice}</p>}

          {quota && quota.source !== 'NONE' && (
            <div className="cloud-quota">
              <div className="cloud-quota-head">
                <span>
                  {quota.source === 'ALPHA' ? '本期额度' : 'LiteTavern Cloud 试用额度'}
                </span>
                <strong>
                  {quota.source === 'ALPHA'
                    ? `剩余 ${percent(quota.remaining_ratio)}%`
                    : `剩余 ${quota.available} 次`}
                </strong>
              </div>
              <div
                className="cloud-quota-bar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent(quota.remaining_ratio)}
              >
                <i style={{ width: `${percent(quota.remaining_ratio)}%` }} />
              </div>
              {quota.cycle_ends_at && (
                <small>
                  本期结束于{' '}
                  {new Date(quota.cycle_ends_at).toLocaleDateString('zh-CN')}
                </small>
              )}
            </div>
          )}

          {status?.founding_supporter && (
            <p className="cloud-supporter">
              <Gift size={16} /> Founding Supporter
            </p>
          )}

          {error && (
            <p className="login-error" role="alert">
              {error}
            </p>
          )}

          <div className="cloud-actions">
            {status && !status.registered && (
              <button className="gold-button" onClick={onLogin}>
                注册并加入 Alpha 候补名单
              </button>
            )}
            {showJoin && (
              <button className="gold-button" disabled={busy} onClick={() => void join()}>
                {busy ? <LoaderCircle className="spin" size={16} /> : '加入 Alpha 候补名单'}
              </button>
            )}
            <button className="secondary-button" onClick={onProvider}>
              <KeyRound size={16} /> 使用自己的模型服务
            </button>
            <a className="secondary-button" href={cloudUrl(EXPORT_PATH)} download>
              导出我的数据
            </a>
          </div>

          {support?.enabled && (
            <section className="cloud-support">
              <h3>
                <HeartHandshake size={16} /> {support.headline}
              </h3>
              <p>{support.body}</p>
              <a
                className="secondary-button"
                href={support.url}
                target="_blank"
                rel="noreferrer noopener"
                onClick={() =>
                  analytics.criticalAction('support_entry_clicked', 'model_config', {
                    result: 'success'
                  })
                }
              >
                支持 LiteTavern
              </a>
              <small>
                当前由人工确认贡献并标记 Founding Supporter，暂未接入自动回调。
                Founding Supporter 可在下一批 Alpha 开放时获得优先资格，但不代表立即获得资格，
                也不包含额外模型额度。
              </small>
            </section>
          )}

          <p className="cloud-disclaimer">{ALPHA_DISCLAIMER}</p>
        </div>
      </section>
    </div>
  );
}
