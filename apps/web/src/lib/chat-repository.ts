import type { Character, Message } from './api';

export const CHAT_REPOSITORY_DB_NAME = 'litetavern-chat-v1';

const STORES = {
  characters: 'characters',
  conversations: 'conversations',
  messages: 'messages',
  outbox: 'outbox'
} as const;

export type ConversationSource = 'LOCAL' | 'CLOUD';
export type RepositoryPrincipal = `guest:${string}` | `account:${string}`;

export interface RepositoryPartitionInput {
  environment: string;
  principal: RepositoryPrincipal;
}

export function repositoryPartition(input: RepositoryPartitionInput): string {
  return JSON.stringify([input.environment, input.principal]);
}

export interface StoredConversation {
  conversationId: string;
  characterId: string;
  source: ConversationSource;
}

export interface ClientTurnOutboxRecord {
  mutationId: string;
  conversationId: string;
  baseHeadId: string | null;
  user: { messageId: string; contentText: string };
  assistants: Array<{
    messageId: string;
    contentText: string;
    status: 'COMPLETED' | 'INCOMPLETE';
  }>;
  status: 'PENDING' | 'CONFLICT_PENDING';
  createdAt: string;
}

interface CharacterRecord {
  key: string;
  partition: string;
  characterId: string;
  value: Character;
}

interface ConversationRecord extends StoredConversation {
  key: string;
  partition: string;
}

interface MessageRecord {
  key: string;
  partition: string;
  conversationId: string;
  sequence: number;
  value: Message;
}

interface OutboxRecord {
  key: string;
  partition: string;
  mutationId: string;
  value: ClientTurnOutboxRecord;
}

