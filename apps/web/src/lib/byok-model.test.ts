import { describe, expect, it } from 'vitest';
import { byokModelSelector } from './byok-model';

describe('BYOK model selection', () => {
  it('sends the validated connection with the browser-local key', () => {
    expect(byokModelSelector({
      model_configuration_id: 'configuration-1',
      provider: 'zhipu',
      model_name: 'glm-4.7-flash',
      display_name: 'GLM Flash',
      base_url: 'https://open.bigmodel.cn/api/paas/v4',
      credential_id: 'credential-1',
      credential_configured: true
    }, 'browser-secret')).toEqual({
      usage_mode: 'BYOK',
      model_configuration_id: 'configuration-1',
      credential: {
        credential_id: 'credential-1',
        api_key: 'browser-secret'
      },
      connection: {
        provider: 'zhipu',
        base_url: 'https://open.bigmodel.cn/api/paas/v4',
        model: 'glm-4.7-flash'
      }
    });
  });
});
