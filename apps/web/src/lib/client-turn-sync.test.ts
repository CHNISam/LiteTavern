import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  chatRepository,
  repositoryPartition,
  resetChatRepositoryForTests,
  type ClientTurnOutboxRecord
} from './chat-repository';
import { flushClientTurnOutbox } from './client-turn-sync';

const partition = repositoryPartition({
  environment: 'https://client.test',
  principal: 'account:account-1'
});

function record(mutationId: string): ClientTurnOutboxRecord {
  return {
    mutationId,
    conversationId: 'conversation-1',
    baseHeadId: 'head-1',
    user: { messageId: `user-${mutationId}`, contentText: 'private prompt' },
    assistants: [{
      messageId: `assistant-${mutationId}`,
      contentText: 'final reply',
      status: 'COMPLETED'
    }],
    status: 'PENDING',
    createdAt: '2026-08-09T00:00:00.000Z'
  };
}

afterEach(resetChatRepositoryForTests);

describe('flushClientTurnOutbox', () => {
  it('replays pending account turns and removes them only after Cloud accepts them', async () => {
    await chatRepository.enqueueClientTurn(partition, record('mutation-1'));
    const send = vi.fn().mockResolvedValue({ current_head_id: 'head-2' });

    const result = await flushClientTurnOutbox(chatRepository, partition, send);

    expect(send).toHaveBeenCalledWith('conversation-1', {
      mutation_id: 'mutation-1',
      base_head_id: 'head-1',
      user: { message_id: 'user-mutation-1', content_text: 'private prompt' },
      assistants: [{
        message_id: 'assistant-mutation-1',
        content_text: 'final reply',
        status: 'COMPLETED'
      }]
    });
    expect(result).toEqual({ synced: 1, conflicts: 0, pending: 0, latestHeadId: 'head-2' });
    expect(await chatRepository.listClientTurnOutbox(partition)).toEqual([]);
  });

  it('keeps head conflicts for explicit reconciliation and does not retry them', async () => {
    await chatRepository.enqueueClientTurn(partition, record('mutation-1'));
    const conflict = Object.assign(new Error('head mismatch'), { status: 409 });
    const send = vi.fn().mockRejectedValue(conflict);

    expect(await flushClientTurnOutbox(chatRepository, partition, send)).toMatchObject({
      synced: 0,
      conflicts: 1,
      pending: 0
    });
    expect((await chatRepository.listClientTurnOutbox(partition))[0]?.status)
      .toBe('CONFLICT_PENDING');

    send.mockClear();
    await flushClientTurnOutbox(chatRepository, partition, send);
    expect(send).not.toHaveBeenCalled();
  });
});
