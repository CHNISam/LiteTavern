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
      stage: 'ALPHA',
      account_state: 'ALPHA',
      email_verified: true,
      platform_models_available: true,
      block_reason: null,
      byok_available: true,
      alpha: {
        active_batch: 1,
        cumulative_capacity: 10,
        remaining_capacity: 3,
        batch_no: 1,
        activated_at: '2026-08-01T00:00:00.000Z',
        promotion_expires_at: null
      },
      waitlist: { on_waitlist: false, joined_at: null },
      quota: {
        period_limit: 1500,
        period_used: 41,
        period_reserved: 0,
        period_remaining: 1459,
        period_started_at: '2026-08-01T00:00:00.000Z',
        period_ends_at: '2026-08-31T00:00:00.000Z',
        daily_limit: 20,
        daily_used: 6,
        daily_reserved: 0,
        daily_remaining: 14,
        day_utc: '2026-08-06'
      },
      support: { enabled: false, url: '', headline: '', body: '' },
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
    const daily = screen.getByRole('meter', { name: '今日额度剩余量' });
    expect(daily).toHaveAttribute('aria-valuenow', '14');
    expect(daily).toHaveAttribute('aria-valuemax', '20');
    // Both windows are metered: a reader who is fine on the day but nearly out
    // for the period must be able to see that before they hit the wall.
    const period = screen.getByRole('meter', { name: '本周期额度剩余量' });
    expect(period).toHaveAttribute('aria-valuenow', '1459');
    expect(period).toHaveAttribute('aria-valuemax', '1500');
    expect(screen.getByText('UTC 2026-08-06 结束后重置')).toBeInTheDocument();
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

  it('shows remaining quota without claiming an unavailable Cloud service is in use', async () => {
    const retry = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input);
      if (path === '/v1/providers') return json({ providers: [] });
      if (path === '/v1/model-configurations') return json({ configurations: [] });
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });

    render(
      <ProviderSettings
        open
        usageMode="PLATFORM"
        onClose={() => undefined}
        onConfigurationsChanged={() => undefined}
        cloud={alphaCloud({
          platform_models_available: false,
          block_reason: 'PROVIDER_UNAVAILABLE'
        })}
        {...({ onRetryCloud: retry } as object)}
      />
    );

    // A dead upstream reads as a dead upstream, not as "you are out of quota"
    // and not as the catch-all the old build showed for every blocked state.
    expect(screen.getByText('模型服务商暂时不可用')).toBeInTheDocument();
    expect(
      screen.getByText('这是暂时的故障，稍后重试即可，本次不会消耗额度。')
    ).toBeInTheDocument();
    expect(screen.getByText('你自己的 API Key 仍然可以使用。')).toBeInTheDocument();
    expect(screen.queryByText('使用中')).not.toBeInTheDocument();
    expect(screen.queryByText('正在使用此服务')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: '连接自己的模型' })).toBeInTheDocument();
  });

  it('offers no retry for a deployment that has no model service configured', async () => {
    const retry = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input);
      if (path === '/v1/providers') return json({ providers: [] });
      if (path === '/v1/model-configurations') return json({ configurations: [] });
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });

    render(
      <ProviderSettings
        open
        usageMode="PLATFORM"
        onClose={() => undefined}
        onConfigurationsChanged={() => undefined}
        cloud={alphaCloud({
          platform_models_available: false,
          block_reason: 'PLATFORM_MODELS_NOT_CONFIGURED'
        })}
        {...({ onRetryCloud: retry } as object)}
      />
    );

    // This one never heals, so the panel says so and shows no retry button —
    // the affordance that made the original incident cost people their evening.
    expect(screen.getByText('这个环境还没有开通云端模型')).toBeInTheDocument();
    expect(
      screen.queryByText('这是暂时的故障，稍后重试即可，本次不会消耗额度。')
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '重试' })).not.toBeInTheDocument();
    expect(retry).not.toHaveBeenCalled();
    // The way out is still offered: your own key, and the feedback entry.
    expect(screen.getByRole('button', { name: '连接自己的模型' })).toBeInTheDocument();
    expect(screen.getByText(/请通过反馈入口告诉我们/)).toBeInTheDocument();
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
