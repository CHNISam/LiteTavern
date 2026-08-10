import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LoginSync } from './LoginSync';

function json(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

const registeredUser = {
  user_id: 'user-1',
  anonymous_id: 'anon-1',
  identity_type: 'EMAIL' as const,
  email: 'user@example.com',
  registered: true
};

/**
 * The real widget loads a script from Cloudflare and renders an iframe, neither
 * of which exists in jsdom. This stands in for it and solves immediately, so
 * these tests stay about the sign-in flow. That the form refuses to submit
 * without a token is asserted separately, by not installing this.
 */
function installSolvedTurnstile() {
  window.turnstile = {
    render: (_element, options) => {
      options.callback('test-turnstile-token');
      return 'widget-1';
    },
    remove: () => {},
    reset: () => {}
  };
}

/**
 * A widget that mints a *different* token every time it is rendered, which is
 * what the real one does. The shared stub above cannot see the difference
 * between a fresh challenge and a resubmitted one; this can.
 */
function installCountingTurnstile() {
  let issued = 0;
  window.turnstile = {
    render: (_element, options) => {
      issued += 1;
      options.callback(`token-${issued}`);
      return `widget-${issued}`;
    },
    remove: () => {},
    reset: () => {}
  };
}

beforeEach(() => {
  installSolvedTurnstile();
});

afterEach(() => {
  cleanup();
  delete window.turnstile;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function goToCodeStep() {
  fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
    target: { value: 'user@example.com' }
  });
  // The widget solves in a microtask after mount, and the submit button stays
  // disabled until it does — waiting for that is the point, not a workaround.
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '发送验证码' })).toBeEnabled()
  );
  fireEvent.click(screen.getByRole('button', { name: '发送验证码' }));
  await screen.findByText('验证码已发送至 u***@example.com');
}