function key(...parts: string[]): string {
  return JSON.stringify(parts);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export class ChatRepository {
  private databasePromise: Promise<IDBDatabase> | null = null;

  constructor(private readonly databaseName = CHAT_REPOSITORY_DB_NAME) {}

  private database(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    this.databasePromise = new Promise((resolve, reject) => {
      const open = indexedDB.open(this.databaseName, 1);
      open.onupgradeneeded = () => {
        const database = open.result;
        const characters = database.createObjectStore(STORES.characters, { keyPath: 'key' });
        characters.createIndex('partition', 'partition');
        const conversations = database.createObjectStore(STORES.conversations, { keyPath: 'key' });
        conversations.createIndex(
          'partition_character_source',
          ['partition', 'characterId', 'source'],
          { unique: true }
        );
        const messages = database.createObjectStore(STORES.messages, { keyPath: 'key' });
        messages.createIndex('partition_conversation', ['partition', 'conversationId']);
        const outbox = database.createObjectStore(STORES.outbox, { keyPath: 'key' });
        outbox.createIndex('partition', 'partition');
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    return this.databasePromise;
  }

  close(): void {
    void this.release();
  }

  async release(): Promise<void> {
    const pending = this.databasePromise;
    this.databasePromise = null;
    const database = await pending;
    database?.close();
  }

  async replaceCharacters(partition: string, characters: Character[]): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(STORES.characters, 'readwrite');
    const store = transaction.objectStore(STORES.characters);
    const existing = await requestResult(
      store.index('partition').getAll(IDBKeyRange.only(partition))
    ) as CharacterRecord[];
    for (const record of existing) store.delete(record.key);
    for (const character of characters) {
      store.put({
        key: key(partition, character.character_id),
        partition,
        characterId: character.character_id,
        value: character
      } satisfies CharacterRecord);
    }
    await transactionDone(transaction);
  }

  async listCharacters(partition: string): Promise<Character[]> {
    const database = await this.database();
    const transaction = database.transaction(STORES.characters, 'readonly');
    const records = await requestResult(
      transaction.objectStore(STORES.characters)
        .index('partition')
        .getAll(IDBKeyRange.only(partition))
    ) as CharacterRecord[];
    return records.map((record) => record.value);
  }

  async getCharacter(partition: string, characterId: string): Promise<Character | null> {
    const database = await this.database();
    const transaction = database.transaction(STORES.characters, 'readonly');
    const record = await requestResult(
      transaction.objectStore(STORES.characters).get(key(partition, characterId))
    ) as CharacterRecord | undefined;
    return record?.value ?? null;
  }

  async putCharacter(partition: string, character: Character): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(STORES.characters, 'readwrite');
    transaction.objectStore(STORES.characters).put({
      key: key(partition, character.character_id), partition,
      characterId: character.character_id, value: character
    } satisfies CharacterRecord);
    await transactionDone(transaction);
  }

  async deleteCharacter(partition: string, characterId: string): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(
      [STORES.characters, STORES.conversations, STORES.messages], 'readwrite'
    );
    transaction.objectStore(STORES.characters).delete(key(partition, characterId));
    const conversations = await requestResult(
      transaction.objectStore(STORES.conversations)
        .index('partition_character_source').getAll(
          IDBKeyRange.bound([partition, characterId, ''], [partition, characterId, '\uffff'])
        )
    ) as ConversationRecord[];
    const messageStore = transaction.objectStore(STORES.messages);
    for (const conversation of conversations) {
      const messages = await requestResult(messageStore.index('partition_conversation')
        .getAll(IDBKeyRange.only([partition, conversation.conversationId]))) as MessageRecord[];
      for (const message of messages) messageStore.delete(message.key);
      transaction.objectStore(STORES.conversations).delete(conversation.key);
    }
    await transactionDone(transaction);
  }

  async openConversation(
    partition: string,
    conversation: StoredConversation
  ): Promise<StoredConversation> {
    const database = await this.database();
    const transaction = database.transaction(STORES.conversations, 'readwrite');
    const store = transaction.objectStore(STORES.conversations);
    const index = store.index('partition_character_source');
    const existing = await requestResult(
      index.get([partition, conversation.characterId, conversation.source])
    ) as ConversationRecord | undefined;
    if (existing && existing.conversationId !== conversation.conversationId) {
      store.delete(existing.key);
    }
    store.put({
      ...conversation,
      key: key(partition, conversation.source, conversation.conversationId),
      partition
    } satisfies ConversationRecord);
    await transactionDone(transaction);
    return conversation;
  }

  async findConversation(
    partition: string,
    characterId: string,
    source: ConversationSource
  ): Promise<StoredConversation | null> {
    const database = await this.database();
    const transaction = database.transaction(STORES.conversations, 'readonly');
    const record = await requestResult(
      transaction.objectStore(STORES.conversations)
        .index('partition_character_source')
        .get([partition, characterId, source])
    ) as ConversationRecord | undefined;
    return record
      ? {
          conversationId: record.conversationId,
          characterId: record.characterId,
          source: record.source
        }
      : null;
  }

  async replaceMessages(
    partition: string,
    conversationId: string,
    messages: Message[]
  ): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(STORES.messages, 'readwrite');
    const store = transaction.objectStore(STORES.messages);
    const existing = await requestResult(
      store.index('partition_conversation')
        .getAll(IDBKeyRange.only([partition, conversationId]))
    ) as MessageRecord[];
    for (const record of existing) store.delete(record.key);
    messages.forEach((message, sequence) => {
      store.put({
        key: key(partition, conversationId, message.message_id),
        partition,
        conversationId,
        sequence,
        value: message
      } satisfies MessageRecord);
    });
    await transactionDone(transaction);
  }

  async listMessages(partition: string, conversationId: string): Promise<Message[]> {
    const database = await this.database();
    const transaction = database.transaction(STORES.messages, 'readonly');
    const records = await requestResult(
      transaction.objectStore(STORES.messages)
        .index('partition_conversation')
        .getAll(IDBKeyRange.only([partition, conversationId]))
    ) as MessageRecord[];
    return records
      .sort((left, right) => left.sequence - right.sequence)
      .map((record) => record.value);
  }

  async enqueueClientTurn(
    partition: string,
    record: ClientTurnOutboxRecord
  ): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(STORES.outbox, 'readwrite');
    transaction.objectStore(STORES.outbox).put({
      key: key(partition, record.mutationId),
      partition,
      mutationId: record.mutationId,
      value: record
    } satisfies OutboxRecord);
    await transactionDone(transaction);
  }

  async listClientTurnOutbox(partition: string): Promise<ClientTurnOutboxRecord[]> {
    const database = await this.database();
    const transaction = database.transaction(STORES.outbox, 'readonly');
    const records = await requestResult(
      transaction.objectStore(STORES.outbox)
        .index('partition')
        .getAll(IDBKeyRange.only(partition))
    ) as OutboxRecord[];
    return records
      .map((record) => record.value)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async markClientTurnConflict(partition: string, mutationId: string): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(STORES.outbox, 'readwrite');
    const store = transaction.objectStore(STORES.outbox);
    const recordKey = key(partition, mutationId);
    const record = await requestResult(store.get(recordKey)) as OutboxRecord | undefined;
    if (record) {
      store.put({
        ...record,
        value: { ...record.value, status: 'CONFLICT_PENDING' }
      } satisfies OutboxRecord);
    }
    await transactionDone(transaction);
  }

  async removeClientTurn(partition: string, mutationId: string): Promise<void> {
    const database = await this.database();
    const transaction = database.transaction(STORES.outbox, 'readwrite');
    transaction.objectStore(STORES.outbox).delete(key(partition, mutationId));
    await transactionDone(transaction);
  }
}

export const chatRepository = new ChatRepository();

export async function resetChatRepositoryForTests(): Promise<void> {
  await chatRepository.release();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(CHAT_REPOSITORY_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}
