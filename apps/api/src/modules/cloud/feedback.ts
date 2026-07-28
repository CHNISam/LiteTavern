import { randomUUID } from 'node:crypto';
import type { PomChatDatabase } from '@pomchat/database';
import { AppError } from '../../lib/errors.js';
import { recordCloudEvent } from './events.js';

/**
 * Alpha feedback and blocker registers.
 *
 * The repository had no feedback or issue tracker, so these are new — and kept
 * deliberately thin. There is no approval workflow, no assignment model and no
 * general-purpose state machine: 30 testers do not justify one, and the gate only
 * needs two questions answered.
 *
 *  1. Is every valid piece of feedback classified and disposed of?
 *  2. Is every blocker fixed, verified and closed?
 *
 * "Digested" is therefore a structural property, not a judgement call: a feedback row
 * is settled when it has both a category and one of the four permitted dispositions,
 * or when it is linked to the duplicate that carries them. Anything else is
 * outstanding by construction, which is what stops "反馈基本处理完毕" from ever
 * becoming the criterion.
 */

export type FeedbackCategory =
  | 'BUG'
  | 'UX'
  | 'PERFORMANCE'
  | 'CONTENT_QUALITY'
  | 'BILLING_QUOTA'
  | 'FEATURE_REQUEST'
  | 'OTHER';

export type FeedbackSeverity =
  | 'UNTRIAGED'
  | 'BLOCKER'
  | 'MAJOR'
  | 'MINOR'
  | 'ENHANCEMENT';

/** The only permitted conclusions. "Still looking at it" is not one of them. */
export type FeedbackDisposition = 'FIX_NOW' | 'DEFER' | 'REJECT' | 'OBSERVE';

/**
 * What counts as blocking. Everything outside this list — UI blemishes, low-priority
 * friction, future requests — is a normal defect: it must still be classified and
 * disposed of, but it does not hold up a release.
 */
export type BlockerType =
  | 'AUTH_FAILURE'
  | 'ALPHA_ENTRY_FAILURE'
  | 'CHAT_UNAVAILABLE'
  | 'QUOTA_MISCHARGE'
  | 'MODEL_CALL_FAILURE'
  | 'DATA_LOSS'
  | 'CROSS_USER_LEAK'
  | 'COST_RUNAWAY'
  | 'DATA_CORRUPTION';

export const BLOCKER_TYPES: readonly BlockerType[] = [
  'AUTH_FAILURE',
  'ALPHA_ENTRY_FAILURE',
  'CHAT_UNAVAILABLE',
  'QUOTA_MISCHARGE',
  'MODEL_CALL_FAILURE',
  'DATA_LOSS',
  'CROSS_USER_LEAK',
  'COST_RUNAWAY',
  'DATA_CORRUPTION'
];

export type BlockerStatus = 'OPEN' | 'RESOLVED' | 'VERIFIED' | 'CLOSED';

export interface Feedback {
  feedback_id: string;
  user_id: string | null;
  batch_no: number | null;
  title: string;
  detail: string | null;
  source: 'ALPHA_USER' | 'OPERATOR' | 'AUTOMATED';
  category: FeedbackCategory | null;
  severity: FeedbackSeverity;
  disposition: FeedbackDisposition | null;
  disposition_note: string | null;
  disposed_at: string | null;
  disposed_by: string | null;
  duplicate_of_feedback_id: string | null;
  blocker_id: string | null;
  valid: boolean;
  created_at: string;
  /** Derived: classified and disposed of, or folded into a duplicate. */
  settled: boolean;
}

const SELECT_FEEDBACK = `
  SELECT feedback_id, user_id, batch_no, title, detail, source, category,
         severity, disposition, disposition_note, disposed_at, disposed_by,
         duplicate_of_feedback_id, blocker_id, valid, created_at
  FROM alpha_feedback`;

