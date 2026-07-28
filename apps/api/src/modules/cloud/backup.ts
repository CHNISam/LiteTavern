import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createDatabase, type PomChatDatabase } from '@pomchat/database';

/**
 * LiteTavern Cloud backup and restore.
 *
 * The deployment stores its data in a PGlite data directory plus an asset directory,
 * so a backup is a checksummed copy of those trees and a restore puts them back.
 *
 * The rule this module enforces is that a backup is only "successful" once a restore
 * of it has actually been opened and read — `runBackup` writes a RUNNING row, marks
 * it SUCCEEDED when the copy and checksums are done, and only `verifyBackup` sets
 * VERIFIED. A scheduled job that merely finished is never reported as a working
 * backup.
 *
 * Restoring is safe for the quota ledgers because they are restored as a whole
 * point-in-time snapshot, never replayed: the one-GRANT-per-user / one-GRANT-per-cycle
 * indexes and the (request, action) uniqueness mean a re-run after a restore cannot
 * grant or deduct a second time.
 */

export interface BackupManifest {
  format: 'litetavern.backup';
  format_version: '1.0.0';
  created_at: string;
  scope: 'DATABASE' | 'ASSETS';
  source: string;
  files: { path: string; bytes: number; sha256: string }[];
  total_bytes: number;
  /** Checksum over the per-file checksums; identifies the snapshot as a whole. */
  digest: string;
}

async function walk(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(current, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(root, full)));
    else if (entry.isFile()) files.push(full);
  }
  return files;
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function buildManifest(
  source: string,
  scope: 'DATABASE' | 'ASSETS'
): Promise<BackupManifest> {
  const files = (await walk(source)).sort();
  const entries: BackupManifest['files'] = [];
  let totalBytes = 0;
  for (const file of files) {
    const info = await stat(file);
    totalBytes += info.size;
    entries.push({
      path: relative(source, file).split('\\').join('/'),
      bytes: info.size,
      sha256: await sha256(file)
    });
  }
  const digest = createHash('sha256')
    .update(entries.map((entry) => `${entry.path}:${entry.sha256}`).join('\n'))
    .digest('hex');
  return {
    format: 'litetavern.backup',
    format_version: '1.0.0',
    created_at: new Date().toISOString(),
    scope,
    source: resolve(source),
    files: entries,
    total_bytes: totalBytes,
    digest
  };
}

export interface BackupOptions {
  /** Directory to back up. */
  source: string;
  /** Directory the snapshot is written into (created if missing). */
  destination: string;
  scope?: 'DATABASE' | 'ASSETS';
  /** Optional database used to record the job. Omit for a cold copy. */
  database?: PomChatDatabase;
}

export interface BackupResult {
  backupJobId: string;
  artifactUri: string;
  manifest: BackupManifest;
}

