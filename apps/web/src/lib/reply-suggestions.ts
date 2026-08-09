/**
 * When the client asks Cloud for user-side reply candidates.
 *
 * The trigger is a client decision, not a server one, because it is the only thing that
 * decides whether an extra model call happens at all. `MANUAL` is the default and the
 * quiet one: chatting normally never requests suggestions, so a reader who never
 * presses the button never pays for one.
 *
 * Both triggers use the same request and the same candidates. Nothing here changes what
 * a generation asks for — turning `AUTOMATIC` on must not alter the character's reply,
 * only add a second, separate call after it has finished.
 */

export type ReplySuggestionsTrigger = 'MANUAL' | 'AUTOMATIC';

export interface ReplySuggestionsSettings {
  trigger: ReplySuggestionsTrigger;
}

export const REPLY_SUGGESTIONS_STORAGE_KEY = 'litetavern.reply-suggestions.v1';

/**
 * Manual by default, and the default matters: automatic spends one extra allowance unit
 * per character reply. Opting in to that is the reader's decision to make knowingly.
 */
export const DEFAULT_REPLY_SUGGESTIONS_SETTINGS: ReplySuggestionsSettings = {
  trigger: 'MANUAL'
};

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function normalizeReplySuggestionsSettings(
  value: unknown
): ReplySuggestionsSettings {
  if (!value || typeof value !== 'object') return DEFAULT_REPLY_SUGGESTIONS_SETTINGS;
  const candidate = value as Partial<ReplySuggestionsSettings>;
  // Anything unrecognised reads as MANUAL. A storage value that cannot be understood
  // must not be resolved into the mode that spends allowance.
  return { trigger: candidate.trigger === 'AUTOMATIC' ? 'AUTOMATIC' : 'MANUAL' };
}

export function readReplySuggestionsSettings(): ReplySuggestionsSettings {
  try {
    const raw = storage()?.getItem(REPLY_SUGGESTIONS_STORAGE_KEY);
    return raw
      ? normalizeReplySuggestionsSettings(JSON.parse(raw))
      : DEFAULT_REPLY_SUGGESTIONS_SETTINGS;
  } catch {
    return DEFAULT_REPLY_SUGGESTIONS_SETTINGS;
  }
}

export function writeReplySuggestionsSettings(
  settings: ReplySuggestionsSettings
): void {
  try {
    storage()?.setItem(
      REPLY_SUGGESTIONS_STORAGE_KEY,
      JSON.stringify(normalizeReplySuggestionsSettings(settings))
    );
  } catch {
    // Browser-local preferences are best effort in private or quota-limited storage.
  }
}

/**
 * The idempotency key for one conversation state.
 *
 * Cloud replays a settled request under the same key without calling the model and
 * without charging again, so this is what makes "manual after automatic already ran"
 * free, and what stops a double press from buying two sets. A new message produces a
 * new head id and therefore a new key, which is exactly when stale candidates should
 * stop being reused.
 */
export function suggestionKeyFor(conversationId: string, headMessageId: string): string {
  return `suggest:${conversationId}:${headMessageId}`;
}