interface FeedbackRow {
  feedback_id: string;
  user_id: string | null;
  batch_no: number | null;
  title: string;
  detail: string | null;
  source: 'ALPHA_USER' | 'OPERATOR' | 'AUTOMATED';
  category: FeedbackCategory | null;
  severity: FeedbackSeverity;
  disposition: FeedbackDisposition | null;
  disposition_note: string | null;
  disposed_at: string | null;
  disposed_by: string | null;
  duplicate_of_feedback_id: string | null;
  blocker_id: string | null;
  valid: boolean;
  created_at: string;
}

function toFeedback(row: FeedbackRow): Feedback {
  return {
    ...row,
    batch_no: row.batch_no === null ? null : Number(row.batch_no),
    settled:
      !row.valid ||
      row.duplicate_of_feedback_id !== null ||
      (row.category !== null && row.disposition !== null)
  };
}

export interface SubmitFeedbackInput {
  userId?: string | null;
  batchNo?: number | null;
  title: string;
  detail?: string | null;
  source?: 'ALPHA_USER' | 'OPERATOR' | 'AUTOMATED';
}

export async function submitFeedback(
  database: PomChatDatabase,
  input: SubmitFeedbackInput
): Promise<Feedback> {
  const feedbackId = randomUUID();
  await database.query(
    `INSERT INTO alpha_feedback (
       feedback_id, user_id, batch_no, title, detail, source
     ) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      feedbackId,
      input.userId ?? null,
      input.batchNo ?? null,
      input.title,
      input.detail ?? null,
      input.source ?? 'ALPHA_USER'
    ]
  );
  await recordCloudEvent(database, 'alpha_feedback_submitted', {
    userId: input.userId ?? null,
    properties: { batch_no: input.batchNo ?? 0, source: input.source ?? 'ALPHA_USER' }
  });
  const created = await getFeedback(database, feedbackId);
  if (!created) throw new AppError('INTERNAL_ERROR', '反馈创建失败。', 500);
  return created;
}

export async function getFeedback(
  database: PomChatDatabase,
  feedbackId: string
): Promise<Feedback | null> {
  const result = await database.query<FeedbackRow>(
    `${SELECT_FEEDBACK} WHERE feedback_id = $1`,
    [feedbackId]
  );
  return result.rows[0] ? toFeedback(result.rows[0]) : null;
}

export interface TriageFeedbackInput {
  feedbackId: string;
  category?: FeedbackCategory;
  severity?: FeedbackSeverity;
  disposition?: FeedbackDisposition;
  dispositionNote?: string;
  duplicateOfFeedbackId?: string | null;
  valid?: boolean;
  actor: string;
}

/**
 * Classifies and/or disposes of one feedback row. One call can do both, which is the
 * normal case; separating them exists only so a row can be classified now and decided
 * later without the gate treating it as done.
 */
export async function triageFeedback(
  database: PomChatDatabase,
  input: TriageFeedbackInput
): Promise<Feedback> {
  const existing = await getFeedback(database, input.feedbackId);
  if (!existing) {
    throw new AppError('RESOURCE_NOT_FOUND', '反馈不存在。', 404);
  }
  if (input.duplicateOfFeedbackId) {
    if (input.duplicateOfFeedbackId === input.feedbackId) {
      throw new AppError('VALIDATION_ERROR', '不能把反馈标记为自身的重复。', 400);
    }
    const target = await getFeedback(database, input.duplicateOfFeedbackId);
    if (!target) {
      throw new AppError('RESOURCE_NOT_FOUND', '重复目标反馈不存在。', 404);
    }
    // One level only: pointing at another duplicate would make "settled" depend on a
    // chain this program has no reason to walk.
    if (target.duplicate_of_feedback_id) {
      throw new AppError(
        'VALIDATION_ERROR',
        '重复目标本身已被标记为重复，请指向原始反馈。',
        400
      );
    }
  }

  const disposing = input.disposition !== undefined;
  await database.query(
    `UPDATE alpha_feedback
     SET category = COALESCE($2, category),
         severity = COALESCE($3, severity),
         disposition = COALESCE($4, disposition),
         disposition_note = COALESCE($5, disposition_note),
         disposed_at = CASE WHEN $6::boolean THEN CURRENT_TIMESTAMP ELSE disposed_at END,
         disposed_by = CASE WHEN $6::boolean THEN $7 ELSE disposed_by END,
         duplicate_of_feedback_id = COALESCE($8, duplicate_of_feedback_id),
         valid = COALESCE($9, valid),
         updated_at = CURRENT_TIMESTAMP
     WHERE feedback_id = $1`,
    [
      input.feedbackId,
      input.category ?? null,
      input.severity ?? null,
      input.disposition ?? null,
      input.dispositionNote ?? null,
      disposing,
      input.actor,
      input.duplicateOfFeedbackId ?? null,
      input.valid ?? null
    ]
  );

  const updated = await getFeedback(database, input.feedbackId);
  if (!updated) throw new AppError('RESOURCE_NOT_FOUND', '反馈不存在。', 404);
  if (disposing) {
    await recordCloudEvent(database, 'alpha_feedback_disposed', {
      userId: updated.user_id,
      properties: {
        disposition: updated.disposition ?? '',
        category: updated.category ?? '',
        severity: updated.severity
      }
    });
  }
  return updated;
}

export interface ListFeedbackOptions {
  batchNo?: number;
  outstandingOnly?: boolean;
  limit?: number;
}

export async function listFeedback(
  database: PomChatDatabase,
  options: ListFeedbackOptions = {}
): Promise<Feedback[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 200, 500));
  const result = await database.query<FeedbackRow>(
    `${SELECT_FEEDBACK}
     WHERE ($1::int IS NULL OR batch_no = $1::int)
       AND (
         $2::boolean IS NOT TRUE
         OR (valid = TRUE
             AND duplicate_of_feedback_id IS NULL
             AND (category IS NULL OR disposition IS NULL))
       )
     ORDER BY created_at DESC
     LIMIT $3`,
    [options.batchNo ?? null, options.outstandingOnly ?? false, limit]
  );
  return result.rows.map(toFeedback);
}

/**
 * Valid, non-duplicate feedback that is still missing a classification or a
 * disposition. This count must be 0 for the first gate to pass.
 */
export async function countOutstandingFeedback(
  database: PomChatDatabase,
  batchNo?: number
): Promise<{ outstanding: number; unclassified: number; undisposed: number; total: number }> {
  const result = await database.query<{
    outstanding: number;
    unclassified: number;
    undisposed: number;
    total: number;
  }>(
    `SELECT
       COUNT(*) FILTER (
         WHERE valid = TRUE AND duplicate_of_feedback_id IS NULL
           AND (category IS NULL OR disposition IS NULL)
       )::int AS outstanding,
       COUNT(*) FILTER (
         WHERE valid = TRUE AND duplicate_of_feedback_id IS NULL AND category IS NULL
       )::int AS unclassified,
       COUNT(*) FILTER (
         WHERE valid = TRUE AND duplicate_of_feedback_id IS NULL AND disposition IS NULL
       )::int AS undisposed,
       COUNT(*)::int AS total
     FROM alpha_feedback
     WHERE ($1::int IS NULL OR batch_no = $1::int)`,
    [batchNo ?? null]
  );
  const row = result.rows[0];
  return {
    outstanding: Number(row?.outstanding ?? 0),
    unclassified: Number(row?.unclassified ?? 0),
    undisposed: Number(row?.undisposed ?? 0),
    total: Number(row?.total ?? 0)
  };
}

// ===== Blockers =====

export interface Blocker {
  blocker_id: string;
  batch_no: number | null;
  blocker_type: BlockerType;
  title: string;
  detail: string | null;
  status: BlockerStatus;
  detection_source: 'OPERATOR' | 'ALPHA_USER' | 'AUTOMATED';
  user_id: string | null;
  feedback_id: string | null;
  first_detected_at: string;
  last_detected_at: string;
  recurrence_count: number;
  resolved_at: string | null;
  verified_at: string | null;
  closed_at: string | null;
}

const SELECT_BLOCKER = `
  SELECT blocker_id, batch_no, blocker_type, title, detail, status,
         detection_source, user_id, feedback_id, first_detected_at,
         last_detected_at, recurrence_count, resolved_at, verified_at, closed_at
  FROM alpha_blocker`;

function toBlocker(row: Blocker & { batch_no: number | null }): Blocker {
  return {
    ...row,
    batch_no: row.batch_no === null ? null : Number(row.batch_no),
    recurrence_count: Number(row.recurrence_count)
  };
}

export interface RecordBlockerInput {
  blockerType: BlockerType;
  title: string;
  detail?: string | null;
  batchNo?: number | null;
  userId?: string | null;
  feedbackId?: string | null;
  detectionSource?: 'OPERATOR' | 'ALPHA_USER' | 'AUTOMATED';
  detectedBy?: string;
  /** Re-open this specific blocker instead of creating a new one. */
  recurrenceOf?: string;
}

/**
 * Records a blocker, or a recurrence of one.
 *
 * A recurrence deliberately reuses the original row and moves `last_detected_at`
 * forward instead of creating a fresh issue. That single timestamp is what the
 * consecutive-stable-session counter measures from, so a closed issue coming back
 * resets that counter automatically — no separate bookkeeping, and no way to hide a
 * regression by filing it as a new low-priority bug.
 */
export async function recordBlocker(
  database: PomChatDatabase,
  input: RecordBlockerInput
): Promise<Blocker> {
  if (input.recurrenceOf) {
    const existing = await getBlocker(database, input.recurrenceOf);
    if (!existing) {
      throw new AppError('RESOURCE_NOT_FOUND', '阻断问题不存在。', 404);
    }
    await database.query(
      `UPDATE alpha_blocker
       SET status = 'OPEN',
           last_detected_at = CURRENT_TIMESTAMP,
           recurrence_count = recurrence_count + 1,
           resolved_at = NULL, verified_at = NULL, closed_at = NULL,
           updated_at = CURRENT_TIMESTAMP
       WHERE blocker_id = $1`,
      [input.recurrenceOf]
    );
    await recordCloudEvent(database, 'alpha_blocker_detected', {
      userId: input.userId ?? null,
      properties: {
        blocker_id: input.recurrenceOf,
        blocker_type: existing.blocker_type,
        recurrence: true
      }
    });
    const reopened = await getBlocker(database, input.recurrenceOf);
    if (!reopened) throw new AppError('RESOURCE_NOT_FOUND', '阻断问题不存在。', 404);
    return reopened;
  }

  const blockerId = randomUUID();
  await database.query(
    `INSERT INTO alpha_blocker (
       blocker_id, batch_no, blocker_type, title, detail,
       detection_source, detected_by, user_id, feedback_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      blockerId,
      input.batchNo ?? null,
      input.blockerType,
      input.title,
      input.detail ?? null,
      input.detectionSource ?? 'OPERATOR',
      input.detectedBy ?? null,
      input.userId ?? null,
      input.feedbackId ?? null
    ]
  );
  if (input.feedbackId) {
    await database.query(
      `UPDATE alpha_feedback
       SET blocker_id = $2, severity = 'BLOCKER', updated_at = CURRENT_TIMESTAMP
       WHERE feedback_id = $1`,
      [input.feedbackId, blockerId]
    );
  }
  await recordCloudEvent(database, 'alpha_blocker_detected', {
    userId: input.userId ?? null,
    properties: {
      blocker_id: blockerId,
      blocker_type: input.blockerType,
      recurrence: false
    }
  });
  const created = await getBlocker(database, blockerId);
  if (!created) throw new AppError('INTERNAL_ERROR', '阻断问题创建失败。', 500);
  return created;
}

