import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function goToCodeStep() {
  fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
    target: { value: 'user@example.com' }
  });
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

    render(<LoginSync open onClose={() => {}} onAuthenticated={() => {}} />);
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

    render(<LoginSync open onClose={() => {}} onAuthenticated={onAuthenticated} />);
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

    render(<LoginSync open onClose={() => {}} onAuthenticated={() => {}} />);
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

    render(<LoginSync open onClose={() => {}} onAuthenticated={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'user@example.com' }
    });
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

    render(<LoginSync open onClose={() => {}} onAuthenticated={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), {
      target: { value: 'user@example.com' }
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '发送验证码' }));
    });
    expect(screen.getByText('验证码已发送至 u***@example.com')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(60_000));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '重新发送验证码' }));
    });

    expect(screen.getByText('验证码邮件未能发送，请稍后重试。')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
    expect(screen.queryByText('验证码已发送至 u***@example.com')).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('______')).not.toBeInTheDocument();
  });

  it('lets the user go back and change the email', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      json({ success: true, message: 'ok' })
    );

    render(<LoginSync open onClose={() => {}} onAuthenticated={() => {}} />);
    await goToCodeStep();
    fireEvent.click(screen.getByRole('button', { name: '修改邮箱' }));

    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument();
  });
});
