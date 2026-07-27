import type { PomChatDatabase } from '@pomchat/database';

export interface AnalyticsOverviewOptions {
  from: string;
  to: string;
  effectiveChatTurns?: number;
}

interface CompletedTurnRow {
  user_id: string;
  character_id: string;
  completed_at: string;
  client_session_id: string | null;
}

const configuredEffectiveChatTurns = Number(
  process.env.ANALYTICS_EFFECTIVE_CHAT_TURNS ?? 3
);
export const DEFAULT_EFFECTIVE_CHAT_TURNS =
  Number.isInteger(configuredEffectiveChatTurns) &&
  configuredEffectiveChatTurns > 0
    ? configuredEffectiveChatTurns
    : 3;

function utcDay(value: string): number {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function dayDifference(later: string, earlier: string): number {
  return Math.round((utcDay(later) - utcDay(earlier)) / 86_400_000);
}

export async function getAnalyticsOverview(
  database: PomChatDatabase,
  options: AnalyticsOverviewOptions
) {
  const from = new Date(options.from);
  const to = new Date(options.to);
  if (
    Number.isNaN(from.getTime()) ||
    Number.isNaN(to.getTime()) ||
    from >= to
  ) {
    throw new Error('Analytics range must contain valid from/to timestamps.');
  }
  const effectiveChatTurns =
    options.effectiveChatTurns ?? DEFAULT_EFFECTIVE_CHAT_TURNS;
  if (!Number.isInteger(effectiveChatTurns) || effectiveChatTurns < 1) {
    throw new Error('effectiveChatTurns must be a positive integer.');
  }

  const users = await database.query<{
    user_id: string;
    source_channel: string;
    campaign_id: string | null;
  }>(
    `SELECT user_id,
            COALESCE(first_source_channel, 'direct') AS source_channel,
            first_campaign_id AS campaign_id
     FROM app_user
     WHERE created_at >= $1 AND created_at < $2
       AND status <> 'DELETED'`,
    [options.from, options.to]
  );

  const turns = await database.query<CompletedTurnRow>(
    `SELECT g.user_id, c.character_id, g.completed_at,
            g.client_session_id
     FROM agent_generation_request g
     JOIN chat_conversation c ON c.conversation_id = g.conversation_id
     WHERE g.status = 'COMPLETED'
       AND g.completed_at IS NOT NULL
       AND g.completed_at < $1
       AND EXISTS (
         SELECT 1 FROM chat_message a
         WHERE a.generation_request_id = g.generation_request_id
           AND a.role = 'ASSISTANT'
           AND a.status = 'COMPLETED'
       )
     ORDER BY g.user_id, g.completed_at`,
    [options.to]
  );

  const turnsByUser = new Map<string, CompletedTurnRow[]>();
  for (const turn of turns.rows) {
    const list = turnsByUser.get(turn.user_id) ?? [];
    list.push(turn);
    turnsByUser.set(turn.user_id, list);
  }

  const newUserIds = new Set(users.rows.map((user) => user.user_id));
  const activatedUserIds = new Set(
    [...turnsByUser.keys()].filter((userId) => newUserIds.has(userId))
  );
  const channelMap = new Map<
    string,
    {
      sourceChannel: string;
      campaignId: string | null;
      newUsers: number;
      activatedUsers: number;
      activationRate: number;
    }
  >();
  for (const user of users.rows) {
    const key = `${user.source_channel}\u0000${user.campaign_id ?? ''}`;
    const bucket = channelMap.get(key) ?? {
      sourceChannel: user.source_channel,
      campaignId: user.campaign_id,
      newUsers: 0,
      activatedUsers: 0,
      activationRate: 0
    };
    bucket.newUsers += 1;
    if (activatedUserIds.has(user.user_id)) bucket.activatedUsers += 1;
    channelMap.set(key, bucket);
  }
  for (const bucket of channelMap.values()) {
    bucket.activationRate =
      bucket.newUsers === 0 ? 0 : bucket.activatedUsers / bucket.newUsers;
  }

  let d1ContinuedUsers = 0;
  let d1SameCharacterUsers = 0;
  let d7ContinuedUsers = 0;
  let d7SameCharacterUsers = 0;
  for (const userId of activatedUserIds) {
    const userTurns = turnsByUser.get(userId) ?? [];
    const first = userTurns[0];
    if (!first) continue;
    const d1 = userTurns.filter(
      (turn) => dayDifference(turn.completed_at, first.completed_at) === 1
    );
    const d7 = userTurns.filter(
      (turn) => dayDifference(turn.completed_at, first.completed_at) === 7
    );
    if (d1.length > 0) d1ContinuedUsers += 1;
    if (d1.some((turn) => turn.character_id === first.character_id)) {
      d1SameCharacterUsers += 1;
    }
    if (d7.length > 0) d7ContinuedUsers += 1;
    if (d7.some((turn) => turn.character_id === first.character_id)) {
      d7SameCharacterUsers += 1;
    }
  }

  const effectiveUsers = new Set<string>();
  const effectivePoints = new Map<
    string,
    { at: string; sessionId: string | null }
  >();
  for (const [userId, userTurns] of turnsByUser) {
    const byCharacter = new Map<string, CompletedTurnRow[]>();
    for (const turn of userTurns) {
      const list = byCharacter.get(turn.character_id) ?? [];
      list.push(turn);
      byCharacter.set(turn.character_id, list);
    }
    for (const [characterId, characterTurns] of byCharacter) {
      const effectiveTurn = characterTurns[effectiveChatTurns - 1];
      if (!effectiveTurn) continue;
      effectiveUsers.add(userId);
      effectivePoints.set(`${userId}\u0000${characterId}`, {
        at: effectiveTurn.completed_at,
        sessionId: effectiveTurn.client_session_id
      });
    }
  }

  const revisitUsers = new Set<string>();
  for (const [key, point] of effectivePoints) {
    const [userId, characterId] = key.split('\u0000') as [string, string];
    const later = (turnsByUser.get(userId) ?? []).some(
      (turn) =>
        turn.character_id === characterId &&
        new Date(turn.completed_at) > new Date(point.at) &&
        (dayDifference(turn.completed_at, point.at) > 0 ||
          (turn.client_session_id !== null &&
            point.sessionId !== null &&
            turn.client_session_id !== point.sessionId))
    );
    if (later) revisitUsers.add(userId);
  }

  const eventRows = await database.query<{
    session_id: string;
    event_name: string;
    page_name: string | null;
    occurred_at: string;
    properties_json: Record<string, unknown>;
  }>(
    `SELECT session_id, event_name, page_name, occurred_at, properties_json
     FROM analytics_event
     WHERE occurred_at >= $1 AND occurred_at < $2
       AND session_id IS NOT NULL
       AND event_name IN ('page_view', 'critical_action')
     ORDER BY session_id, occurred_at, event_id`,
    [options.from, options.to]
  );

  const sessionMap = new Map<
    string,
    {
      sessionId: string;
      pageViewCount: number;
      maxPageDepth: number;
      interactionCount: number;
      pages: string[];
    }
  >();
  for (const event of eventRows.rows) {
    const session = sessionMap.get(event.session_id) ?? {
      sessionId: event.session_id,
      pageViewCount: 0,
      maxPageDepth: 0,
      interactionCount: 0,
      pages: []
    };
    if (event.event_name === 'page_view' && event.page_name) {
      session.pageViewCount += 1;
      session.maxPageDepth = Math.max(
        session.maxPageDepth,
        Number(event.properties_json.page_depth ?? 0)
      );
      session.pages.push(event.page_name);
    } else if (event.event_name === 'critical_action') {
      session.interactionCount += 1;
    }
    sessionMap.set(event.session_id, session);
  }

  const pageMap = new Map<
    string,
    {
      pageName: string;
      enteredSessions: Set<string>;
      exitedSessions: Set<string>;
      nextCorePageSessions: Set<string>;
    }
  >();
  for (const session of sessionMap.values()) {
    session.pages.forEach((pageName, index) => {
      const page = pageMap.get(pageName) ?? {
        pageName,
        enteredSessions: new Set<string>(),
        exitedSessions: new Set<string>(),
        nextCorePageSessions: new Set<string>()
      };
      page.enteredSessions.add(session.sessionId);
      if (index === session.pages.length - 1) {
        page.exitedSessions.add(session.sessionId);
      }
      if (session.pages[index + 1]) {
        page.nextCorePageSessions.add(session.sessionId);
      }
      pageMap.set(pageName, page);
    });
  }

  return {
    range: {
      from: from.toISOString(),
      to: to.toISOString(),
      timezone: 'UTC',
      effectiveChatTurns
    },
    newUsers: {
      total: users.rows.length,
      anonymousAndRegisteredDeduplicatedByUserId: true
    },
    channels: [...channelMap.values()],
    activation: {
      activatedUsers: activatedUserIds.size,
      activationRate:
        users.rows.length === 0 ? 0 : activatedUserIds.size / users.rows.length
    },
    effectiveChat: {
      effectiveUsers: effectiveUsers.size,
      sameCharacterRevisits: revisitUsers.size
    },
    retention: {
      d1ContinuedUsers,
      d1SameCharacterUsers,
      d7ContinuedUsers,
      d7SameCharacterUsers
    },
    sessions: [...sessionMap.values()].map((session) => ({
      sessionId: session.sessionId,
      pageViewCount: session.pageViewCount,
      maxPageDepth: session.maxPageDepth,
      interactionCount: session.interactionCount
    })),
    pages: [...pageMap.values()].map((page) => ({
      pageName: page.pageName,
      enteredSessions: page.enteredSessions.size,
      exitedSessions: page.exitedSessions.size,
      nextCorePageConversionRate:
        page.enteredSessions.size === 0
          ? 0
          : page.nextCorePageSessions.size / page.enteredSessions.size
    }))
  };
}