export async function getBlocker(
  database: PomChatDatabase,
  blockerId: string
): Promise<Blocker | null> {
  const result = await database.query<Blocker>(
    `${SELECT_BLOCKER} WHERE blocker_id = $1`,
    [blockerId]
  );
  return result.rows[0] ? toBlocker(result.rows[0]) : null;
}

export type BlockerTransition = 'RESOLVE' | 'VERIFY' | 'CLOSE';

/**
 * Walks a blocker towards closure. The order is enforced: a blocker must be resolved
 * before it can be verified and verified before it can be closed, which is what makes
 * "fixed, verified and closed" a checkable claim rather than a label an operator can
 * apply in one click.
 */
export async function transitionBlocker(
  database: PomChatDatabase,
  input: { blockerId: string; transition: BlockerTransition; actor: string }
): Promise<Blocker> {
  const existing = await getBlocker(database, input.blockerId);
  if (!existing) {
    throw new AppError('RESOURCE_NOT_FOUND', '阻断问题不存在。', 404);
  }

  if (input.transition === 'RESOLVE') {
    if (existing.status !== 'OPEN') {
      throw new AppError('VALIDATION_ERROR', '只有未解决的阻断问题可以标记为已修复。', 409);
    }
    await database.query(
      `UPDATE alpha_blocker
       SET status = 'RESOLVED', resolved_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE blocker_id = $1`,
      [input.blockerId]
    );
  } else if (input.transition === 'VERIFY') {
    if (existing.status !== 'RESOLVED') {
      throw new AppError('VALIDATION_ERROR', '请先将阻断问题标记为已修复，再进行验证。', 409);
    }
    await database.query(
      `UPDATE alpha_blocker
       SET status = 'VERIFIED', verified_at = CURRENT_TIMESTAMP,
           verified_by = $2, updated_at = CURRENT_TIMESTAMP
       WHERE blocker_id = $1`,
      [input.blockerId, input.actor]
    );
  } else {
    if (existing.status !== 'VERIFIED') {
      throw new AppError('VALIDATION_ERROR', '请先验证修复结果，再关闭阻断问题。', 409);
    }
    await database.query(
      `UPDATE alpha_blocker
       SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE blocker_id = $1`,
      [input.blockerId]
    );
    await recordCloudEvent(database, 'alpha_blocker_resolved', {
      userId: existing.user_id,
      properties: {
        blocker_id: input.blockerId,
        blocker_type: existing.blocker_type,
        recurrence_count: existing.recurrence_count
      }
    });
  }

  const updated = await getBlocker(database, input.blockerId);
  if (!updated) throw new AppError('RESOURCE_NOT_FOUND', '阻断问题不存在。', 404);
  return updated;
}

