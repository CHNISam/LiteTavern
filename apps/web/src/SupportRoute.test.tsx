import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
  vi.unstubAllGlobals();
});

describe('public support route', () => {
  it('renders for a signed-out visitor without bootstrapping an identity or Cloud', async () => {
    window.history.replaceState({}, '', '/support?source=douyin');
    const fetcher = vi.fn<typeof fetch>();
    fetcher.mockResolvedValue(new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetcher);

    render(<App />);

    expect(
      screen.getByRole('heading', { level: 1, name: '支持 LiteTavern 持续开发' })
    ).toBeInTheDocument();
    expect(screen.getByText('在抖音看到 LiteTavern？')).toBeInTheDocument();

    await Promise.resolve();
    await Promise.resolve();
    const requestedPaths = fetcher.mock.calls.map(([input]) => String(input));
    expect(requestedPaths).not.toContain('/v1/identities/anonymous');
    expect(requestedPaths).not.toContain('/v1/cloud/status');
  });
});
