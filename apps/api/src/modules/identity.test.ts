import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createDatabase, type PomChatDatabase } from '@pomchat/database';
import { buildApp } from '../app.js';
import { claimAuthenticatedIdentity } from './identity.js';

let database: PomChatDatabase | undefined;
let app: Awaited<ReturnType<typeof buildApp>> | undefined;

afterEach(async () => {
  await app?.close();
  await database?.close();
  app = undefined;
  database = undefined;
});

describe('anonymous identity lifecycle', () => {
  it('creates one stable anonymous user with one 30-reply grant', async () => {
    database = await createDatabase({ dataDir: 'memory://' });
    app = await buildApp({ database });

    const first = await app.inject({ method: 'POST', url: '/v1/identities/anonymous' });
    const cookie = String(first.headers['set-cookie']).split(';')[0];
    const second = await app.inject({
      method: 'POST',
      url: '/v1/identities/anonymous',
      headers: { cookie }
    });

    expect(first.json().user).toMatchObject({
      identity_type: 'ANONYMOUS',
      free_quota_remaining: 30
    });
    expect(first.json().user.anonymous_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(second.json().user.user_id).toBe(first.json().user.user_id);
    expect(second.json().user.anonymous_id).toBe(first.json().user.anonymous_id);

    const grants = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count
       FROM free_quota_ledger
       WHERE user_id = $1 AND action_type = 'GRANT'`,
      [first.json().user.user_id]
    );
    expect(grants.rows[0]?.count).toBe(1);
  });

  it('claims the same user idempotently without resetting quota or owned data', async () => {
    database = await createDatabase({ dataDir: 'memory://' });
    const userId = randomUUID();
    const characterId = randomUUID();
    await database.query(
      `INSERT INTO app_user (
         user_id, free_quota_total, free_quota_remaining, free_quota_reserved
       ) VALUES ($1, 30, 17, 0)`,
      [userId]
    );
    await database.query(
      `INSERT INTO agent_character (
         character_id, owner_user_id, visibility, name, status
       ) VALUES ($1, $2, 'PRIVATE', 'Owned character', 'ACTIVE')`,
      [characterId, userId]
    );

    const first = await claimAuthenticatedIdentity(database, {
      anonymousUserId: userId,
      identityType: 'ACCOUNT',
      subject: 'account-subject-1'
    });
    const replay = await claimAuthenticatedIdentity(database, {
      anonymousUserId: userId,
      identityType: 'ACCOUNT',
      subject: 'account-subject-1'
    });

    expect(first).toMatchObject({ userId, created: true });
    expect(replay).toMatchObject({ userId, created: false });
    const user = await database.query<{
      free_quota_remaining: number;
      owned: number;
      identities: number;
    }>(
      `SELECT u.free_quota_remaining,
              (SELECT COUNT(*)::int FROM agent_character c WHERE c.owner_user_id = u.user_id) AS owned,
              (SELECT COUNT(*)::int FROM app_user_identity i WHERE i.user_id = u.user_id) AS identities
       FROM app_user u WHERE u.user_id = $1`,
      [userId]
    );
    expect(user.rows[0]).toEqual({
      free_quota_remaining: 17,
      owned: 1,
      identities: 1
    });
  });

  it('refuses to link an authenticated subject owned by another user', async () => {
    database = await createDatabase({ dataDir: 'memory://' });
    const firstUser = randomUUID();
    const secondUser = randomUUID();
    await database.query(`INSERT INTO app_user (user_id) VALUES ($1), ($2)`, [
      firstUser,
      secondUser
    ]);
    await claimAuthenticatedIdentity(database, {
      anonymousUserId: firstUser,
      identityType: 'ACCOUNT',
      subject: 'shared-subject'
    });

    await expect(
      claimAuthenticatedIdentity(database, {
        anonymousUserId: secondUser,
        identityType: 'ACCOUNT',
        subject: 'shared-subject'
      })
    ).rejects.toMatchObject({ code: 'IDENTITY_CONFLICT' });
  });
});
