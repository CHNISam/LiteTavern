import { MessageSquarePlus, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';

export function ProductFeedback({
  provider,
  model,
  traceId
}: {
  provider?: string | undefined;
  model?: string | undefined;
  traceId?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<'BUG' | 'UX' | 'IDEA' | 'OTHER'>('BUG');
  const [content, setContent] = useState('');
  const [contact, setContact] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/v1/feedback', {
        method: 'POST',
        body: JSON.stringify({
          type,
          content,
          ...(contact.trim() ? { contact: contact.trim() } : {}),
          page_path: `${window.location.pathname}${window.location.search}`,
          app_version: '0.1.0',
          browser: navigator.userAgent.slice(0, 500),
          device:
            typeof window.matchMedia === 'function' &&
            window.matchMedia('(max-width: 700px)').matches
              ? 'mobile'
              : 'desktop',
          ...(provider ? { provider } : {}),
          ...(model ? { model } : {}),
          ...(traceId ? { trace_id: traceId } : {})
        })
      });
      setSent(true);
      setContent('');
      setContact('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '反馈发送失败，请稍后重试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        className="feedback-launcher"
        aria-label="提交反馈"
        onClick={() => {
          setSent(false);
          setOpen(true);
        }}
      >
        <MessageSquarePlus size={18} />
        反馈
      </button>
      {open && (
        <div className="feedback-backdrop" onClick={() => setOpen(false)}>
          <section
            className="feedback-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="feedback-title"
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <div>
                <span>帮助我们验证核心体验</span>
                <h2 id="feedback-title">提交反馈</h2>
              </div>
              <button aria-label="关闭反馈" onClick={() => setOpen(false)}>
                <X size={19} />
              </button>
            </header>
            {sent ? (
              <div className="feedback-success">
                <strong>已经收到，谢谢。</strong>
                <p>反馈会附带页面、版本和运行环境，但不会包含聊天正文或 API Key。</p>
                <button onClick={() => setOpen(false)}>完成</button>
              </div>
            ) : (
              <form onSubmit={(event) => void submit(event)}>
                <label>
                  类型
                  <select
                    value={type}
                    onChange={(event) => setType(event.target.value as typeof type)}
                  >
                    <option value="BUG">Bug</option>
                    <option value="UX">体验问题</option>
                    <option value="IDEA">建议</option>
                    <option value="OTHER">其他</option>
                  </select>
                </label>
                <label>
                  反馈内容
                  <textarea
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    minLength={3}
                    maxLength={10_000}
                    rows={6}
                    required
                    placeholder="发生了什么？你原本希望看到什么？"
                  />
                </label>
                <label>
                  联系方式 <em>可选</em>
                  <input
                    value={contact}
                    onChange={(event) => setContact(event.target.value)}
                    maxLength={320}
                    placeholder="邮箱或其他便于联系的方式"
                  />
                </label>
                <p className="feedback-privacy">
                  自动附带当前页面、应用版本、浏览器/设备、Provider/模型和可用 Trace。
                </p>
                {error && <p className="feedback-error">{error}</p>}
                <div className="feedback-actions">
                  <button type="button" onClick={() => setOpen(false)}>
                    取消
                  </button>
                  <button type="submit" disabled={busy || content.trim().length < 3}>
                    {busy ? '发送中…' : '发送反馈'}
                  </button>
                </div>
              </form>
            )}
          </section>
        </div>
      )}
    </>
  );
}
