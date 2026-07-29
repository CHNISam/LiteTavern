import { useState } from 'react';
import { CloudOff, Gift, LoaderCircle, LogOut, X } from 'lucide-react';
import {
  ALPHA_DISCLAIMER,
  activateAlpha,
  joinAlphaWaitlist,
  membershipNotice,
  quotaLabel,
  type CloudStatus
} from '../lib/cloud';
import { analytics } from '../lib/analytics';
import type { AnonymousIdentity } from '../lib/api';

interface AccountSyncPanelProps {
  open: boolean;
  status: CloudStatus | null;
  offline: boolean;
  account: AnonymousIdentity | null;
  onClose: () => void;
  onStatusChanged: (status: CloudStatus) => void;
  onLogin: () => void;
  onLogout: () => void;
  onConnectModel: () => void;
}

function percent(ratio: number): number {
  return Math.round(Math.max(0, Math.min(1, ratio)) * 100);
}

/**
 * The single account surface. Cloud is named as the provider, while account,
 * sync, plan, model quota, and Alpha remain separate facts.
 */
export function AccountSyncPanel({
  open,
  status,
  offline,
  account,
  onClose,
  onStatusChanged,
  onLogin,
  onLogout,
  onConnectModel
}: AccountSyncPanelProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  async function enterAlpha() {
    setBusy(true);
    setError(null);
    try {
      const result = await activateAlpha();
      onStatusChanged(result.cloud);
      analytics.criticalAction('alpha_activated', 'model_config', {
        result: result.activated ? 'success' : 'already'
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
  // Entitlement comes from the server's membership status, never from local state.
  const showEnterAlpha = status?.membership_status === 'ALPHA_GRANTED';
  const suspended =
    status?.membership_status === 'ALPHA_PAUSED' ||
    status?.membership_status === 'ALPHA_ENDED';
  const registered =
    account?.registered === true ||
    account?.identity_type === 'EMAIL' ||
    status?.registered === true;
  const alphaLabel = (() => {
    switch (status?.membership_status) {
      case 'REGISTERED_WAITLIST': return '候补中';
      case 'ALPHA_GRANTED': return '已获得，待启用';
      case 'ALPHA_ACTIVE': return '使用中';
      case 'ALPHA_PAUSED': return '已暂停';
      case 'ALPHA_ENDED': return '已结束';
      default: return '未申请';
    }
  })();

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="cloud-panel account-sync-panel"
        role="dialog"
        aria-modal="true"
        aria-label="账号与同步"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="cloud-header">
          <div>
            <span className="eyebrow">LiteTavern Cloud 提供</span>
            <h2>账号与同步</h2>
          </div>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        <div className="cloud-body">
          {offline && (
            <p className="cloud-offline" role="status">
              <CloudOff size={16} /> 同步异常：LiteTavern Cloud 暂时不可用。
              以下是最近一次已知状态，本地数据和自带模型不受影响。
            </p>
          )}

          <dl className="account-facts">
            <div>
              <dt>Cloud 账号</dt>
              <dd>{registered ? account?.email || '已登录' : '未登录'}</dd>
            </div>
            <div>
              <dt>同步数据</dt>
              <dd>
                <strong>角色、对话与记忆</strong>
                <small>{offline ? '同步异常' : registered ? '同步正常' : '登录后可跨设备同步'}</small>
              </dd>
            </div>
            <div>
              <dt>当前套餐</dt>
              <dd>{registered ? 'LiteTavern Free' : '未注册'}</dd>
            </div>
            <div>
              <dt>平台模型额度</dt>
              <dd>{quotaLabel(status)}</dd>
            </div>
            <div>
              <dt>Alpha 资格</dt>
              <dd>{alphaLabel}</dd>
            </div>
          </dl>

          {!registered && (
            <p className="account-registration-copy">
              注册 LiteTavern Cloud 账号后，会建立云端账号并进入 LiteTavern Free，
              可跨设备同步角色、对话与记忆。注册不会自动获得 Alpha 资格，Alpha
              需要单独申请；自带模型仍是独立的接入方式。
            </p>
          )}

          {notice && registered && (
            <p className="cloud-notice" role={suspended ? 'alert' : undefined}>{notice}</p>
          )}

          {status?.on_waitlist && status.waitlist_joined_at && (
            <small className="cloud-waitlist-meta">
              申请时间：
              {new Date(status.waitlist_joined_at).toLocaleString('zh-CN')}
            </small>
          )}

          {status?.membership_status === 'ALPHA_GRANTED' &&
            status.alpha_granted_at && (
              <small className="cloud-waitlist-meta">
                获得资格时间：
                {new Date(status.alpha_granted_at).toLocaleString('zh-CN')}
              </small>
            )}

          {quota && quota.source !== 'NONE' && (
            <div className="cloud-quota">
              <div className="cloud-quota-head">
                <span>
                  {quota.source === 'ALPHA' ? '今日平台回复' : 'LiteTavern Cloud 试用额度'}
                </span>
                <strong>
                  {quota.source === 'ALPHA'
                    ? `剩余 ${quota.available} / ${quota.total}`
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
              {quota.source === 'ALPHA' && <small>每天 08:00 恢复</small>}
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
            {!registered && (
              <button className="gold-button" onClick={onLogin}>
                注册 LiteTavern Cloud 账号
              </button>
            )}
            {showJoin && (
              <button className="gold-button" disabled={busy} onClick={() => void join()}>
                {busy ? <LoaderCircle className="spin" size={16} /> : '申请 Alpha 资格'}
              </button>
            )}
            {showEnterAlpha && (
              <button
                className="gold-button"
                disabled={busy}
                onClick={() => void enterAlpha()}
              >
                {busy ? <LoaderCircle className="spin" size={16} /> : '开始使用 Alpha 资格'}
              </button>
            )}
            {status?.alpha_active && (
              <button className="secondary-button" onClick={onConnectModel}>
                连接自己的模型继续聊天
              </button>
            )}
            {registered && (
              <button className="secondary-button" onClick={onLogout}>
                <LogOut size={16} /> 退出登录
              </button>
            )}
          </div>

          <p className="cloud-disclaimer">{ALPHA_DISCLAIMER}</p>
        </div>
      </section>
    </div>
  );
}