export async function runBackup(options: BackupOptions): Promise<BackupResult> {
  const scope = options.scope ?? 'DATABASE';
  const backupJobId = randomUUID();
  if (!existsSync(options.source)) {
    throw new Error(`Backup source does not exist: ${options.source}`);
  }

  await options.database?.query(
    `INSERT INTO cloud_backup_job (
       backup_job_id, job_kind, scope, status, artifact_uri
     ) VALUES ($1, 'BACKUP', $2, 'RUNNING', $3)`,
    [backupJobId, scope, options.destination]
  );

  try {
    await rm(options.destination, { recursive: true, force: true });
    await mkdir(options.destination, { recursive: true });
    await cp(options.source, join(options.destination, 'data'), {
      recursive: true
    });
    const manifest = await buildManifest(
      join(options.destination, 'data'),
      scope
    );
    await writeFile(
      join(options.destination, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8'
    );

    await options.database?.query(
      `UPDATE cloud_backup_job
       SET status = 'SUCCEEDED', checksum_sha256 = $2, size_bytes = $3,
           finished_at = CURRENT_TIMESTAMP
       WHERE backup_job_id = $1`,
      [backupJobId, manifest.digest, manifest.total_bytes]
    );
    return { backupJobId, artifactUri: options.destination, manifest };
  } catch (error) {
    await options.database?.query(
      `UPDATE cloud_backup_job
       SET status = 'FAILED', error_code = $2, finished_at = CURRENT_TIMESTAMP
       WHERE backup_job_id = $1`,
      [backupJobId, 'BACKUP_FAILED']
    );
    throw error;
  }
}

export interface VerifyResult {
  ok: boolean;
  checkedFiles: number;
  mismatches: string[];
  /** Row counts read from a restored copy — proof the snapshot actually opens. */
  probe?: { users: number; conversations: number; messages: number };
}

/**
 * Verifies a snapshot by re-checksumming every file and then opening a throwaway
 * restore of it. Only this makes a backup "verified"; a copy that cannot be opened
 * and queried is not a backup.
 */
export async function verifyBackup(
  backupDirectory: string,
  options: { database?: PomChatDatabase; backupJobId?: string; probeDirectory?: string } = {}
): Promise<VerifyResult> {
  const manifest = JSON.parse(
    await readFile(join(backupDirectory, 'manifest.json'), 'utf8')
  ) as BackupManifest;
  const dataDirectory = join(backupDirectory, 'data');

  const mismatches: string[] = [];
  for (const entry of manifest.files) {
    const path = join(dataDirectory, entry.path);
    if (!existsSync(path)) {
      mismatches.push(entry.path);
      continue;
    }
    if ((await sha256(path)) !== entry.sha256) mismatches.push(entry.path);
  }

  let probe: VerifyResult['probe'];
  if (mismatches.length === 0 && manifest.scope === 'DATABASE') {
    const probeDirectory =
      options.probeDirectory ?? join(backupDirectory, '.verify');
    await rm(probeDirectory, { recursive: true, force: true });
    await cp(dataDirectory, probeDirectory, { recursive: true });
    const restored = await createDatabase({ dataDir: probeDirectory });
    try {
      const counts = await restored.query<{
        users: number;
        conversations: number;
        messages: number;
      }>(
        `SELECT
           (SELECT COUNT(*)::int FROM app_user) AS users,
           (SELECT COUNT(*)::int FROM chat_conversation) AS conversations,
           (SELECT COUNT(*)::int FROM chat_message) AS messages`
      );
      probe = {
        users: Number(counts.rows[0]?.users ?? 0),
        conversations: Number(counts.rows[0]?.conversations ?? 0),
        messages: Number(counts.rows[0]?.messages ?? 0)
      };
    } finally {
      await restored.close();
      await rm(probeDirectory, { recursive: true, force: true });
    }
  }

  const ok = mismatches.length === 0 && (manifest.scope !== 'DATABASE' || Boolean(probe));
  if (options.database && options.backupJobId) {
    await options.database.query(
      `UPDATE cloud_backup_job
       SET status = $2,
           verified_at = CASE WHEN $3 THEN CURRENT_TIMESTAMP ELSE NULL END,
           verification_note = $4
       WHERE backup_job_id = $1`,
      [
        options.backupJobId,
        ok ? 'VERIFIED' : 'FAILED',
        ok,
        ok
          ? `restored probe: ${probe?.users ?? 0} users, ${probe?.messages ?? 0} messages`
          : `checksum mismatches: ${mismatches.length}`
      ]
    );
  }

  return { ok, checkedFiles: manifest.files.length, mismatches, ...(probe ? { probe } : {}) };
}

export interface RestoreOptions {
  backupDirectory: string;
  target: string;
  /** Refuse to overwrite a non-empty target unless explicitly allowed. */
  force?: boolean;
}

/**
 * Restores a verified snapshot over the target directory. Verification runs first —
 * restoring an unverified snapshot would replace live data with something unproven.
 */
export async function runRestore(options: RestoreOptions): Promise<VerifyResult> {
  const verification = await verifyBackup(options.backupDirectory);
  if (!verification.ok) {
    throw new Error(
      `Refusing to restore: snapshot failed verification (${verification.mismatches.length} bad files).`
    );
  }
  if (existsSync(options.target) && !options.force) {
    const entries = await readdir(options.target);
    if (entries.length > 0) {
      throw new Error(
        `Refusing to overwrite non-empty target ${options.target}; pass --force to proceed.`
      );
    }
  }
  await rm(options.target, { recursive: true, force: true });
  await mkdir(options.target, { recursive: true });
  await cp(join(options.backupDirectory, 'data'), options.target, {
    recursive: true
  });
  return verification;
}

/** Deletes snapshots older than `keepDays`, keeping at least `keepMinimum` of them. */
export async function pruneBackups(
  rootDirectory: string,
  keepDays: number,
  keepMinimum = 3
): Promise<string[]> {
  if (!existsSync(rootDirectory)) return [];
  const entries = await readdir(rootDirectory, { withFileTypes: true });
  const snapshots: { path: string; createdAt: number }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const path = join(rootDirectory, entry.name);
    const manifestPath = join(path, 'manifest.json');
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(
      await readFile(manifestPath, 'utf8')
    ) as BackupManifest;
    snapshots.push({ path, createdAt: new Date(manifest.created_at).getTime() });
  }
  snapshots.sort((left, right) => right.createdAt - left.createdAt);

  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];
  for (const [index, snapshot] of snapshots.entries()) {
    if (index < keepMinimum) continue;
    if (snapshot.createdAt >= cutoff) continue;
    await rm(snapshot.path, { recursive: true, force: true });
    removed.push(snapshot.path);
  }
  return removed;
}
