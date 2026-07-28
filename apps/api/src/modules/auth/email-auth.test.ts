import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, type LiteTavernDatabase } from '@litetavern/database';
import { buildApp } from '../../app.js';
import { MemoryEmailProvider } from './email-provider.js';
import { mergeUserData } from './account-merge.js';

let database: LiteTavernDatabase;
let app: Awaited<ReturnType<typeof buildApp>>;
let mail: MemoryEmailProvider;

beforeEach(async () => {
  database = await createDatabase({ dataDir: 'memory://' });
  mail = new MemoryEmailProvider();
  app = await buildApp({ database, emailProvider: mail });
});

afterEach(async () => {
  await app.close();
  await database.close();
});

function cookieFrom(response: { headers: Record<string, unknown> }): string {
  return String(response.headers['set-cookie']).split(';')[0] ?? '';
}

async function newSession(): Promise<{ cookie: string; userId: string }> {
  const response = await app.inject({ method: 'POST', url: '/v1/identities/anonymous' });
  return { cookie: cookieFrom(response), userId: response.json().user.user_id };
}

function send(cookie: string, email: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/email-code/send',
    headers: { cookie },
    payload: { email }
  });
}

function verify(cookie: string, email: string, code: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/email-code/verify',
    headers: { cookie },
    payload: { email, code }
  });
}

// Push a code's created_at back so the 60s resend cooldown no longer applies.
async function clearCooldown(email: string) {
  await database.query(
    `UPDATE auth_email_verification_code
     SET created_at = created_at - INTERVAL '5 minutes'
     WHERE email_normalized = $1`,
    [email.toLowerCase()]
  );
}

describe('email verification code — sending', () => {
  it('sends a code and returns a uniform, non-enumerating message', async () => {
    const { cookie } = await newSession();
    const response = await send(cookie, 'user@example.com');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      success: true,
      message: '如果该邮箱可用，验证码已发送。'
    });
    expect(mail.lastCodeFor('user@example.com')).toMatch(/^\d{6}$/);
  });

  it('normalizes the email before storing and matching', async () => {
    const { cookie } = await newSession();
    await send(cookie, '  User@Example.COM ');
    expect(mail.sent[0]?.to).toBe('user@example.com');
    const code = mail.lastCodeFor('user@example.com')!;
    const verified = await verify(cookie, 'USER@example.com', code);
    expect(verified.statusCode).toBe(200);
  });

  it('rejects a malformed email with a validation error', async () => {
    const { cookie } = await newSession();
    const response = await send(cookie, 'not-an-email');
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rate-limits a resend within the cooldown window', async () => {
    const { cookie } = await newSession();
    await send(cookie, 'user@example.com');
    const second = await send(cookie, 'user@example.com');
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe('CODE_SEND_RATE_LIMITED');
  });

  it('never returns the code and keeps it out of the response body', async () => {
    const { cookie } = await newSession();
    const response = await send(cookie, 'user@example.com');
    const code = mail.lastCodeFor('user@example.com')!;
    expect(response.body).not.toContain(code);
  });

  it('does not reveal whether the email already has an account', async () => {
    const registrant = await newSession();
    await send(registrant.cookie, 'exists@example.com');
    await verify(
      registrant.cookie,
      'exists@example.com',
      mail.lastCodeFor('exists@example.com')!
    );

    const probe = await newSession();
    await clearCooldown('exists@example.com');
    const knownEmail = await send(probe.cookie, 'exists@example.com');
    const unknownEmail = await send(probe.cookie, 'nobody@example.com');
    expect(knownEmail.json()).toEqual(unknownEmail.json());
    expect(knownEmail.statusCode).toBe(unknownEmail.statusCode);
  });
});