describe('LoginSync', () => {
  it('requests a code and advances to the masked code step', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      if (String(input) === '/v1/auth/email-code/send') {
        return json({ success: true, message: '如果该邮箱可用，验证码已发送。' });
      }
      return json({ error: { message: 'unexpected' } }, 404);
    });

    render(<LoginSync open onClose={() => {}} onAuthenticated={() => {}} turnstileSiteKey="test-site-key" />);
    await goToCodeStep();

    expect(screen.getByPlaceholderText('______')).toBeInTheDocument();
    // Resend is on cooldown right after sending.
    expect(screen.getByRole('button', { name: /重新发送（\d+s）/ })).toBeDisabled();
  });

  it('verifies the code and reports the authenticated user and outcome', async () => {
    const onAuthenticated = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input);
      if (path === '/v1/auth/email-code/send') return json({ success: true, message: 'ok' });
      if (path === '/v1/auth/email-code/verify') {
        return json({ user: registeredUser, outcome: 'REGISTERED' });
      }
      return json({ error: { message: 'unexpected' } }, 404);
    });

    render(<LoginSync open onClose={() => {}} onAuthenticated={onAuthenticated} turnstileSiteKey="test-site-key" />);
    await goToCodeStep();

    fireEvent.change(screen.getByPlaceholderText('______'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: '验证 LiteTavern Cloud 账号' }));

    await waitFor(() => expect(onAuthenticated).toHaveBeenCalledWith(registeredUser, 'REGISTERED'));
  });

  it('shows a friendly message when the code is wrong', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input);
      if (path === '/v1/auth/email-code/send') return json({ success: true, message: 'ok' });
      if (path === '/v1/auth/email-code/verify') {
        return json(
          { error: { code: 'CODE_INVALID', message: '验证码不正确或已失效。' } },
          400
        );
      }
      return json({ error: { message: 'unexpected' } }, 404);
    });

    render(<LoginSync open onClose={() => {}} onAuthenticated={() => {}} turnstileSiteKey="test-site-key" />);
    await goToCodeStep();
    fireEvent.change(screen.getByPlaceholderText('______'), { target: { value: '000000' } });
    fireEvent.click(screen.getByRole('button', { name: '验证 LiteTavern Cloud 账号' }));

    expect(await screen.findByText('验证码不正确，请重新输入。')).toBeInTheDocument();
  });

  it('stays on the email step when delivery fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      json(
        {
          error: {
            code: 'EMAIL_DELIVERY_FAILED',
            message: 'provider internals must not be shown'
          }
        },
        503
      )
    );

    render(<LoginSync open onClose={() => {}} onAuthenticated={() => {}} turnstileSiteKey="test-site-key" />);
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'user@example.com' }
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '发送验证码' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: '发送验证码' }));

    expect(
      await screen.findByText('验证码邮件未能发送，请稍后重试。')
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
    expect(screen.queryByText('验证码已发送至 u***@example.com')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('______')).not.toBeInTheDocument();
  });

  it('leaves the stale code step when resend delivery fails', async () => {
    vi.useFakeTimers();
    let sends = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      sends += 1;
      if (sends === 1) return json({ success: true, message: 'ok' });
      return json(
        {
          error: {
            code: 'EMAIL_DELIVERY_FAILED',
            message: 'provider internals must not be shown'
          }
        },
        503
      );
    });

    render(<LoginSync open onClose={() => {}} onAuthenticated={() => {}} turnstileSiteKey="test-site-key" />);
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'user@example.com' }
    });
    // Let the widget solve before submitting; the button is disabled until it has.
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '发送验证码' }));
    });
    expect(screen.getByText('验证码已发送至 u***@example.com')).toBeInTheDocument();

    // Cooldown over: a fresh widget mounts for the resend and must solve too,
    // because the first token was consumed by the first send.
    act(() => vi.advanceTimersByTime(60_000));
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重新发送验证码' }));
    });

    expect(screen.getByText('验证码邮件未能发送，请稍后重试。')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
    expect(screen.queryByText('验证码已发送至 u***@example.com')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('______')).not.toBeInTheDocument();
  });

  it('will not request a code until the challenge is solved', async () => {
    // No stub installed: the widget never solves, which is what a bot sees.
    delete window.turnstile;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      json({ success: true, message: 'ok' })
    );

    render(<LoginSync open onClose={() => {}} onAuthenticated={() => {}} turnstileSiteKey="test-site-key" />);
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'user@example.com' }
    });

    expect(screen.getByRole('button', { name: '发送验证码' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '发送验证码' }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('says sign-in is unavailable when the deployment configured no widget', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      json({ success: true, message: 'ok' })
    );

    render(<LoginSync open onClose={() => {}} onAuthenticated={() => {}} turnstileSiteKey={null} />);

    // The absence of a challenge is reported, never silently skipped.
    expect(
      screen.getByText('当前环境未配置人机校验，暂时无法登录。')
    ).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  /**
   * A Turnstile token is single-use, and the widget stays green whatever the
   * server thinks of it. Resubmitting the same one turns any single failure into
   * a permanent one — `timeout-or-duplicate` for as long as the reader keeps
   * pressing the button, under a `Success!` that never goes away.
   */
  it('re-challenges after a failed send instead of resubmitting the spent token', async () => {
    installCountingTurnstile();
    const submitted: string[] = [];
    let sends = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      submitted.push(JSON.parse(String(init?.body)).turnstile_token);
      sends += 1;
      if (sends === 1) {
        return json(
          { error: { code: 'TURNSTILE_FAILED', message: '人机校验未通过，请重试。' } },
          403
        );
      }
      return json({ success: true, message: 'ok' });
    });

    render(<LoginSync open onClose={() => {}} onAuthenticated={() => {}} turnstileSiteKey="test-site-key" />);
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'user@example.com' }
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '发送验证码' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: '发送验证码' }));
    expect(await screen.findByText('人机校验未通过，请重试。')).toBeInTheDocument();

    // A fresh widget must have mounted and solved; the button is disabled until
    // it has, so this is also the assertion that the token was discarded.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '发送验证码' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: '发送验证码' }));
    await screen.findByText('验证码已发送至 u***@example.com');

    expect(submitted).toEqual(['token-1', 'token-2']);
  });

  it('names a misconfigured deployment rather than blaming the reader', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      json(
        {
          error: {
            code: 'TURNSTILE_MISCONFIGURED',
            message: '本环境的人机校验未正确配置，重试无法解决，请联系支持。',
            retryable: false
          }
        },
        503
      )
    );

    render(<LoginSync open onClose={() => {}} onAuthenticated={() => {}} turnstileSiteKey="test-site-key" />);
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'user@example.com' }
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '发送验证码' })).toBeEnabled()
    );
    fireEvent.click(screen.getByRole('button', { name: '发送验证码' }));

    expect(
      await screen.findByText('本环境的人机校验配置有误，重试无法解决，请联系支持。')
    ).toBeInTheDocument();
    // The reader is never told they failed a challenge they actually passed.
    expect(screen.queryByText('人机校验未通过，请重试。')).not.toBeInTheDocument();
  });

  it('lets the user go back and change the email', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      json({ success: true, message: 'ok' })
    );

    render(<LoginSync open onClose={() => {}} onAuthenticated={() => {}} turnstileSiteKey="test-site-key" />);
    await goToCodeStep();
    fireEvent.click(screen.getByRole('button', { name: '修改邮箱' }));

    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
  });
});
