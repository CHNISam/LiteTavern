import type { ModelConfiguration } from './api';

/**
 * Non-secret metadata used to choose the browser-side adapter. This object is
 * deliberately insufficient for a Cloud generation request: credentials never
 * leave the browser.
 */
export function byokConnectionMetadata(configuration: ModelConfiguration) {
  return {
    model_configuration_id: configuration.model_configuration_id,
    provider: configuration.provider,
    base_url: configuration.base_url,
    model: configuration.model_name
  };
}
