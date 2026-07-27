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

    fireEvent.click(await screen.findByRole('button', { name: /OpenAI/ }));

    expect(screen.getByLabelText('API Key')).toBeRequired();
    expect(screen.queryByText('使用 ChatGPT 账号连接')).not.toBeInTheDocument();
  });
});
