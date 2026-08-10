import type { ChatRepository, ClientTurnOutboxRecord } from './chat-repository';

export interface ClientTurnPushBody {
  mutation_id: string;
  base_head_id: string | null;
  user: { message_id: string; content_text: string };
  assistants: Array<{
    message_id: string;
    content_text: string;
    status: 'COMPLETED' | 'INCOMPLETE';
  }>;
}

export type ClientTurnSender = (
  conversationId: string,
  body: ClientTurnPushBody
) => Promise<{ current_head_id?: string }>;

function pushBody(record: ClientTurnOutboxRecord): ClientTurnPushBody {
  return {
    mutation_id: record.mutationId,
    base_head_id: record.baseHeadId,
    user: {
      message_id: record.user.messageId,
      content_text: record.user.contentText
    },
    assistants: record.assistants.map((message) => ({
      message_id: message.messageId,
      content_text: message.contentText,
      status: message.status
    }))
  };
}

function statusOf(reason: unknown): number | undefined {
  return reason && typeof reason === 'object' && 'status' in reason
    ? Number((reason as { status?: unknown }).status)
    : undefined;
}

export async function flushClientTurnOutbox(
  repository: Pick<ChatRepository,
    'listClientTurnOutbox' | 'removeClientTurn' | 'markClientTurnConflict'>,
  partition: string,
  send: ClientTurnSender
): Promise<{
  synced: number;
  conflicts: number;
  pending: number;
  latestHeadId: string | null;
}> {
  let synced = 0;
  let conflicts = 0;
  let latestHeadId: string | null = null;
  const records = await repository.listClientTurnOutbox(partition);

  for (const record of records) {
    if (record.status !== 'PENDING') continue;
    try {
      const response = await send(record.conversationId, pushBody(record));
      latestHeadId = response.current_head_id ?? latestHeadId;
      await repository.removeClientTurn(partition, record.mutationId);
      synced += 1;
    } catch (reason) {
      if (statusOf(reason) === 409) {
        await repository.markClientTurnConflict(partition, record.mutationId);
        conflicts += 1;
      }
      // Mutations are ordered by their base head. Once one cannot land, later
      // records must wait for the missing mutation or an explicit reconciliation.
      break;
    }
  }

  const remaining = await repository.listClientTurnOutbox(partition);
  return {
    synced,
    conflicts,
    pending: remaining.filter((record) => record.status === 'PENDING').length,
    latestHeadId
  };
}
