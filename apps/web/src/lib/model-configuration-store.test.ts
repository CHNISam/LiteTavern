import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelConfigurationStore } from './model-configuration-store';

const store = new ModelConfigurationStore('model-configurations-test');

afterEach(async () => { await store.reset(); });

describe('ModelConfigurationStore', () => {
  it('stores model metadata locally', async () => {
    const saved = await store.save({
      provider: 'openai', model_name: 'gpt-4.1-mini', display_name: 'OpenAI',
      base_url: 'https://api.openai.com/v1', credential_id: 'credential-1'
    });
    await expect(store.list()).resolves.toEqual([saved]);
  });

  it('imports the retired Cloud metadata exactly once', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      configurations: [{
        model_configuration_id: 'legacy-1', provider: 'openai',
        model_name: 'gpt-4.1-mini', display_name: 'Legacy',
        base_url: 'https://api.openai.com/v1', credential_id: 'credential-1',
        credential_configured: true
      }]
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await store.migrateLegacyOnce(fetcher);
    await store.migrateLegacyOnce(fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(store.list()).resolves.toHaveLength(1);
  });
});
