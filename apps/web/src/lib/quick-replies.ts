export type QuickReplyBehavior = 'FILL' | 'SEND';

export interface QuickReply {
  id: string;
  label: string;
  message: string;
  enabled: boolean;
}

export interface QuickReplySettings {
  enabled: boolean;
  behavior: QuickReplyBehavior;
  replies: QuickReply[];
}

export const QUICK_REPLIES_STORAGE_KEY = 'litetavern.quick-replies.v1';
export const MAX_QUICK_REPLIES = 24;

export const DEFAULT_QUICK_REPLY_SETTINGS: QuickReplySettings = {
  enabled: true,
  behavior: 'FILL',
  replies: []
};

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function normalizeReply(value: unknown): QuickReply | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<QuickReply>;
  const id = typeof candidate.id === 'string' ? candidate.id.trim().slice(0, 100) : '';
  const message = typeof candidate.message === 'string'
    ? candidate.message.trim().slice(0, 2_000)
    : '';
  if (!id || !message) return null;
  const label = typeof candidate.label === 'string'
    ? candidate.label.trim().slice(0, 80)
    : '';
  return {
    id,
    label: label || message.slice(0, 80),
    message,
    enabled: candidate.enabled !== false
  };
}

export function normalizeQuickReplySettings(value: unknown): QuickReplySettings {
  if (!value || typeof value !== 'object') return DEFAULT_QUICK_REPLY_SETTINGS;
  const candidate = value as Partial<QuickReplySettings>;
  const replies = Array.isArray(candidate.replies)
    ? candidate.replies
        .map(normalizeReply)
        .filter((reply): reply is QuickReply => reply !== null)
        .slice(0, MAX_QUICK_REPLIES)
    : [];
  return {
    enabled: candidate.enabled !== false,
    behavior: candidate.behavior === 'SEND' ? 'SEND' : 'FILL',
    replies
  };
}

export function readQuickReplySettings(): QuickReplySettings {
  try {
    const raw = storage()?.getItem(QUICK_REPLIES_STORAGE_KEY);
    return raw ? normalizeQuickReplySettings(JSON.parse(raw)) : DEFAULT_QUICK_REPLY_SETTINGS;
  } catch {
    return DEFAULT_QUICK_REPLY_SETTINGS;
  }
}

export function writeQuickReplySettings(settings: QuickReplySettings): void {
  try {
    storage()?.setItem(
      QUICK_REPLIES_STORAGE_KEY,
      JSON.stringify(normalizeQuickReplySettings(settings))
    );
  } catch {
    // Browser-local preferences are best effort in private or quota-limited storage.
  }
}

export function moveQuickReply(
  replies: QuickReply[],
  id: string,
  offset: -1 | 1
): QuickReply[] {
  const index = replies.findIndex((reply) => reply.id === id);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= replies.length) return replies;
  const next = [...replies];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}
