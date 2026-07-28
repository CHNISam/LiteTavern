import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type PomChatDatabase } from '@pomchat/database';
import { runBackup, runRestore, verifyBackup } from './backup.js';
import { loadCloudConfig } from './config.js';
import { createBatch, releaseUsers } from './batches.js';
import {
  activateAlpha,
  ensureMembership,
  joinWaitlist,
  readBatchPolicy
} from './membership.js';
import { finalizeQuota, reserveQuota } from './quota.js';
import { initializeFreeQuota } from '../free-quota.js';

let workspace: string | undefined;

afterEach(async () => {
  if (workspace) await rm(workspace, { recursive: true, force: true });
  workspace = undefined;
});

async function seed(dataDir: string): Promise<{
  database: PomChatDatabase;
  userId: string;
  cycleId: string;
}> {
  const database = await createDatabase({ dataDir });
  const cloud = loadCloudConfig({});
  const userId = randomUUID();
  await database.query(
    `INSERT INTO app_user (user_id, email) VALUES ($1, 'restore@example.com')`,
    [userId]
  );
  await initializeFreeQuota(database, userId, 30);
  await ensureMembership(database, userId, false);
  await joinWaitlist(database, userId);
  const batch = await createBatch(database, cloud, {
    name: 'restore',
    capacity: 5,
    quotaPolicy: { cycle_units: 10, cycle_days: 30, daily_unit_limit: 0 }
  });
  await releaseUsers(database, cloud, {
    batchId: batch.batch_id,
    userIds: [userId]
  });

  const policy = await readBatchPolicy(database, batch.batch_id, cloud.defaultAlphaPolicy);
  await activateAlpha(database, { userId, policy });
  const context = {
    userId,
    membershipStatus: 'ALPHA_ACTIVE' as const,
    policy,
    trialEnabled: cloud.trialEnabled,
    provider: 'groq',
    model: 'm',
    requestId: 'request-restore'
  };
  const reservation = await reserveQuota(database, context);
  await finalizeQuota(database, {
    ...context,
    source: 'ALPHA',
    units: reservation.units,
    cycleId: reservation.cycleId
  });
  const cycle = await database.query<{ cycle_id: string }>(
    `SELECT cycle_id FROM cloud_quota_cycle WHERE user_id = $1`,
    [userId]
  );
  return { database, userId, cycleId: String(cycle.rows[0]?.cycle_id) };
}

// Each case boots several PGlite instances (seed, verification probe, restored copy),
// which is slower than the 5s default.
describe('backup and restore', { timeout: 60_000 }, () => {
  it('produces a snapshot that verifies and actually restores', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'litetavern-backup-'));
    const dataDir = join(workspace, 'database');
    const { database, userId } = await seed(dataDir);
    await database.close();

    const snapshot = join(workspace, 'snapshot');
    const result = await runBackup({ source: dataDir, destination: snapshot });
    expect(result.manifest.files.length).toBeGreaterThan(0);

    const verification = await verifyBackup(snapshot);
    expect(verification.ok).toBe(true);
    expect(verification.mismatches).toEqual([]);
    // Verified means "opened and read", not "the copy job exited zero".
    expect(verification.probe?.users).toBe(1);

    const target = join(workspace, 'restored');
    await runRestore({ backupDirectory: snapshot, target });
    const restored = await createDatabase({ dataDir: target });
    try {
      const cycle = await restored.query<{
        granted: number;
        consumed: number;
        reserved: number;
      }>(
        `SELECT granted_units AS granted, consumed_units AS consumed,
                reserved_units AS reserved
         FROM cloud_quota_cycle WHERE user_id = $1`,
        [userId]
      );
      expect(Number(cycle.rows[0]?.granted)).toBe(10);
      expect(Number(cycle.rows[0]?.consumed)).toBe(1);
      expect(Number(cycle.rows[0]?.reserved)).toBe(0);
    } finally {
      await restored.close();
    }
  });

  it('refuses to restore a snapshot whose files were altered', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'litetavern-backup-'));
    const dataDir = join(workspace, 'database');
    const { database } = await seed(dataDir);
    await database.close();

    const snapshot = join(workspace, 'snapshot');
    const result = await runBackup({ source: dataDir, destination: snapshot });
    const firstFile = result.manifest.files[0];
    await writeFile(join(snapshot, 'data', String(firstFile?.path)), 'tampered');

    const verification = await verifyBackup(snapshot);
    expect(verification.ok).toBe(false);
    await expect(
      runRestore({ backupDirectory: snapshot, target: join(workspace, 'out') })
    ).rejects.toThrow(/failed verification/);
  });

  it('does not re-grant or double-deduct when operations replay after a restore', async () => {
    workspace = await mkdtemp(join(tmpdir(), 'litetavern-backup-'));
    const dataDir = join(workspace, 'database');
    const { database, userId } = await seed(dataDir);
    await database.close();

    const snapshot = join(workspace, 'snapshot');
    await runBackup({ source: dataDir, destination: snapshot });
    const target = join(workspace, 'restored');
    await runRestore({ backupDirectory: snapshot, target });

    const restored = await createDatabase({ dataDir: target });
    try {
      const cloud = loadCloudConfig({});
      const batch = await restored.query<{ batch_id: string }>(
        `SELECT batch_id FROM alpha_batch LIMIT 1`
      );
      const batchId = String(batch.rows[0]?.batch_id);
      const policy = await readBatchPolicy(restored, batchId, cloud.defaultAlphaPolicy);

      // Replaying the release and the settled request after a restore must be inert.
      await releaseUsers(restored, cloud, { batchId, userIds: [userId] });
      const context = {
        userId,
        membershipStatus: 'ALPHA_ACTIVE' as const,
        policy,
        trialEnabled: cloud.trialEnabled,
        provider: 'groq',
        model: 'm',
        requestId: 'request-restore'
      };
      await finalizeQuota(restored, {
        ...context,
        source: 'ALPHA',
        units: 1,
        cycleId: String(
          (
            await restored.query<{ cycle_id: string }>(
              `SELECT cycle_id FROM cloud_quota_cycle WHERE user_id = $1`,
              [userId]
            )
          ).rows[0]?.cycle_id
        )
      });

      const grants = await restored.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM alpha_grant
         WHERE user_id = $1 AND status = 'GRANTED'`,
        [userId]
      );
      const cycles = await restored.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM cloud_quota_cycle WHERE user_id = $1`,
        [userId]
      );
      const consumed = await restored.query<{ consumed: number }>(
        `SELECT consumed_units AS consumed FROM cloud_quota_cycle
         WHERE user_id = $1`,
        [userId]
      );
      const grantLedger = await restored.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM cloud_quota_ledger
         WHERE user_id = $1 AND action_type = 'GRANT'`,
        [userId]
      );

      expect(grants.rows[0]?.count).toBe(1);
      expect(cycles.rows[0]?.count).toBe(1);
      expect(grantLedger.rows[0]?.count).toBe(1);
      expect(Number(consumed.rows[0]?.consumed)).toBe(1);
    } finally {
      await restored.close();
    }
  });
});
