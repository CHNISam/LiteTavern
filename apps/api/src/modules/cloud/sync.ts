import { randomUUID } from 'node:crypto';
import type { PomChatDatabase } from '@pomchat/database';

/**
 * Cloud sync checkpoints.
 *
 * LiteTavern Cloud is the store of record for characters, conversations, messages and
 * memories — the client does not hold a second authoritative copy. "Sync" is therefore
 * the per-device acknowledgement of how far a client has reconciled with the server,
 * plus an explicit failure state it can retry from.
 *
 * The conflict rule is deliberately simple and explainable rather than a CRDT: the
 * server's revision wins, and a device that checkpoints behind the newest server
 * revision is told it is stale and must refetch. That is enough for "continue on
 * another device" and never silently discards a write, because writes go through the
 * API in the first place.
 */

export type SyncStatus = 'LOCAL' | 'SYNCING' | 'SYNCED' | 'FAILED';

export interface SyncCheckpointInput {
  userId: string;
  deviceKey: string;
  status: SyncStatus;
  /** Monotonic client counter; used only to detect a stale device. */
  clientRevision?: number;
  pendingCount?: number;
  errorCode?: string | null;
}

export interface SyncCheckpoint {
  status: SyncStatus;
  device_key: string;
  last_synced_at: string | null;
  pending_count: number;
  conflict_count: number;
  /** Newest server-side content instant; a client behind this must refetch. */
  server_revision: string | null;
  stale: boolean;
  last_error_code: string | null;
}

/** Newest update instant across the user's cloud-owned content. */
async function serverRevision(
  database: PomChatDatabase,
  userId: string
): Promise<string | null> {
  const result = await database.query<{ revision: string | null }>(
    `SELECT GREATEST(
              COALESCE(MAX(c.updated_at), TIMESTAMPTZ '-infinity'),
              COALESCE(MAX(m.updated_at), TIMESTAMPTZ '-infinity')
            ) AS revision
     FROM chat_conversation c
     LEFT JOIN chat_message m ON m.conversation_id = c.conversation_id
     WHERE c.user_id = $1 AND c.status <> 'DELETED'`,
    [userId]
  );
  const revision = result.rows[0]?.revision ?? null;
  return revision && !String(revision).includes('infinity') ? revision : null;
}

/**
 * Records a device's sync state. Idempotent per (user, device): re-sending the same
 * checkpoint after a retry updates the row rather than creating another one, which is
 * what makes a failed sync safely retryable.
 */
export async function recordSyncCheckpoint(
  database: PomChatDatabase,
  input: SyncCheckpointInput
): Promise<SyncCheckpoint> {
  const revision = await serverRevision(database, input.userId);
  const clientRevision = Math.max(0, Math.trunc(input.clientRevision ?? 0));

  const existing = await database.query<{ last_client_revision: string | number }>(
    `SELECT last_client_revision FROM cloud_sync_state
     WHERE user_id = $1 AND device_key = $2`,
    [input.userId, input.deviceKey]
  );
  const previous = Number(existing.rows[0]?.last_client_revision ?? 0);
  // A device replaying an older revision than it already acknowledged is stale
  // (usually a second device that has since written). It must refetch, not overwrite.
  const stale = existing.rows.length > 0 && clientRevision < previous;

  const result = await database.query<{
    status: SyncStatus;
    last_synced_at: string | null;
    pending_count: number;
    conflict_count: number;
    last_error_code: string | null;
  }>(
    `INSERT INTO cloud_sync_state (
       sync_id, user_id, device_key, status, last_synced_at,
       last_client_revision, pending_count, conflict_count, last_error_code
     ) VALUES ($1, $2, $3, $4, $9, $5, $6, $7, $8)
     ON CONFLICT (user_id, device_key) DO UPDATE SET
       status = EXCLUDED.status,
       last_synced_at = COALESCE(
         EXCLUDED.last_synced_at, cloud_sync_state.last_synced_at
       ),
       last_client_revision = GREATEST(
         cloud_sync_state.last_client_revision, EXCLUDED.last_client_revision
       ),
       pending_count = EXCLUDED.pending_count,
       conflict_count = cloud_sync_state.conflict_count + EXCLUDED.conflict_count,
       last_error_code = EXCLUDED.last_error_code,
       updated_at = CURRENT_TIMESTAMP
     RETURNING status, last_synced_at, pending_count, conflict_count, last_error_code`,
    [
      randomUUID(),
      input.userId,
      input.deviceKey,
      input.status,
      clientRevision,
      Math.max(0, Math.trunc(input.pendingCount ?? 0)),
      stale ? 1 : 0,
      input.errorCode ?? null,
      input.status === 'SYNCED' ? new Date().toISOString() : null
    ]
  );

  const row = result.rows[0];
  return {
    status: row?.status ?? input.status,
    device_key: input.deviceKey,
    last_synced_at: row?.last_synced_at ?? null,
    pending_count: Number(row?.pending_count ?? 0),
    conflict_count: Number(row?.conflict_count ?? 0),
    server_revision: revision,
    stale,
    last_error_code: row?.last_error_code ?? null
  };
}

export async function listSyncState(
  database: PomChatDatabase,
  userId: string
): Promise<SyncCheckpoint[]> {
  const revision = await serverRevision(database, userId);
  const result = await database.query<{
    device_key: string;
    status: SyncStatus;
    last_synced_at: string | null;
    pending_count: number;
    conflict_count: number;
    last_error_code: string | null;
  }>(
    `SELECT device_key, status, last_synced_at, pending_count,
            conflict_count, last_error_code
     FROM cloud_sync_state
     WHERE user_id = $1
     ORDER BY updated_at DESC`,
    [userId]
  );
  return result.rows.map((row) => ({
    status: row.status,
    device_key: row.device_key,
    last_synced_at: row.last_synced_at,
    pending_count: Number(row.pending_count),
    conflict_count: Number(row.conflict_count),
    server_revision: revision,
    stale: false,
    last_error_code: row.last_error_code
  }));
}
