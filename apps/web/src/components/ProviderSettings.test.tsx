import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderSettings } from './ProviderSettings';

function json(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('OpenAI provider settings', () => {
  function alphaCloud(overrides: Record<string, unknown> = {}) {
    return {
      platform_models_available: true,
      quota: {
        source: 'ALPHA',
        total: 20,
        used: 6,
        reserved: 0,
        available: 14,
        remaining_ratio: 0.7
      },
      ...overrides
    } as never;
  }

  /**
   * The allowance has to name the service paying for it. "官方" is not a product
   * a reader can go and look at; LiteTavern Cloud is.
   */
  it('attributes the allowance to LiteTavern Cloud and meters it against the total', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input);
      if (path === '/v1/providers') return json({ providers: [] });
      if (path === '/v1/model-configurations') return json({ configurations: [] });
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });
    render(
      <ProviderSettings
        open
        onClose={() => undefined}
        onConfigurationsChanged={() => undefined}
        cloud={alphaCloud()}
      />
    );

    expect(screen.getByRole('heading', { name: 'LiteTavern Cloud' })).toBeInTheDocument();
    expect(screen.getByText('由 LiteTavern 运营的托管模型服务')).toBeInTheDocument();
    // The bare number is now a figure out of a total, with its source and reset.
    const meter = screen.getByRole('meter', { name: 'Alpha 每日额度剩余量' });
    expect(meter).toHaveAttribute('aria-valuenow', '14');
    expect(meter).toHaveAttribute('aria-valuemax', '20');
    expect(screen.getByText('Alpha 每日额度')).toBeInTheDocument();
    expect(screen.getByText('每天 08:00 恢复')).toBeInTheDocument();
    expect(screen.getByText('6 次回复')).toBeInTheDocument();
    expect(screen.queryByText(/Neurons|TPD|TPM/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/官方/)).not.toBeInTheDocument();
  });

  it('labels a cached balance as stale rather than presenting it as live', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input);
      if (path === '/v1/providers') return json({ providers: [] });
      if (path === '/v1/model-configurations') return json({ configurations: [] });
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });
    render(
      <ProviderSettings
        open
        offline
        onClose={() => undefined}
        onConfigurationsChanged={() => undefined}
        cloud={alphaCloud()}
      />
    );

    expect(
      screen.getByText(/LiteTavern Cloud 暂时无法连接，以上是最后一次同步到的数据。/)
    ).toBeInTheDocument();
  });

  it('hides ChatGPT OAuth by default and keeps API Key configuration available', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input);
      if (path === '/v1/providers') {
        return json({
          capabilities: { openai_web_oauth_enabled: false },
          providers: [
            {
              id: 'openai',
              name: 'OpenAI',
              shortName: 'OpenAI',
              region: 'GLOBAL',
              baseUrl: 'https://api.openai.com/v1',
              allowCustomBaseUrl: false,
              apiKeyRequired: true,
              placeholderModels: ['gpt-4.1-mini'],
              helpUrl: 'https://platform.openai.com/docs'
            }
          ]
        });
      }
      if (path === '/v1/model-configurations') {
        return json({ configurations: [] });
      }
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });

    render(
      <ProviderSettings
        open
        onClose={() => undefined}
        onConfigurationsChanged={() => undefined}
      />
    );

    expect(screen.queryByText('使用 ChatGPT 账号连接')).not.toBeInTheDocument();

    // The catalogue is searchable, and a query that matches nothing says so
    // rather than leaving a blank panel.
    const search = await screen.findByRole('searchbox', { name: '搜索服务商' });
    fireEvent.change(search, { target: { value: 'anthropic' } });
    expect(screen.getByText(/没有匹配/)).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'openai.com' } });

    fireEvent.click(await screen.findByRole('button', { name: /OpenAI/ }));

    expect(screen.getByLabelText('API Key')).toBeRequired();
    expect(screen.queryByText('使用 ChatGPT 账号连接')).not.toBeInTheDocument();
  });

  it('shows an actionable error instead of an empty provider panel', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));

    render(
      <ProviderSettings
        open
        onClose={() => undefined}
        onConfigurationsChanged={() => undefined}
      />
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('无法加载服务商');
    expect(screen.getByRole('button', { name: '重新加载' })).toBeInTheDocument();
  });
});