describe('email verification code — verifying', () => {
  it('rejects an incorrect code as CODE_INVALID', async () => {
    const { cookie } = await newSession();
    await send(cookie, 'user@example.com');
    const response = await verify(cookie, 'user@example.com', '000000');
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('CODE_INVALID');
  });

  it('rejects an expired code as CODE_EXPIRED', async () => {
    const { cookie } = await newSession();
    await send(cookie, 'user@example.com');
    const code = mail.lastCodeFor('user@example.com')!;
    await database.query(
      `UPDATE auth_email_verification_code
       SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute'
       WHERE email_normalized = 'user@example.com'`
    );
    const response = await verify(cookie, 'user@example.com', code);
    expect(response.json().error.code).toBe('CODE_EXPIRED');
  });

  it('consumes a code on success so it cannot be reused', async () => {
    const { cookie } = await newSession();
    await send(cookie, 'user@example.com');
    const code = mail.lastCodeFor('user@example.com')!;
    const first = await verify(cookie, 'user@example.com', code);
    expect(first.statusCode).toBe(200);
    // Reuse with the rotated cookie from the first verify.
    const reused = await verify(cookieFrom(first), 'user@example.com', code);
    expect(reused.json().error.code).toBe('CODE_INVALID');
  });

  it('locks the code after the attempt cap and rejects further tries', async () => {
    const { cookie } = await newSession();
    await send(cookie, 'user@example.com');
    const code = mail.lastCodeFor('user@example.com')!;
    let last = await verify(cookie, 'user@example.com', '111111');
    for (let attempt = 0; attempt < 4; attempt += 1) {
      last = await verify(cookie, 'user@example.com', '111111');
    }
    expect(last.json().error.code).toBe('CODE_ATTEMPTS_EXCEEDED');
    // Even the correct code no longer works once the code is locked.
    const afterLock = await verify(cookie, 'user@example.com', code);
    expect(afterLock.json().error.code).toBe('CODE_INVALID');
  });

  it('invalidates a prior code once a new one is issued', async () => {
    const { cookie } = await newSession();
    await send(cookie, 'user@example.com');
    const oldCode = mail.lastCodeFor('user@example.com')!;
    await clearCooldown('user@example.com');
    await send(cookie, 'user@example.com');
    const newCode = mail.lastCodeFor('user@example.com')!;
    expect(newCode).not.toBe(oldCode);
    const withOld = await verify(cookie, 'user@example.com', oldCode);
    expect(withOld.json().error.code).toBe('CODE_INVALID');
    const withNew = await verify(cookie, 'user@example.com', newCode);
    expect(withNew.statusCode).toBe(200);
  });
});

describe('registration (in-place upgrade)', () => {
  it('upgrades the anonymous account in place, preserving user_id', async () => {
    const session = await newSession();
    await send(session.cookie, 'new@example.com');
    const code = mail.lastCodeFor('new@example.com')!;
    const response = await verify(session.cookie, 'new@example.com', code);

    expect(response.statusCode).toBe(200);
    expect(response.json().outcome).toBe('REGISTERED');
    expect(response.json().user.user_id).toBe(session.userId);
    expect(response.json().user).toMatchObject({
      identity_type: 'EMAIL',
      email: 'new@example.com',
      registered: true,
      free_quota_remaining: 30
    });
  });

  it('rotates the session so the old cookie stops working', async () => {
    const session = await newSession();
    await send(session.cookie, 'new@example.com');
    const verified = await verify(
      session.cookie,
      'new@example.com',
      mail.lastCodeFor('new@example.com')!
    );
    const rotated = cookieFrom(verified);
    expect(rotated).not.toBe(session.cookie);

    const withOld = await app.inject({
      method: 'GET',
      url: '/v1/free-quota',
      headers: { cookie: session.cookie }
    });
    expect(withOld.statusCode).toBe(401);

    const withNew = await app.inject({
      method: 'GET',
      url: '/v1/free-quota',
      headers: { cookie: rotated }
    });
    expect(withNew.statusCode).toBe(200);
    expect(withNew.json().user.registered).toBe(true);
  });
});

