import { describe, expect, it } from 'vitest';
import {
  generationRequestSchema,
  providerConnectionValidationSchema
} from './schemas.js';

describe('credential mode contracts', () => {
  it('requires a transient browser credential for BYOK generations', () => {
    const parsed = generationRequestSchema.safeParse({
      usage_mode: 'BYOK',
      model_configuration_id: '018f7ec2-38a7-7fd7-8000-000000000001',
      input: { type: 'text', text: 'hello' }
    });

    expect(parsed.success).toBe(false);
  });

  it('does not accept a browser credential in platform mode', () => {
    const parsed = generationRequestSchema.safeParse({
      usage_mode: 'PLATFORM',
      input: { type: 'text', text: 'hello' },
      credential: {
        credential_id: 'local-key',
        api_key: 'secret'
      }
    });

    expect(parsed.success).toBe(false);
  });

  it('accepts a transient key for connection validation without persistence fields', () => {
    const parsed = providerConnectionValidationSchema.parse({
      provider: 'deepseek',
      base_url: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      credential: {
        credential_id: 'credential-local-1',
        api_key: 'sk-local-only'
      }
    });

    expect(parsed.credential.api_key).toBe('sk-local-only');
    expect(parsed).not.toHaveProperty('user_id');
  });
});
