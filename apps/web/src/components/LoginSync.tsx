import { useEffect, useRef, useState, type FormEvent } from 'react';
import { LoaderCircle, Mail, ShieldCheck, X } from 'lucide-react';
import { t, useT } from '../lib/i18n';
import { Turnstile } from './Turnstile';
import {
  ApiError,
  sendEmailCode,
  verifyEmailCode,
  type AnonymousIdentity,
  type AuthOutcome
} from '../lib/api';

interface LoginSyncProps {
  open: boolean;
  onClose: () => void;
  onAuthenticated: (user: AnonymousIdentity, outcome: AuthOutcome) => void;
  /** From `/v1/cloud/status`. Null means this deployment configured no widget. */
  turnstileSiteKey: string | null;
}

const RESEND_SECONDS = 60;

function friendlyError(reason: unknown): string {
  const code = reason instanceof ApiError ? reason.code : undefined;
  switch (code) {
    case 'INVALID_EMAIL':
    case 'VALIDATION_ERROR':
      return t().auth.invalidEmail;
    case 'CODE_SEND_RATE_LIMITED':
      return t().auth.rateLimited;
    case 'EMAIL_DELIVERY_FAILED':
      return t().auth.deliveryFailed;
    case 'CODE_INVALID':
      return t().auth.codeInvalid;
    case 'CODE_EXPIRED':
      return t().auth.codeExpired;
    case 'CODE_ATTEMPTS_EXCEEDED':
      return t().auth.tooManyAttempts;
    case 'AUTH_MERGE_FAILED':
      return t().auth.mergeFailed;
    case 'TURNSTILE_FAILED':
      return t().auth.challengeFailed;
    // Not the reader's failure, and not something retrying can fix. Kept apart
    // from `TURNSTILE_FAILED` so a deployment whose secret no longer matches
    // stops telling everyone they failed a challenge they actually passed.
    case 'TURNSTILE_MISCONFIGURED':
      return t().auth.challengeMisconfigured;
    case 'TURNSTILE_UNAVAILABLE':
      return t().auth.challengeUnavailableNow;
    case 'RATE_LIMITED':
      return t().auth.rateLimited;
    default:
      return reason instanceof Error ? reason.message : t().auth.generic;
  }
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain || !local) return email;
  const head = local.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