describe('login into an existing account with merge', () => {
  async function seedCharacter(ownerUserId: string, name: string): Promise<string> {
    const characterId = randomUUID();
    await database.query(
      `INSERT INTO agent_character (character_id, owner_user_id, visibility, name, status)
       VALUES ($1, $2, 'PRIVATE', $3, 'ACTIVE')`,
      [characterId, ownerUserId, name]
    );
    return characterId;
  }

  it('logs into the existing account and moves anonymous data without overwriting', async () => {
    // Target account: register email, then owns a character and burns some quota.
    const owner = await newSession();
    await send(owner.cookie, 'owner@example.com');
    await verify(owner.cookie, 'owner@example.com', mail.lastCodeFor('owner@example.com')!);
    await seedCharacter(owner.userId, 'Owner character');
    await database.query(
      `UPDATE app_user SET free_quota_remaining = 5 WHERE user_id = $1`,
      [owner.userId]
    );

    // Anonymous device with its own character logs into the same email.
    const guest = await newSession();
    await seedCharacter(guest.userId, 'Guest character');
    await clearCooldown('owner@example.com');
    await send(guest.cookie, 'owner@example.com');
    const response = await verify(
      guest.cookie,
      'owner@example.com',
      mail.lastCodeFor('owner@example.com')!
    );

    expect(response.statusCode).toBe(200);
    expect(response.json().outcome).toBe('MERGED');
    expect(response.json().user.user_id).toBe(owner.userId);

    // Both characters now belong to the target; the target keeps its own quota.
    const owned = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM agent_character WHERE owner_user_id = $1`,
      [owner.userId]
    );
    expect(owned.rows[0]?.count).toBe(2);
    const targetUser = await database.query<{ free_quota_remaining: number; status: string }>(
      `SELECT free_quota_remaining, status FROM app_user WHERE user_id = $1`,
      [owner.userId]
    );
    expect(targetUser.rows[0]?.free_quota_remaining).toBe(5);
    expect(targetUser.rows[0]?.status).toBe('ACTIVE');

    // The guest account is marked merged and can no longer own new data.
    const guestUser = await database.query<{ status: string; merged_into_user_id: string }>(
      `SELECT status, merged_into_user_id FROM app_user WHERE user_id = $1`,
      [guest.userId]
    );
    expect(guestUser.rows[0]?.status).toBe('MERGED');
    expect(guestUser.rows[0]?.merged_into_user_id).toBe(owner.userId);
  });

  it('re-running a merge is idempotent', async () => {
    const source = randomUUID();
    const target = randomUUID();
    await database.query(`INSERT INTO app_user (user_id) VALUES ($1), ($2)`, [source, target]);
    await seedCharacter(source, 'Movable');

    const first = await mergeUserData(database, source, target);
    const second = await mergeUserData(database, source, target);
    expect(first).toBe('COMPLETED');
    expect(second).toBe('ALREADY_MERGED');

    const merges = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM auth_account_merge WHERE source_user_id = $1`,
      [source]
    );
    expect(merges.rows[0]?.count).toBe(1);
    const owned = await database.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM agent_character WHERE owner_user_id = $1`,
      [target]
    );
    expect(owned.rows[0]?.count).toBe(1);
  });

  it('keeps the target relationship when both sides have one for a shared character', async () => {
    const source = randomUUID();
    const target = randomUUID();
    const platformCharacter = randomUUID();
    await database.query(`INSERT INTO app_user (user_id) VALUES ($1), ($2)`, [source, target]);
    await database.query(
      `INSERT INTO agent_character (character_id, visibility, name, status)
       VALUES ($1, 'PLATFORM', 'Shared', 'ACTIVE')`,
      [platformCharacter]
    );
    await database.query(
      `INSERT INTO agent_relationship (relationship_id, user_id, character_id, summary_text)
       VALUES ($1, $2, $3, 'target keeps this')`,
      [randomUUID(), target, platformCharacter]
    );
    await database.query(
      `INSERT INTO agent_relationship (relationship_id, user_id, character_id, summary_text)
       VALUES ($1, $2, $3, 'source loses this')`,
      [randomUUID(), source, platformCharacter]
    );

    await mergeUserData(database, source, target);

    const kept = await database.query<{ summary_text: string }>(
      `SELECT summary_text FROM agent_relationship WHERE user_id = $1 AND character_id = $2`,
      [target, platformCharacter]
    );
    expect(kept.rows[0]?.summary_text).toBe('target keeps this');
  });
});

describe('logout', () => {
  it('revokes the current session and lets a fresh anonymous identity form', async () => {
    const session = await newSession();
    const loggedOut = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie: session.cookie }
    });
    expect(loggedOut.statusCode).toBe(200);

    const withOld = await app.inject({
      method: 'GET',
      url: '/v1/free-quota',
      headers: { cookie: session.cookie }
    });
    expect(withOld.statusCode).toBe(401);

    const fresh = await app.inject({ method: 'POST', url: '/v1/identities/anonymous' });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json().user.user_id).not.toBe(session.userId);
  });
});
