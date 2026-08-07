import { useEffect, useRef } from 'react';

/**
 * The Cloudflare Turnstile challenge.
 *
 * The site key comes from `/v1/cloud/status`, never from a build-time constant:
 * the Worker verifies against the matching secret, and two independently
 * configured halves would fail only in production, only for real users.
 *
 * The token is single-use and short-lived. `onToken(null)` on expiry is what
 * stops the form from submitting a token the server will reject.
 */

declare global {
  interface Window {
    turnstile?: {
      render(
        element: HTMLElement,
        options: {
          sitekey: string;
          callback: (token: string) => void;
          'expired-callback'?: () => void;
          'error-callback'?: () => void;
          theme?: 'auto' | 'light' | 'dark';
          appearance?: 'always' | 'execute' | 'interaction-only';
        }
      ): string;
      remove(widgetId: string): void;
      reset(widgetId: string): void;
    };
  }
}

const SCRIPT_ID = 'cf-turnstile-script';
const SCRIPT_SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** Loads the Turnstile script once per document, shared by every widget. */
function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();

  const existing = document.getElementById(SCRIPT_ID);
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('turnstile script failed')));
    });
  }

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.id = SCRIPT_ID;
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', () => resolve());
    script.addEventListener('error', () => reject(new Error('turnstile script failed')));
    document.head.appendChild(script);
  });
}

interface TurnstileProps {
  siteKey: string;
  onToken: (token: string | null) => void;
}

export function Turnstile({ siteKey, onToken }: TurnstileProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Kept in a ref so re-renders caused by the token itself cannot re-run the
  // effect and mount a second widget.
  const callbackRef = useRef(onToken);
  callbackRef.current = onToken;

  useEffect(() => {
    let widgetId: string | null = null;
    let cancelled = false;

    void loadScript()
      .then(() => {
        if (cancelled || !hostRef.current || !window.turnstile) return;
        widgetId = window.turnstile.render(hostRef.current, {
          sitekey: siteKey,
          theme: 'auto',
          callback: (token) => callbackRef.current(token),
          // An expired or failed challenge must clear the token rather than
          // leave a stale one that the server will reject with a confusing error.
          'expired-callback': () => callbackRef.current(null),
          'error-callback': () => callbackRef.current(null)
        });
      })
      .catch(() => {
        if (!cancelled) callbackRef.current(null);
      });

    return () => {
      cancelled = true;
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
    };
  }, [siteKey]);

  return <div className="turnstile-host" ref={hostRef} />;
}