export function LoginSync({
  open,
  onClose,
  onAuthenticated,
  turnstileSiteKey
}: LoginSyncProps) {
  const t = useT();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  /**
   * Bumped to force a brand-new widget. A Turnstile token is single-use, and the
   * widget has no way to learn that the server rejected the one it minted — it
   * simply stays green. Without this, every retry after a failed send resubmitted
   * the same spent token, which the server answers `timeout-or-duplicate`: a
   * `Success!` widget that can never succeed again.
   */
  const [challengeNonce, setChallengeNonce] = useState(0);
  const timerRef = useRef<number>(0);

  useEffect(() => {
    if (!open) {
      // Reset the flow whenever the modal is dismissed so it reopens clean.
      setStep('email');
      setEmail('');
      setCode('');
      setError(null);
      setBusy(false);
      setCooldown(0);
      setChallengeToken(null);
      setChallengeNonce((current) => current + 1);
      window.clearInterval(timerRef.current);
    }
  }, [open]);

  useEffect(() => () => window.clearInterval(timerRef.current), []);

  function startCooldown() {
    setCooldown(RESEND_SECONDS);
    window.clearInterval(timerRef.current);
    timerRef.current = window.setInterval(() => {
      setCooldown((current) => {
        if (current <= 1) {
          window.clearInterval(timerRef.current);
          return 0;
        }
        return current - 1;
      });
    }, 1000);
  }

  async function requestCode(event?: FormEvent) {
    event?.preventDefault();
    if (busy || cooldown > 0) return;
    if (!challengeToken) {
      setError(t.auth.challengeRequired);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await sendEmailCode(email.trim(), challengeToken);
      // A Turnstile token is single-use: keeping it would make the resend button
      // fail with a confusing "challenge failed" instead of re-challenging.
      setChallengeToken(null);
      setStep('code');
      setCode('');
      startCooldown();
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === 'EMAIL_DELIVERY_FAILED') {
        setStep('email');
        setCode('');
        setCooldown(0);
        window.clearInterval(timerRef.current);
      }
      // The token may or may not have been spent — the server verifies it before
      // most of the ways this can fail, and a spent token is indistinguishable
      // from a live one out here. Discarding it and re-challenging is the only
      // answer that cannot strand the reader on a token the server will refuse
      // for as long as they keep pressing the button.
      setChallengeToken(null);
      setChallengeNonce((current) => current + 1);
      setError(friendlyError(reason));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    if (busy || code.trim().length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      const result = await verifyEmailCode(email.trim(), code.trim());
      onAuthenticated(result.user, result.outcome);
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="login-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t.auth.dialogLabel}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="login-header">
          <div>
            <span className="eyebrow">{t.auth.eyebrow}</span>
            <h2>{step === 'email' ? t.auth.signInOrUp : t.auth.enterCode}</h2>
          </div>
          <button className="icon-button" aria-label={t.common.close} onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        {step === 'email' ? (
          <form className="login-body" onSubmit={requestCode}>
            <p className="login-lead">
              {t.auth.lead}
            </p>
            <label className="login-field">
              <span>{t.auth.email}</span>
              <div className="login-input">
                <Mail size={18} />
                <input
                  type="email"
                  autoComplete="email"
                  inputMode="email"
                  placeholder="you@example.com"
                  value={email}
                  autoFocus
                  onChange={(input) => setEmail(input.target.value)}
                />
              </div>
            </label>
            {turnstileSiteKey ? (
              <Turnstile
                key={challengeNonce}
                siteKey={turnstileSiteKey}
                onToken={setChallengeToken}
              />
            ) : (
              <p className="login-error" role="alert">{t.auth.challengeUnavailable}</p>
            )}
            {error && <p className="login-error" role="alert">{error}</p>}
            <button
              className="gold-button login-submit"
              type="submit"
              disabled={busy || email.trim().length < 3 || !challengeToken}
            >
              {busy ? <LoaderCircle className="spin" size={18} /> : t.auth.sendCode}
            </button>
          </form>
        ) : (
          <form className="login-body" onSubmit={submitCode}>
            <p className="login-lead">
              {t.auth.codeSentTo(maskEmail(email.trim()))}
            </p>
            <label className="login-field">
              <span>{t.auth.codeLabel}</span>
              <div className="login-input">
                <ShieldCheck size={18} />
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  placeholder="______"
                  value={code}
                  autoFocus
                  onChange={(input) =>
                    setCode(input.target.value.replace(/\D/g, '').slice(0, 6))
                  }
                />
              </div>
            </label>
            {error && <p className="login-error" role="alert">{error}</p>}
            <button
              className="gold-button login-submit"
              type="submit"
              disabled={busy || code.trim().length !== 6}
            >
              {busy ? <LoaderCircle className="spin" size={18} /> : t.auth.verify}
            </button>
            {/* Resending needs its own challenge: the first token was consumed. */}
            {turnstileSiteKey && cooldown === 0 && (
              <Turnstile
                key={challengeNonce}
                siteKey={turnstileSiteKey}
                onToken={setChallengeToken}
              />
            )}
            <div className="login-secondary">
              <button
                type="button"
                className="login-link"
                onClick={() => {
                  setStep('email');
                  setError(null);
                }}
                disabled={busy}
              >
                {t.auth.changeEmail}
              </button>
              <button
                type="button"
                className="login-link"
                onClick={() => void requestCode()}
                disabled={busy || cooldown > 0 || !challengeToken}
              >
                {cooldown > 0 ? t.auth.resendIn(cooldown) : t.auth.resendCode}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
