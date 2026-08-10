import { describe, expect, it } from 'vitest';
import { byokConnectionMetadata } from './byok-model';

describe('BYOK model selection', () => {
  it('exposes only non-secret metadata to the browser adapter', () => {
    const metadata = byokConnectionMetadata({
      model_configuration_id: 'configuration-1',
      provider: 'zhipu',
      model_name: 'glm-4.7-flash',
      display_name: 'GLM Flash',
      base_url: 'https://open.bigmodel.cn/api/paas/v4',
      credential_id: 'credential-1',
      credential_configured: true
    });
    expect(metadata).toEqual({
      model_configuration_id: 'configuration-1',
      provider: 'zhipu',
      base_url: 'https://open.bigmodel.cn/api/paas/v4',
      model: 'glm-4.7-flash'
    });
    expect(JSON.stringify(metadata)).not.toContain('browser-secret');
    expect(JSON.stringify(metadata)).not.toContain('credential-1');
  });
});
