import { beforeEach, describe, expect, it } from 'vitest';

import type { Character, Message } from './api';
import {
  ChatRepository,
  repositoryPartition,
  type ClientTurnOutboxRecord
} from './chat-repository';

const DB_NAME = 'litetavern-chat-repository-test';

const CHARACTER: Character = {
  character_id: 'character-1',
  name: 'March',
  profile_summary: 'An archivist.',
  personality_summary: 'Warm.',
  first_message: 'Ready?',
  avatar_seed: 'march'
};

const MESSAGES: Message[] = [
  {
    message_id: 'message-1',
    role: 'USER',
    content_text: 'Ready.',
    status: 'COMPLETED'
  }
];

beforeEach(async () => {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
});

describe('ChatRepository partitions', () => {
  it('creates, updates and deletes a character inside only the selected partition', async () => {
    const guest = repositoryPartition({ environment: 'local', principal: 'guest:device-1' });
    const account = repositoryPartition({ environment: 'local', principal: 'account:reader' });
    const repository = new ChatRepository(DB_NAME);
    await repository.putCharacter(guest, CHARACTER);
    await repository.putCharacter(guest, { ...CHARACTER, name: 'March 8th' });
    await expect(repository.getCharacter(guest, CHARACTER.character_id))
      .resolves.toMatchObject({ name: 'March 8th' });
    await expect(repository.getCharacter(account, CHARACTER.character_id)).resolves.toBeNull();
    await repository.deleteCharacter(guest, CHARACTER.character_id);
    await expect(repository.listCharacters(guest)).resolves.toEqual([]);
    await repository.release();
  });

  it('persists a guest conversation and transcript across repository instances', async () => {
    const partition = repositoryPartition({
      environment: 'http://127.0.0.1:8787',
      principal: 'guest:device-1'
    });
    const first = new ChatRepository(DB_NAME);
    await first.replaceCharacters(partition, [CHARACTER]);
    const conversation = await first.openConversation(partition, {
      conversationId: 'local-conversation-1',
      characterId: CHARACTER.character_id,
      source: 'LOCAL'
    });
    await first.replaceMessages(partition, conversation.conversationId, MESSAGES);
    first.close();

    const reopened = new ChatRepository(DB_NAME);
    await expect(reopened.listCharacters(partition)).resolves.toEqual([CHARACTER]);
    await expect(
      reopened.findConversation(partition, CHARACTER.character_id, 'LOCAL')
    ).resolves.toMatchObject({ conversationId: 'local-conversation-1' });
    await expect(
      reopened.listMessages(partition, conversation.conversationId)
    ).resolves.toEqual(MESSAGES);
    reopened.close();
  });

  it('never leaks guest data into an account partition', async () => {
    const guest = repositoryPartition({
      environment: 'https://cloud.example',
      principal: 'guest:device-1'
    });
    const account = repositoryPartition({
      environment: 'https://cloud.example',
      principal: 'account:account-1'
    });
    const repository = new ChatRepository(DB_NAME);
    await repository.replaceCharacters(guest, [CHARACTER]);
    await repository.openConversation(guest, {
      conversationId: 'guest-conversation',
      characterId: CHARACTER.character_id,
      source: 'LOCAL'
    });

    await expect(repository.listCharacters(account)).resolves.toEqual([]);
    await expect(
      repository.findConversation(account, CHARACTER.character_id, 'LOCAL')
    ).resolves.toBeNull();
    repository.close();
  });

  it('does not reuse a Cloud conversation across environments or data sources', async () => {
    const development = repositoryPartition({
      environment: 'https://dev-cloud.example',
      principal: 'account:account-1'
    });
    const staging = repositoryPartition({
      environment: 'https://staging-cloud.example',
      principal: 'account:account-1'
    });
    const repository = new ChatRepository(DB_NAME);
    await repository.openConversation(development, {
      conversationId: 'cloud-conversation-1',
      characterId: CHARACTER.character_id,
      source: 'CLOUD'
    });

    await expect(
      repository.findConversation(staging, CHARACTER.character_id, 'CLOUD')
    ).resolves.toBeNull();
    await expect(
      repository.findConversation(development, CHARACTER.character_id, 'LOCAL')
    ).resolves.toBeNull();
    repository.close();
  });
});

describe('client-turn outbox', () => {
  it('keeps a stable mutation pending and records conflicts without dropping it', async () => {
    const partition = repositoryPartition({
      environment: 'https://cloud.example',
      principal: 'account:account-1'
    });
    const repository = new ChatRepository(DB_NAME);
    const record: ClientTurnOutboxRecord = {
      mutationId: 'mutation-1',
      conversationId: 'conversation-1',
      baseHeadId: 'head-1',
      user: { messageId: 'client-user-1', contentText: 'Hello' },
      assistants: [],
      status: 'PENDING',
      createdAt: '2026-08-09T00:00:00.000Z'
    };

    await repository.enqueueClientTurn(partition, record);
    await repository.markClientTurnConflict(partition, record.mutationId);

    await expect(repository.listClientTurnOutbox(partition)).resolves.toEqual([
      { ...record, status: 'CONFLICT_PENDING' }
    ]);
    repository.close();
  });
});
