import { CloudOff, LogOut, X } from 'lucide-react';
import {
  alphaDisclaimer,
  describeQuotaWindows,
  isSignedIn,
  quotaLabel,
  resolveCloudNotice,
  type CloudStatus
} from '../lib/cloud';
import { useLocale } from '../lib/i18n';
import type { AnonymousIdentity } from '../lib/api';

interface AccountSyncPanelProps {
  open: boolean;
  status: CloudStatus | null;
  offline: boolean;
  account: AnonymousIdentity | null;
  onClose: () => void;
  onLogin: () => void;
  onLogout: () => void;
  onConnectModel: () => void;
}

function percent(ratio: number): number {
  return Math.round(Math.max(0, Math.min(1, ratio)) * 100);
}

function formatDay(value: string, locale: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleDateString(locale);
}

function formatMoment(value: string, locale: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString(locale);
}

/**
 * The single account surface. Cloud is named as the provider, while account,
 * sync, allowance and Alpha state remain separate facts.
 *
 * Nothing here decides entitlement: the account state, the batch capacity, the
 * allowance and the reason the platform is blocked all come from the server, and
 * the panel only chooses how to lay them out.
 */
export function AccountSyncPanel({
  open,
  status,
  offline,
  account,
  onClose,
  onLogin,
  onLogout,
  onConnectModel
}: AccountSyncPanelProps) {
  const { locale, dictionary: t } = useLocale();

  if (!open) return null;

  const notice = resolveCloudNotice(status);
  const quota = describeQuotaWindows(status);
  const registered =
    isSignedIn(status) ||
    account?.registered === true ||
    account?.identity_type === 'EMAIL';
  const accountState = status ? t.account.accountStates[status.account_state] : null;

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
              <dt>{t.account.platformQuota}</dt>
              <dd>{quotaLabel(status)}</dd>
            </div>
            <div>
              <dt>{t.account.alphaStatus}</dt>
              <dd>
                {accountState ?? t.account.notRegistered}
                {status && (
                  <small>
                    {t.account.alphaBatch(status.alpha.active_batch)} ·{' '}
                    {t.account.alphaCapacity(
                      status.alpha.remaining_capacity,
                      status.alpha.cumulative_capacity
                    )}
                  </small>
                )}
              </dd>
            </div>
          </dl>

          {!registered && (
            <p className="account-registration-copy">
              {t.account.registrationCopy}
            </p>
          )}

          {notice && (
            <div
              className={`cloud-notice cloud-notice-${notice.tone}`}
              role={notice.tone === 'error' ? 'alert' : 'status'}
            >
              <strong>{notice.title}</strong>
              {notice.body.split('\n').map((line, index) =>
                line ? <p key={index}>{line}</p> : <br key={index} />
              )}
              {notice.byokHint && <p className="cloud-notice-byok">{notice.byokHint}</p>}
            </div>
          )}

          {status?.waitlist.on_waitlist && status.waitlist.joined_at && (
            <small className="cloud-waitlist-meta">
              {t.account.appliedAt}
              {formatMoment(status.waitlist.joined_at, locale)}
            </small>
          )}

          {status?.alpha.activated_at && (
            <small className="cloud-waitlist-meta">
              {t.account.activatedAt}
              {formatMoment(status.alpha.activated_at, locale)}
            </small>
          )}

          {quota && (
            <div className="cloud-quota">
              <div className="cloud-quota-head">
                <span>{t.account.quotaTodayLabel}</span>
                <strong>
                  {t.account.quotaRemainingOf(quota.dailyRemaining, quota.dailyLimit)}
                </strong>
              </div>
              <div
                className="cloud-quota-bar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent(quota.dailyRatio)}
              >
                <i style={{ width: `${percent(quota.dailyRatio)}%` }} />
              </div>
              <small>{t.account.dailyResetAt(formatDay(quota.dayUtc, locale))}</small>

              <div className="cloud-quota-head">
                <span>{t.account.quotaPeriodLabel}</span>
                <strong>
                  {t.account.quotaRemainingOf(quota.periodRemaining, quota.periodLimit)}
                </strong>
              </div>
              <div
                className="cloud-quota-bar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent(quota.periodRatio)}
              >
                <i style={{ width: `${percent(quota.periodRatio)}%` }} />
              </div>
              <small>
                {t.account.periodResetAt(formatMoment(quota.periodEndsAt, locale))}
              </small>
            </div>
          )}

          <div className="cloud-actions">
            {!registered && (
              <button className="gold-button" onClick={onLogin}>
                {t.account.register}
              </button>
            )}
            {status?.byok_available && (
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
