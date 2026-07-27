import { describe, expect, it } from 'vitest';
import {
  analyticsEventBatchSchema,
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

describe('analytics event contracts', () => {
  it('accepts stable raw page-view facts without user-supplied identity fields', () => {
    const parsed = analyticsEventBatchSchema.parse({
      events: [
        {
          event_id: '018f7ec2-38a7-7fd7-8000-000000000001',
          event_name: 'page_view',
          session_id: 'session-1',
          occurred_at: '2026-07-27T00:00:00.000Z',
          page_name: 'chat',
          page_path: '/chat',
          character_id: '018f7ec2-38a7-7fd7-8000-000000000002',
          properties: {
            from_page: 'character_detail',
            entry_method: 'navigation',
            page_view_index: 4,
            page_depth: 4,
            time_since_session_start_ms: 1200
          }
        }
      ]
    });

    expect(parsed.events[0]?.event_name).toBe('page_view');
    expect(parsed.events[0]).not.toHaveProperty('user_id');
    expect(parsed.events[0]).not.toHaveProperty('anonymous_id');
  });

  it('rejects sensitive or content-bearing analytics properties', () => {
    for (const forbidden of ['api_key', 'authorization', 'content_text', 'password']) {
      const parsed = analyticsEventBatchSchema.safeParse({
        events: [
          {
            event_id: '018f7ec2-38a7-7fd7-8000-000000000001',
            event_name: 'critical_action',
            session_id: 'session-1',
            occurred_at: '2026-07-27T00:00:00.000Z',
            page_name: 'chat',
            properties: {
              action_name: 'first_message_submit_attempted',
              [forbidden]: 'must-not-be-collected'
            }
          }
        ]
      });
      expect(parsed.success, forbidden).toBe(false);
    }
  });
});
