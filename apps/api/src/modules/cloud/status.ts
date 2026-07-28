import type { PomChatDatabase } from '@pomchat/database';
import type { IdentityContext } from '../identity.js';
import type { CloudConfig } from './config.js';
import {
  ensureMembership,
  isFoundingSupporter,
  readBatchPolicy,
  type Membership
} from './membership.js';
import { resolveQuota, type QuotaSnapshot } from './quota.js';

/**
 * The one payload the client needs to render honest service state: who the user is,
 * where they are in the program, which pool is currently paying for replies, how much
 * of it is left, and what they can do next. Every string the UI shows about quota or
 * stage comes from here — nothing about entitlements is hardcoded in the browser.
 */

export type CloudNextAction =
  | 'START_CHATTING'
  | 'REGISTER'
  | 'JOIN_WAITLIST'
  | 'WAIT_FOR_ALPHA'
  | 'USE_BYOK'
  | 'SUPPORT_LITETAVERN';

export interface CloudStatus {
  stage: CloudConfig['stage'];
  /** False when the hosted model path is off; local + BYOK still work. */
  platform_models_available: boolean;
  identity_type: 'ANONYMOUS' | 'EMAIL';
  registered: boolean;
  membership_status: Membership['status'];
  on_waitlist: boolean;
  waitlist_joined_at: string | null;
  alpha_active: boolean;
  alpha_batch_id: string | null;
  alpha_grant_source: Membership['grantSource'];
  founding_supporter: boolean;
  quota: {
    source: QuotaSnapshot['source'];
    total: number;
    used: number;
    reserved: number;
    available: number;
    remaining_ratio: number;
    cycle_no: number | null;
    cycle_starts_at: string | null;
    cycle_ends_at: string | null;
  };
  support: {
    enabled: boolean;
    url: string;
    headline: string;
    body: string;
  };
  next_actions: CloudNextAction[];
}

function nextActions(
  membership: Membership,
  quota: QuotaSnapshot,
  supportEnabled: boolean
): CloudNextAction[] {
  const actions: CloudNextAction[] = [];
  const hasQuota = quota.source !== 'NONE' && quota.available > 0;
  if (hasQuota) actions.push('START_CHATTING');

  if (membership.status === 'ANONYMOUS_TRIAL') {
    actions.push('REGISTER');
  } else if (membership.status === 'REGISTERED_WAITLIST') {
    // A registered user who somehow has no waitlist timestamp can still join;
    // otherwise the honest next step is simply waiting.
    actions.push(membership.waitlistJoinedAt ? 'WAIT_FOR_ALPHA' : 'JOIN_WAITLIST');
  }

  if (!hasQuota) actions.push('USE_BYOK');
  if (supportEnabled) actions.push('SUPPORT_LITETAVERN');
  return actions;
}

export async function getCloudStatus(
  database: PomChatDatabase,
  config: CloudConfig,
  identity: IdentityContext
): Promise<CloudStatus> {
  const membership = await ensureMembership(
    database,
    identity.userId,
    identity.registered
  );
  const policy = membership.batchId
    ? await readBatchPolicy(database, membership.batchId, config.defaultAlphaPolicy)
    : config.defaultAlphaPolicy;

  const quota = await resolveQuota(database, {
    userId: identity.userId,
    membershipStatus: membership.status,
    policy,
    trialEnabled: config.trialEnabled
  });
  const supporter = await isFoundingSupporter(database, identity.userId);

  return {
    stage: config.stage,
    platform_models_available: config.trialEnabled,
    identity_type: identity.registered ? 'EMAIL' : 'ANONYMOUS',
    registered: identity.registered,
    membership_status: membership.status,
    on_waitlist: membership.status === 'REGISTERED_WAITLIST',
    waitlist_joined_at: membership.waitlistJoinedAt,
    alpha_active: membership.status === 'ALPHA_ACTIVE',
    alpha_batch_id: membership.batchId,
    alpha_grant_source: membership.grantSource,
    founding_supporter: supporter,
    quota: {
      source: quota.source,
      total: quota.total,
      used: quota.used,
      reserved: quota.reserved,
      available: quota.available,
      remaining_ratio: quota.remainingRatio,
      cycle_no: quota.cycleNo,
      cycle_starts_at: quota.cycleStartsAt,
      cycle_ends_at: quota.cycleEndsAt
    },
    support: {
      enabled: config.support.enabled && config.support.url.length > 0,
      url: config.support.url,
      headline: config.support.headline,
      body: config.support.body
    },
    next_actions: nextActions(
      membership,
      quota,
      config.support.enabled && config.support.url.length > 0
    )
  };
}
