import { useEffect, useRef, useState, type FormEvent } from 'react';
import { LoaderCircle, Mail, ShieldCheck, X } from 'lucide-react';
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
}

const RESEND_SECONDS = 60;

function friendlyError(reason: unknown): string {
  const code = reason instanceof ApiError ? reason.code : undefined;
  switch (code) {
    case 'INVALID_EMAIL':
    case 'VALIDATION_ERROR':
      return '请输入有效的邮箱地址。';
    case 'CODE_SEND_RATE_LIMITED':
      return '发送过于频繁，请稍后再试。';
    case 'CODE_INVALID':
      return '验证码不正确，请重新输入。';
    case 'CODE_EXPIRED':
      return '验证码已过期，请重新获取。';
    case 'CODE_ATTEMPTS_EXCEEDED':
      return '尝试次数过多，请重新获取验证码。';
    case 'AUTH_MERGE_FAILED':
      return '同步账号时出错，请稍后再试。';
    default:
      return reason instanceof Error ? reason.message : '操作失败，请稍后重试。';
  }
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain || !local) return email;
  const head = local.slice(0, 1);
  return `${head}${'*'.repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

export function LoginSync({ open, onClose, onAuthenticated }: LoginSyncProps) {
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);
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
    setBusy(true);
    setError(null);
    try {
      await sendEmailCode(email.trim());
      setStep('code');
      setCode('');
      startCooldown();
    } catch (reason) {
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
        aria-label="登录并同步"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="login-header">
          <div>
            <span className="eyebrow">登录并同步</span>
            <h2>{step === 'email' ? '绑定邮箱，随时找回' : '输入验证码'}</h2>
          </div>
          <button className="icon-button" aria-label="关闭" onClick={onClose}>
            <X size={20} />
          </button>
        </header>

        {step === 'email' ? (
          <form className="login-body" onSubmit={requestCode}>
            <p className="login-lead">
              绑定邮箱后，可以在其他设备继续使用，并在浏览器数据丢失时恢复角色、对话和记忆。
            </p>
            <label className="login-field">
              <span>邮箱</span>
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
            {error && <p className="login-error" role="alert">{error}</p>}
            <button
              className="gold-button login-submit"
              type="submit"
              disabled={busy || email.trim().length < 3}
            >
              {busy ? <LoaderCircle className="spin" size={18} /> : '发送验证码'}
            </button>
          </form>
        ) : (
          <form className="login-body" onSubmit={submitCode}>
            <p className="login-lead">
              验证码已发送至 {maskEmail(email.trim())}
            </p>
            <label className="login-field">
              <span>6 位验证码</span>
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
              {busy ? <LoaderCircle className="spin" size={18} /> : '验证并同步'}
            </button>
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
                修改邮箱
              </button>
              <button
                type="button"
                className="login-link"
                onClick={() => void requestCode()}
                disabled={busy || cooldown > 0}
              >
                {cooldown > 0 ? `重新发送（${cooldown}s）` : '重新发送验证码'}
              </button>
            </div>
          </form>
        )}
      </section>
    </div>
  );
}