export async function listBlockers(
  database: PomChatDatabase,
  options: { unresolvedOnly?: boolean; limit?: number } = {}
): Promise<Blocker[]> {
  const limit = Math.max(1, Math.min(options.limit ?? 200, 500));
  const result = await database.query<Blocker>(
    `${SELECT_BLOCKER}
     WHERE ($1::boolean IS NOT TRUE OR status <> 'CLOSED')
     ORDER BY last_detected_at DESC
     LIMIT $2`,
    [options.unresolvedOnly ?? false, limit]
  );
  return result.rows.map(toBlocker);
}

export async function countUnresolvedBlockers(
  database: PomChatDatabase
): Promise<number> {
  const result = await database.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM alpha_blocker WHERE status <> 'CLOSED'`
  );
  return Number(result.rows[0]?.count ?? 0);
}

/**
 * When a blocker was last seen, closed or not. Everything after this instant is
 * "stability observed since the last blocking failure", which is exactly the window
 * the consecutive-core-session gate counts over.
 */
export async function lastBlockerOccurrence(
  database: PomChatDatabase
): Promise<string | null> {
  const result = await database.query<{ last_detected_at: string | null }>(
    `SELECT MAX(last_detected_at) AS last_detected_at FROM alpha_blocker`
  );
  return result.rows[0]?.last_detected_at ?? null;
}
