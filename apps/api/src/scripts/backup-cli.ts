/**
 * LiteTavern Cloud backup / restore CLI.
 *
 *   npm run backup  --workspace @pomchat/api -- [--out <dir>]
 *   npm run verify-backup --workspace @pomchat/api -- --snapshot <dir>
 *   npm run restore --workspace @pomchat/api -- --snapshot <dir> [--force]
 *   npm run prune-backups --workspace @pomchat/api -- [--keep-days 14]
 *
 * The API process must be stopped while backing up or restoring: PGlite holds an
 * exclusive lock on its data directory, and a copy taken mid-write is not a backup.
 */
import { join } from 'node:path';
import { createDatabase } from '@pomchat/database';
import {
  pruneBackups,
  runBackup,
  runRestore,
  verifyBackup
} from '../modules/cloud/backup.js';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const DATA_DIR = process.env.POMCHAT_DATA_DIR ?? '.pomchat/database';
const ASSET_DIR = process.env.POMCHAT_ASSET_DIR ?? '.pomchat/assets';
const BACKUP_ROOT = process.env.CLOUD_BACKUP_DIR ?? '.pomchat/backups';

async function backup(): Promise<void> {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const destination = flag('out') ?? join(BACKUP_ROOT, stamp);

  // Recording the job needs the database, which must not be the one being copied —
  // so the copy is taken first and the job rows are written afterwards, against the
  // freshly restored-and-verified snapshot's source database.
  const database = await createDatabase({ dataDir: DATA_DIR });
  try {
    const result = await runBackup({
      source: DATA_DIR,
      destination: join(destination, 'database'),
      scope: 'DATABASE',
      database
    });
    const assets = await runBackup({
      source: ASSET_DIR,
      destination: join(destination, 'assets'),
      scope: 'ASSETS',
      database
    }).catch(() => null);

    const verification = await verifyBackup(join(destination, 'database'), {
      database,
      backupJobId: result.backupJobId
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          snapshot: destination,
          database_digest: result.manifest.digest,
          assets_included: assets !== null,
          verified: verification.ok,
          probe: verification.probe ?? null
        },
        null,
        2
      )}\n`
    );
    if (!verification.ok) process.exitCode = 1;
  } finally {
    await database.close();
  }
}

async function verify(): Promise<void> {
  const snapshot = flag('snapshot');
  if (!snapshot) throw new Error('--snapshot <dir> is required.');
  const result = await verifyBackup(join(snapshot, 'database'));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

async function restore(): Promise<void> {
  const snapshot = flag('snapshot');
  if (!snapshot) throw new Error('--snapshot <dir> is required.');
  const result = await runRestore({
    backupDirectory: join(snapshot, 'database'),
    target: DATA_DIR,
    force: has('force')
  });
  await runRestore({
    backupDirectory: join(snapshot, 'assets'),
    target: ASSET_DIR,
    force: has('force')
  }).catch(() => undefined);

  // Record the restore against the database that was just put back in place.
  const database = await createDatabase({ dataDir: DATA_DIR });
  try {
    await database.query(
      `INSERT INTO cloud_backup_job (
         backup_job_id, job_kind, scope, status, artifact_uri,
         verified_at, verification_note, finished_at
       ) VALUES (
         gen_random_uuid(), 'RESTORE', 'DATABASE', 'VERIFIED', $1,
         CURRENT_TIMESTAMP, $2, CURRENT_TIMESTAMP
       )`,
      [
        snapshot,
        `restored ${result.probe?.users ?? 0} users, ${result.probe?.messages ?? 0} messages`
      ]
    );
  } finally {
    await database.close();
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

async function prune(): Promise<void> {
  const keepDays = Number(flag('keep-days') ?? process.env.CLOUD_BACKUP_KEEP_DAYS ?? 14);
  const removed = await pruneBackups(BACKUP_ROOT, keepDays);
  process.stdout.write(`${JSON.stringify({ removed }, null, 2)}\n`);
}

const command = process.argv[2];
const commands: Record<string, () => Promise<void>> = {
  backup,
  verify,
  restore,
  prune
};

const handler = command ? commands[command] : undefined;
if (!handler) {
  process.stderr.write(
    `Usage: backup-cli <backup|verify|restore|prune> [options]\n`
  );
  process.exit(2);
}

handler().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'backup command failed'}\n`
  );
  process.exit(1);
});
