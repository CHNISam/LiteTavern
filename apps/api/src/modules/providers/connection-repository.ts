import { randomUUID } from 'node:crypto';
import type { PomChatDatabase } from '@pomchat/database';
import type {
  AuthMethodKind,
  AvailableModel,
  ConnectionStatus,
  CredentialMetadata,
  ProviderConnection
} from '@pomchat/contracts';

interface ConnectionRow {
  connection_id: string;
  provider_id: string;
  auth_method_id: string;
  display_name: string;
  status: ConnectionStatus;
  config_json: Record<string, unknown> | string;
  credential_ref: string | null;
  last_checked_at: Date | string | null;
  last_error_code: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface CreateConnectionInput {
  id?: string;
  userId: string;
  providerId: string;
  authMethodId: string;
  displayName: string;
  status: ConnectionStatus;
  nonSecretConfig: Record<string, unknown>;
}

export interface SaveCredentialMetadataInput {
  credentialRef: string;
  connectionId: string;
  kind: AuthMethodKind;
  store: CredentialMetadata['store'];
  version: number;
  expiresAt?: string;
}

function asIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function parseJson(value: Record<string, unknown> | string): Record<string, unknown> {
  return typeof value === 'string' ? (JSON.parse(value) as Record<string, unknown>) : value;
}

function toConnection(row: ConnectionRow): ProviderConnection {
  return {
    id: row.connection_id,
    providerId: row.provider_id,
    authMethodId: row.auth_method_id,
    displayName: row.display_name,
    status: row.status,
    nonSecretConfig: parseJson(row.config_json),
    ...(row.credential_ref ? { credentialRef: row.credential_ref } : {}),
    ...(row.last_checked_at ? { lastCheckedAt: asIso(row.last_checked_at) } : {}),
    ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
    createdAt: asIso(row.created_at),
    updatedAt: asIso(row.updated_at)
  };
}

export class ConnectionRepository {
  constructor(private readonly database: PomChatDatabase) {}

  async create(input: CreateConnectionInput): Promise<ProviderConnection> {
    const connectionId = input.id ?? randomUUID();
    const result = await this.database.query<ConnectionRow>(
      `INSERT INTO provider_connection (
         connection_id, user_id, provider_id, auth_method_id,
         display_name, status, config_json
       ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       RETURNING connection_id, provider_id, auth_method_id, display_name,
                 status, config_json, NULL::text AS credential_ref,
                 last_checked_at, last_error_code, created_at, updated_at`,
      [
        connectionId,
        input.userId,
        input.providerId,
        input.authMethodId,
        input.displayName,
        input.status,
        JSON.stringify(input.nonSecretConfig)
      ]
    );
    return toConnection(result.rows[0]!);
  }

  async listForUser(userId: string): Promise<ProviderConnection[]> {
    const result = await this.database.query<ConnectionRow>(
      `SELECT c.connection_id, c.provider_id, c.auth_method_id, c.display_name,
              c.status, c.config_json, m.credential_ref, c.last_checked_at,
              c.last_error_code, c.created_at, c.updated_at
       FROM provider_connection c
       LEFT JOIN provider_credential_metadata m ON m.connection_id = c.connection_id
       WHERE c.user_id = $1 AND c.deleted_at IS NULL
       ORDER BY c.updated_at DESC`,
      [userId]
    );
    return result.rows.map(toConnection);
  }

  async findOwned(userId: string, connectionId: string): Promise<ProviderConnection | null> {
    const result = await this.database.query<ConnectionRow>(
      `SELECT c.connection_id, c.provider_id, c.auth_method_id, c.display_name,
              c.status, c.config_json, m.credential_ref, c.last_checked_at,
              c.last_error_code, c.created_at, c.updated_at
       FROM provider_connection c
       LEFT JOIN provider_credential_metadata m ON m.connection_id = c.connection_id
       WHERE c.user_id = $1 AND c.connection_id = $2 AND c.deleted_at IS NULL`,
      [userId, connectionId]
    );
    return result.rows[0] ? toConnection(result.rows[0]) : null;
  }

  async updateStatus(
    connectionId: string,
    status: ConnectionStatus,
    errorCode?: string
  ): Promise<void> {
    await this.database.query(
      `UPDATE provider_connection
       SET status = $2,
           last_error_code = $3,
           last_checked_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE connection_id = $1 AND deleted_at IS NULL`,
      [connectionId, status, errorCode ?? null]
    );
  }

  async saveCredentialMetadata(input: SaveCredentialMetadataInput): Promise<void> {
    await this.database.query(
      `INSERT INTO provider_credential_metadata (
         credential_ref, connection_id, kind, store, version, expires_at
       ) VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (connection_id) DO UPDATE SET
         credential_ref = EXCLUDED.credential_ref,
         kind = EXCLUDED.kind,
         store = EXCLUDED.store,
         version = EXCLUDED.version,
         expires_at = EXCLUDED.expires_at,
         updated_at = CURRENT_TIMESTAMP`,
      [
        input.credentialRef,
        input.connectionId,
        input.kind,
        input.store,
        input.version,
        input.expiresAt ?? null
      ]
    );
  }

  async getCredentialMetadata(connectionId: string): Promise<CredentialMetadata | null> {
    const result = await this.database.query<{
      credential_ref: string;
      connection_id: string;
      kind: AuthMethodKind;
      store: CredentialMetadata['store'];
      version: number;
      expires_at: Date | string | null;
      updated_at: Date | string;
    }>(
      `SELECT credential_ref, connection_id, kind, store, version, expires_at, updated_at
       FROM provider_credential_metadata
       WHERE connection_id = $1`,
      [connectionId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      credentialRef: row.credential_ref,
      connectionId: row.connection_id,
      kind: row.kind,
      store: row.store,
      version: row.version,
      ...(row.expires_at ? { expiresAt: asIso(row.expires_at) } : {}),
      updatedAt: asIso(row.updated_at)
    };
  }

  async replaceModels(connectionId: string, models: readonly AvailableModel[]): Promise<void> {
    await this.database.transaction(async (transaction) => {
      await transaction.query(
        `DELETE FROM provider_model_catalog WHERE connection_id = $1`,
        [connectionId]
      );
      for (const model of models) {
        await transaction.query(
          `INSERT INTO provider_model_catalog (
             connection_id, model_id, metadata_json
           ) VALUES ($1, $2, $3::jsonb)`,
          [connectionId, model.id, JSON.stringify(model)]
        );
      }
    });
  }

  async listModels(connectionId: string): Promise<AvailableModel[]> {
    const result = await this.database.query<{
      model_id: string;
      metadata_json: AvailableModel | string;
    }>(
      `SELECT model_id, metadata_json
       FROM provider_model_catalog
       WHERE connection_id = $1
       ORDER BY model_id`,
      [connectionId]
    );
    return result.rows.map((row) =>
      typeof row.metadata_json === 'string'
        ? (JSON.parse(row.metadata_json) as AvailableModel)
        : row.metadata_json
    );
  }

  async deleteOwned(userId: string, connectionId: string): Promise<boolean> {
    const result = await this.database.query<{ connection_id: string }>(
      `DELETE FROM provider_connection
       WHERE connection_id = $1 AND user_id = $2
       RETURNING connection_id`,
      [connectionId, userId]
    );
    return result.rows.length > 0;
  }
}
