import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { useT } from '../lib/i18n';
import {
  SUPPORTER_CONSENT_TEXT,
  SUPPORTER_CONTACT_LABELS,
  SUPPORTER_CONTACT_TYPES,
  submitSupporterClaim,
  validateSupporterClaim,
  type SupporterClaimInput,
  type SupporterContactType
} from '../lib/supporter-claim';

const EMPTY: SupporterClaimInput = {
  nickname: '',
  contactType: 'WECHAT',
  contactValue: '',
  amount: '',
  paidAt: '',
  message: '',
  consent: false
};

interface SupporterClaimDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmitted?: () => void;
  submit?: typeof submitSupporterClaim;
}

export function SupporterClaimDialog({
  open,
  onClose,
  onSubmitted,
  submit = submitSupporterClaim
}: SupporterClaimDialogProps) {
  const t = useT();
  const [form, setForm] = useState<SupporterClaimInput>(EMPTY);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setForm(EMPTY);
    setFailure(null);
    setSubmitted(false);
    setPending(false);
    firstFieldRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  function update<K extends keyof SupporterClaimInput>(
    key: K,
    value: SupporterClaimInput[K]
  ) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    // A second submit while one is in flight would create a duplicate claim the
    // reviewer then has to untangle, so the guard is here as well as on the button.
    if (pending || submitted) return;

    const invalid = validateSupporterClaim(form);
    if (invalid) {
      setFailure(invalid);
      return;
    }

    setPending(true);
    setFailure(null);
    try {
      await submit(form);
      setSubmitted(true);
      onSubmitted?.();
    } catch (reason) {
      setFailure(
        reason instanceof Error ? reason.message : t.claim.submitFailed
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="claim-overlay" role="presentation" onClick={onClose}>
      <div
        className="claim-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="claim-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="claim-dialog-head">
          <h2 id="claim-title">{t.claim.title}</h2>
          <button type="button" aria-label={t.common.close} onClick={onClose}>
            <X size={17} />
          </button>
        </div>

        {submitted ? (
          <div className="claim-done" role="status">
            <span className="claim-done-mark">
              <Check size={22} />
            </span>
            <strong>{t.claim.submitted}</strong>
            <p>{t.claim.submittedBody}</p>
            <button type="button" className="support-button support-button-primary" onClick={onClose}>
              {t.common.ok}
            </button>
          </div>
        ) : (
          <form className="claim-form" onSubmit={onSubmit} noValidate>
            <p className="claim-lead">
              {t.claim.lead}
            </p>

            <label className="claim-field">
              <span>{t.claim.nickname}</span>
              <input
                ref={firstFieldRef}
                type="text"
                maxLength={40}
                value={form.nickname}
                onChange={(event) => update('nickname', event.target.value)}
              />
            </label>

            <div className="claim-field-row">
              <label className="claim-field">
                <span>{t.claim.contactType}</span>
                <select
                  value={form.contactType}
                  onChange={(event) =>
                    update('contactType', event.target.value as SupporterContactType)
                  }
                >
                  {SUPPORTER_CONTACT_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {SUPPORTER_CONTACT_LABELS[type]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="claim-field">
                <span>{t.claim.contact}</span>
                <input
                  type="text"
                  maxLength={120}
                  value={form.contactValue}
                  onChange={(event) => update('contactValue', event.target.value)}
                />
              </label>
            </div>

            <div className="claim-field-row">
              <label className="claim-field">
                <span>{t.claim.amount}</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  inputMode="decimal"
                  value={form.amount}
                  onChange={(event) => update('amount', event.target.value)}
                />
              </label>
              <label className="claim-field">
                <span>{t.claim.paidAt}</span>
                <input
                  type="date"
                  value={form.paidAt}
                  onChange={(event) => update('paidAt', event.target.value)}
                />
              </label>
            </div>

            <label className="claim-field">
              <span>{t.claim.note}</span>
              <textarea
                rows={3}
                maxLength={500}
                value={form.message}
                onChange={(event) => update('message', event.target.value)}
              />
            </label>

            <label className="claim-consent">
              <input
                type="checkbox"
                checked={form.consent}
                onChange={(event) => update('consent', event.target.checked)}
              />
              <span>{SUPPORTER_CONSENT_TEXT}</span>
            </label>

            {failure && (
              <p className="claim-error" role="alert">
                {failure}
              </p>
            )}

            <button
              type="submit"
              className="support-button support-button-primary claim-submit"
              disabled={pending}
            >
              {pending ? (
                <>
                  <Loader2 size={16} className="claim-spinner" /> {t.common.submitting}
                </>
              ) : (
                t.claim.submit
              )}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
