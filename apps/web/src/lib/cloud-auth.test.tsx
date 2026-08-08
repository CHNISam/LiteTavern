import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCloudAccount, resetCloudAccountRestoreForTests } from './cloud-auth';

const EMAIL_USER = {
  user_id: 'account-1',
  anonymous_id: 'account-1',
  identity_type: 'EMAIL' as const,
  email: 'reader@example.test',
  registered: true
};

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  }));
}

function Probe() {
  const auth = useCloudAccount();
  return (
    <div>
      <span data-testid="state">{auth.state}</span>
      <span data-testid="email">{auth.account?.email ?? 'none'}</span>
      <button type="button" onClick={() => auth.acceptAuthenticated(EMAIL_USER)}>login</button>
      <button type="button" onClick={() => void auth.restore()}>restore</button>
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetCloudAccountRestoreForTests();
});

describe('Cloud account restoration', () => {
  it('restores the same account after the page tree is mounted again with no memory state', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) => {
      expect(init?.credentials).toBe('include');
      return json({ user: EMAIL_USER });
    });

    const first = render(<Probe />);
    expect(await screen.findByText('reader@example.test')).toBeInTheDocument();
    first.unmount();

    render(<Probe />);
    expect(await screen.findByText('reader@example.test')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([path]) => String(path) === '/v1/auth/me')).toBe(true);
  });

  it('uses one in-flight /auth/me request for concurrent application instances', async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { release = resolve; });
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockReturnValue(pending);

    render(<><Probe /><Probe /></>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    release(new Response(JSON.stringify({ user: EMAIL_USER }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
    await waitFor(() => expect(screen.getAllByText('authenticated')).toHaveLength(2));
  });

  it('enters signed_out only for an explicit 401', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({
      error: { code: 'UNAUTHENTICATED', message: 'expired', retryable: false }
    }, 401));

    render(<Probe />);
    expect(await screen.findByText('signed_out')).toBeInTheDocument();
  });

  it.each([
    ['network rejection', () => Promise.reject(new TypeError('Failed to fetch'))],
    ['rate limit', () => json({ error: { code: 'RATE_LIMITED' } }, 429)],
    ['service failure', () => json({ error: { code: 'INTERNAL_ERROR' } }, 503)],
    ['malformed response', () => Promise.resolve(new Response('<html>bad</html>', { status: 200 }))]
  ])('treats %s as unavailable, never signed_out', async (_name, response) => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(response);

    render(<Probe />);
    expect(await screen.findByText('unavailable')).toBeInTheDocument();
    expect(screen.queryByText('signed_out')).not.toBeInTheDocument();
  });

  it('keeps the last authenticated account when a later restore is unavailable', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => json({ user: EMAIL_USER }))
      .mockImplementationOnce(() => Promise.reject(new TypeError('offline')));

    render(<Probe />);
    expect(await screen.findByText('reader@example.test')).toBeInTheDocument();
    screen.getByRole('button', { name: 'restore' }).click();

    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('unavailable'));
    expect(screen.getByTestId('email')).toHaveTextContent('reader@example.test');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
