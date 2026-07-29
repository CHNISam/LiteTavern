import type { Character, Message } from './api';

/**
 * Local read-through cache for the degraded path.
 *
 * LiteTavern must stay usable when LiteTavern Cloud is unreachable: the contact list
 * and already-read conversations keep rendering from the last successful fetch, and
 * the UI says the cloud is unavailable rather than implying the data is gone.
 *
 * This is deliberately a cache, not a second source of truth. Nothing is invented
 * here, nothing is written back on its own, and a cached read is always labelled as
 * such by the caller.
 */

const CHARACTERS_KEY = 'litetavern.cache.characters.v1';
const MESSAGES_PREFIX = 'litetavern.cache.messages.v1:';
const MAX_CACHED_MESSAGES = 200;

function store(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function read<T>(key: string): T | null {
  try {
    const raw = store()?.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    store()?.setItem(key, JSON.stringify(value));
  } catch {
    // Quota-exceeded or private-mode storage: caching is best effort by design.
  }
}

export function cacheCharacters(characters: Character[]): void {
  write(CHARACTERS_KEY, characters);
}

export function cachedCharacters(): Character[] {
  return read<Character[]>(CHARACTERS_KEY) ?? [];
}

export function cacheMessages(conversationId: string, messages: Message[]): void {
  write(`${MESSAGES_PREFIX}${conversationId}`, messages.slice(-MAX_CACHED_MESSAGES));
}

export function cachedMessages(conversationId: string): Message[] {
  return read<Message[]>(`${MESSAGES_PREFIX}${conversationId}`) ?? [];
}

/**
 * A conversation the client opened while online. Lets the degraded path reopen the
 * last conversation for a character without asking the server for its id.
 */
const CONVERSATIONS_KEY = 'litetavern.cache.conversations.v1';

export function cacheConversationId(
  characterId: string,
  conversationId: string
): void {
  const map = read<Record<string, string>>(CONVERSATIONS_KEY) ?? {};
  map[characterId] = conversationId;
  write(CONVERSATIONS_KEY, map);
}

export function cachedConversationId(characterId: string): string | null {
  const map = read<Record<string, string>>(CONVERSATIONS_KEY) ?? {};
  return map[characterId] ?? null;
}
