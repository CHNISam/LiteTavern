import { MessageSquarePlus, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';

export function ProductFeedback({
  provider,
  model,
  traceId
}: {
  provider?: string | undefined;
  model?: string | undefined;
  traceId?: string | undefined;
}) {
  const t = useT();
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
      setError(caught instanceof Error ? caught.message : t.feedback.failed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        className="feedback-launcher"
        aria-label={t.feedback.openAria}
        onClick={() => {
          setSent(false);
          setOpen(true);
        }}
      >
        <MessageSquarePlus size={18} />
        {t.feedback.open}
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
                <span>{t.feedback.eyebrow}</span>
                <h2 id="feedback-title">{t.feedback.title}</h2>
              </div>
              <button aria-label={t.feedback.closeAria} onClick={() => setOpen(false)}>
                <X size={19} />
              </button>
            </header>
            {sent ? (
              <div className="feedback-success">
                <strong>{t.feedback.sent}</strong>
                <p>{t.feedback.sentBody}</p>
                <button onClick={() => setOpen(false)}>{t.feedback.done}</button>
              </div>
            ) : (
              <form onSubmit={(event) => void submit(event)}>
                <label>
                  {t.feedback.kind}
                  <select
                    value={type}
                    onChange={(event) => setType(event.target.value as typeof type)}
                  >
                    <option value="BUG">Bug</option>
                    <option value="UX">{t.feedback.kindUx}</option>
                    <option value="IDEA">{t.feedback.kindIdea}</option>
                    <option value="OTHER">{t.feedback.kindOther}</option>
                  </select>
                </label>
                <label>
                  {t.feedback.body}
                  <textarea
                    value={content}
                    onChange={(event) => setContent(event.target.value)}
                    minLength={3}
                    maxLength={10_000}
                    rows={6}
                    required
                    placeholder={t.feedback.bodyPlaceholder}
                  />
                </label>
                <label>
                  {t.feedback.contact} <em>{t.common.optional}</em>
                  <input
                    value={contact}
                    onChange={(event) => setContact(event.target.value)}
                    maxLength={320}
                    placeholder={t.feedback.contactPlaceholder}
                  />
                </label>
                <p className="feedback-privacy">
                  {t.feedback.attachedNote}
                </p>
                {error && <p className="feedback-error">{error}</p>}
                <div className="feedback-actions">
                  <button type="button" onClick={() => setOpen(false)}>
                    {t.common.cancel}
                  </button>
                  <button type="submit" disabled={busy || content.trim().length < 3}>
                    {busy ? t.feedback.sending : t.feedback.send}
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
