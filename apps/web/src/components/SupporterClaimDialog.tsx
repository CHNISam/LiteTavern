import { useEffect, useRef, useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
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
        reason instanceof Error ? reason.message : '提交失败，请稍后重试。'
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
          <h2 id="claim-title">认领 Founding Supporter 身份</h2>
          <button type="button" aria-label="关闭" onClick={onClose}>
            <X size={17} />
          </button>
        </div>

        {submitted ? (
          <div className="claim-done" role="status">
            <span className="claim-done-mark">
              <Check size={22} />
            </span>
            <strong>申请已提交，核验后将授予 Founding Supporter 身份</strong>
            <p>我们会人工核对支持记录，处理完成后通过你留下的联系方式告知结果。</p>
            <button type="button" className="support-button support-button-primary" onClick={onClose}>
              好的
            </button>
          </div>
        ) : (
          <form className="claim-form" onSubmit={onSubmit} noValidate>
            <p className="claim-lead">
              支付本身不需要登录或留下任何信息。只有希望认领这份荣誉身份时，
              才需要填写下面的内容，方便我们人工核对。
            </p>

            <label className="claim-field">
              <span>昵称</span>
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
                <span>联系方式类型</span>
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
                <span>联系方式</span>
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
                <span>大致支持金额</span>
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
                <span>大致支付时间</span>
                <input
                  type="date"
                  value={form.paidAt}
                  onChange={(event) => update('paidAt', event.target.value)}
                />
              </label>
            </div>

            <label className="claim-field">
              <span>留言（可选）</span>
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
                  <Loader2 size={16} className="claim-spinner" /> 提交中…
                </>
              ) : (
                '提交认领申请'
              )}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
