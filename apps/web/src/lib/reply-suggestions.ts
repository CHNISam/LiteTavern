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

import { DEFAULT_LOCALE, type Locale } from './i18n/locale';

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
 * The idempotency key for one conversation state, plus which attempt at it this is.
 *
 * Cloud replays a *settled* request under the same key without calling the model and
 * without charging again, so the stable part is what makes "manual after automatic
 * already ran" free, and what stops a double press from buying two sets. A new message
 * produces a new head id and therefore a new key, which is exactly when stale
 * candidates should stop being reused.
 *
 * `attempt` exists because Cloud also remembers *failures* under that key, and answers
 * a replay of one with a 409 telling the reader to try again. Without this, trying
 * again would rebuild the identical key and be refused by the same stored failure
 * forever — one transient upstream error would disable 代写 for that point in the
 * conversation until the reader happened to send another message. A failure has to
 * degrade the attempt that failed, never the conversation.
 *
 * `locale` is here because the candidates are written in it and the replay does not
 * know that. Switching the interface to English and pressing 代写 again on the same
 * message would otherwise replay the Chinese set bought before the switch, and the
 * reader would change the setting and watch nothing happen. Only a non-default locale
 * adds a segment: every key already settled in Cloud was written without one, and
 * appending it unconditionally would invalidate all of them and re-charge readers for
 * candidates they had already bought.
 */
export function suggestionKeyFor(
  conversationId: string,
  headMessageId: string,
  attempt = 0,
  locale: Locale = DEFAULT_LOCALE
): string {
  const base = locale === DEFAULT_LOCALE
    ? `suggest:${conversationId}:${headMessageId}`
    : `suggest:${conversationId}:${headMessageId}:${locale}`;
  return attempt > 0 ? `${base}:${attempt}` : base;
}
