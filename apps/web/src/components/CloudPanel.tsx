import { useState } from 'react';
import { CloudOff, Gift, LoaderCircle, LogOut, X } from 'lucide-react';
import {
  activateAlpha,
  alphaDisclaimer,
  joinAlphaWaitlist,
  membershipNotice,
  quotaLabel,
  type CloudStatus
} from '../lib/cloud';
import { analytics } from '../lib/analytics';
import { useLocale } from '../lib/i18n';
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
  const { locale, dictionary: t } = useLocale();
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
      setError(reason instanceof Error ? reason.message : t.account.actionFailed);
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
      setError(reason instanceof Error ? reason.message : t.account.actionFailed);
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
      case 'REGISTERED_WAITLIST': return t.account.alphaStates.waitlisted;
      case 'ALPHA_GRANTED': return t.account.alphaStates.granted;
      case 'ALPHA_ACTIVE': return t.account.alphaStates.active;
      case 'ALPHA_PAUSED': return t.account.alphaStates.paused;
      case 'ALPHA_ENDED': return t.account.alphaStates.ended;
      default: return t.account.alphaStates.none;
    }
  })();

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="cloud-panel account-sync-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t.account.dialogLabel}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="cloud-header">
          <div>
            <span className="eyebrow">{t.account.eyebrow}</span>
            <h2>{t.account.title}</h2>
          </div>
          <button className="icon-button" aria-label={t.common.close} onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        <div className="cloud-body">
          {offline && (
            <p className="cloud-offline" role="status">
              <CloudOff size={16} /> {t.account.offline}
            </p>
          )}

          <dl className="account-facts">
            <div>
              <dt>{t.account.cloudAccount}</dt>
              <dd>{registered ? account?.email || t.account.signedIn : t.account.signedOut}</dd>
            </div>
            <div>
              <dt>{t.account.syncedData}</dt>
              <dd>
                <strong>{t.account.syncedScope}</strong>
                <small>{offline ? t.account.syncBroken : registered ? t.account.syncOk : t.account.syncAfterLogin}</small>
              </dd>
            </div>
            <div>
              <dt>{t.account.plan}</dt>
              <dd>{registered ? t.account.planFree : t.account.notRegistered}</dd>
            </div>
            <div>
              <dt>{t.account.platformQuota}</dt>
              <dd>{quotaLabel(status)}</dd>
            </div>
            <div>
              <dt>{t.account.alphaStatus}</dt>
              <dd>{alphaLabel}</dd>
            </div>
          </dl>

          {!registered && (
            <p className="account-registration-copy">
              {t.account.registrationCopy}
            </p>
          )}

          {notice && registered && (
            <p className="cloud-notice" role={suspended ? 'alert' : undefined}>{notice}</p>
          )}

          {status?.on_waitlist && status.waitlist_joined_at && (
            <small className="cloud-waitlist-meta">
              {t.account.appliedAt}
              {new Date(status.waitlist_joined_at).toLocaleString(locale)}
            </small>
          )}

          {status?.membership_status === 'ALPHA_GRANTED' &&
            status.alpha_granted_at && (
              <small className="cloud-waitlist-meta">
                {t.account.grantedAt}
                {new Date(status.alpha_granted_at).toLocaleString(locale)}
              </small>
            )}

          {quota && quota.source !== 'NONE' && (
            <div className="cloud-quota">
              <div className="cloud-quota-head">
                <span>
                  {quota.source === 'ALPHA' ? t.account.quotaTodayLabel : t.account.quotaTrialLabel}
                </span>
                <strong>
                  {quota.source === 'ALPHA'
                    ? t.account.quotaRemainingOf(quota.available, quota.total)
                    : t.account.quotaRemainingCount(quota.available)}
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
              {quota.source === 'ALPHA' && <small>{t.account.dailyReset}</small>}
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
                {t.account.register}
              </button>
            )}
            {showJoin && (
              <button className="gold-button" disabled={busy} onClick={() => void join()}>
                {busy ? <LoaderCircle className="spin" size={16} /> : t.account.applyAlpha}
              </button>
            )}
            {showEnterAlpha && (
              <button
                className="gold-button"
                disabled={busy}
                onClick={() => void enterAlpha()}
              >
                {busy ? <LoaderCircle className="spin" size={16} /> : t.account.enterAlpha}
              </button>
            )}
            {status?.alpha_active && (
              <button className="secondary-button" onClick={onConnectModel}>
                {t.account.connectOwnModel}
              </button>
            )}
            {registered && (
              <button className="secondary-button" onClick={onLogout}>
                <LogOut size={16} /> {t.account.signOut}
              </button>
            )}
          </div>

          <p className="cloud-disclaimer">{alphaDisclaimer()}</p>
        </div>
      </section>
    </div>
  );
}
