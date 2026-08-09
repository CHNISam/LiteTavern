import type { ModelConfiguration } from './api';

/**
 * Cloud deliberately keeps no catalogue for a reader's personal connection.
 * The secret and its validated endpoint therefore travel together for this one
 * request; neither is persisted by Cloud.
 */
export function byokModelSelector(configuration: ModelConfiguration, apiKey: string) {
  return {
    usage_mode: 'BYOK' as const,
    model_configuration_id: configuration.model_configuration_id,
    credential: {
      credential_id: configuration.credential_id,
      api_key: apiKey
    },
    connection: {
      provider: configuration.provider,
      base_url: configuration.base_url,
      model: configuration.model_name
    }
  };
}
