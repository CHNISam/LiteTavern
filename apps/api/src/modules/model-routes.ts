import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { PomChatDatabase } from '@pomchat/database';
import {
  PROVIDER_RUNTIME_PRESETS,
  modelConfigurationInputSchema,
  providerConnectionValidationSchema
} from '@pomchat/contracts';
import type { ModelGateway } from './providers/model-gateway.js';
import { resolveProviderEndpoint } from './providers/endpoint-policy.js';
import { resolveUserId } from './identity.js';

export function registerModelRoutes(
  app: FastifyInstance,
  database: PomChatDatabase,
  gateway: ModelGateway
) {
  app.get('/v1/providers', async (request) => {
    await resolveUserId(request, database);
    return {
      providers: PROVIDER_RUNTIME_PRESETS.filter((provider) => provider.id !== 'demo')
    };
  });

  app.post('/v1/provider-connections/validate', async (request) => {
    await resolveUserId(request, database);
    const input = providerConnectionValidationSchema.parse(request.body);
    const baseUrl = resolveProviderEndpoint(input.provider, input.base_url);
    return gateway.validate({
      provider: input.provider,
      baseUrl,
      model: input.model,
      apiKey: input.credential.api_key
    });
  });

  app.post('/v1/provider-connections/models', async (request) => {
    await resolveUserId(request, database);
    const input = providerConnectionValidationSchema.omit({ model: true }).parse(request.body);
    const baseUrl = resolveProviderEndpoint(input.provider, input.base_url);
    return {
      models: await gateway.listModels({
        provider: input.provider,
        baseUrl,
        apiKey: input.credential.api_key
      })
    };
  });

  app.get('/v1/model-configurations', async (request) => {
    const userId = await resolveUserId(request, database);
    const result = await database.query<Record<string, unknown>>(
      `SELECT model_configuration_id, provider, model_name, display_name,
              base_url, credential_mode, credential_id, settings_json,
              context_window, status, created_at, updated_at
       FROM model_configuration
       WHERE user_id = $1 AND configuration_scope = 'USER' AND deleted_at IS NULL
       ORDER BY updated_at DESC`,
      [userId]
    );
    return {
      configurations: result.rows.map((row) => ({ ...row, credential_configured: true }))
    };
  });

  app.post('/v1/model-configurations', async (request, reply) => {
    const userId = await resolveUserId(request, database);
    const input = modelConfigurationInputSchema.parse(request.body);
    const baseUrl = resolveProviderEndpoint(input.provider, input.base_url);
    const id = randomUUID();
    await database.query(
      `INSERT INTO model_configuration (
         model_configuration_id, user_id, configuration_scope, provider,
         model_name, display_name, base_url, credential_mode,
         credential_id, settings_json
       ) VALUES ($1, $2, 'USER', $3, $4, $5, $6, 'BROWSER_LOCAL', $7, $8::jsonb)`,
      [
        id,
        userId,
        input.provider,
        input.model_name,
        input.display_name,
        baseUrl,
        input.credential_id,
        JSON.stringify(input.settings)
      ]
    );
    reply.code(201);
    return {
      model_configuration_id: id,
      ...input,
      base_url: baseUrl,
      credential_configured: true
    };
  });

  app.delete<{ Params: { id: string } }>('/v1/model-configurations/:id', async (request) => {
    const userId = await resolveUserId(request, database);
    const result = await database.query(
      `UPDATE model_configuration SET status = 'DISABLED', deleted_at = CURRENT_TIMESTAMP,
                                      updated_at = CURRENT_TIMESTAMP
       WHERE model_configuration_id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING model_configuration_id`,
      [request.params.id, userId]
    );
    return { deleted: result.rows.length > 0 };
  });
}
