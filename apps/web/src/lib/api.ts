import { analytics } from './analytics';
import { createId } from './id';
import { cloudUrl } from './runtime-config';

export interface Character {
  character_id: string;
  name: string;
  profile_summary: string;
  personality_summary: string;
  first_message: string;
  avatar_seed: string;
  version?: number;
  is_owned?: boolean;
  conversation_id?: string | null;
  last_message?: string | null;
}

export interface Message {
  message_id: string;
  // EVENT is a system note in the transcript (e.g. a relationship migration). It is
  // never attributed to the character and never sent to the model.
  role: 'USER' | 'ASSISTANT' | 'EVENT';
  content_text: string;
  status: string;
}

export interface Provider {
  id: string;
  name: string;
  shortName: string;
  region: 'CN' | 'GLOBAL' | 'LOCAL' | 'CUSTOM';
  baseUrl: string;
  allowCustomBaseUrl: boolean;
  apiKeyRequired: boolean;
  placeholderModels: readonly string[];
  helpUrl: string;
  notice?: string;
}

export interface ModelConfiguration {
  model_configuration_id: string;
  provider: string;
  model_name: string;
  display_name: string;
  base_url: string;
  credential_id: string;
  credential_configured: boolean;
}

export interface AnonymousIdentity {
  user_id: string;
  anonymous_id: string;
  identity_type: 'ANONYMOUS' | 'EMAIL';
  email?: string | null;
  registered?: boolean;
  free_quota_total: number;
  free_quota_remaining: number;
  free_quota_available: number;
  free_quota_enabled: boolean;
}

export type AuthOutcome = 'REGISTERED' | 'LOGGED_IN' | 'MERGED';

export async function sendEmailCode(
  email: string
): Promise<{ success: boolean; message: string }> {
  return api('/v1/auth/email-code/send', {
    method: 'POST',
    body: JSON.stringify({ email })
  });
}

export async function verifyEmailCode(
  email: string,
  code: string
): Promise<{ user: AnonymousIdentity; outcome: AuthOutcome }> {
  return api('/v1/auth/email-code/verify', {
    method: 'POST',
    body: JSON.stringify({ email, code })
  });
}

export async function logout(): Promise<void> {
  await api('/v1/auth/logout', { method: 'POST' });
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code = 'REQUEST_FAILED',
    readonly retryable = false,
    readonly requestId?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  // `cloudUrl` keeps same-origin deployments on relative paths and rewrites to the
  // configured LiteTavern Cloud origin when the client is hosted separately.
  const response = await fetch(cloudUrl(path), {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...analytics.getSessionHeaders(),
      ...init.headers
    }
  });
  const payload = (await response.json()) as T & {
    error?: {
      code?: string;
      message?: string;
      retryable?: boolean;
      request_id?: string;
    };
  };
  if (!response.ok) {
    throw new ApiError(
      payload.error?.message ?? '请求失败，请稍后重试。',
      payload.error?.code,
      payload.error?.retryable,
      payload.error?.request_id
    );
  }
  return payload;
}

export interface TurnPlan {
  turn_id: string;
  messages: string[];
  free_quota_remaining?: number;
  /** Present for platform-paid turns: which pool paid and what is left of it. */
  cloud_quota?: {
    source: 'TRIAL' | 'ALPHA' | 'BYOK' | 'NONE';
    total: number;
    available: number;
    remaining_ratio: number;
    cycle_ends_at: string | null;
  };
}

// Generate a whole Agent turn (1–4 bubbles) in one model call. The bubbles are not
// persisted server-side here — the client reveals and saves them one by one.
export async function generateTurn(
  conversationId: string,
  payload: unknown
): Promise<TurnPlan> {
  return api<TurnPlan>(`/v1/conversations/${conversationId}/turns`, {
    method: 'POST',
    headers: { 'Idempotency-Key': createId() },
    body: JSON.stringify(payload)
  });
}

// Persist one bubble at the instant it is displayed ("show one, write one").
export async function saveTurnBubble(
  conversationId: string,
  turnId: string,
  bubble: { message_id: string; text: string; bubble_no: number }
): Promise<void> {
  await api(`/v1/conversations/${conversationId}/turns/${turnId}/bubbles`, {
    method: 'POST',
    body: JSON.stringify(bubble)
  });
}

export async function deleteCharacter(characterId: string): Promise<void> {
  await api(`/v1/characters/${characterId}`, { method: 'DELETE' });
}

export async function streamGeneration(
  conversationId: string,
  payload: unknown,
  onDelta: (text: string) => void
): Promise<{ freeQuotaRemaining?: number }> {
  const response = await fetch(cloudUrl(`/v1/conversations/${conversationId}/generations`), {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': createId(),
      ...analytics.getSessionHeaders()
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const body = (await response.json()) as {
      error?: {
        code?: string;
        message?: string;
        retryable?: boolean;
        request_id?: string;
      };
    };
    throw new ApiError(
      body.error?.message ?? '发送失败，请稍后重试。',
      body.error?.code,
      body.error?.retryable,
      body.error?.request_id
    );
  }
  if (!response.body) throw new Error('浏览器不支持流式响应。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let freeQuotaRemaining: number | undefined;
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const event = frame.match(/^event: (.+)$/m)?.[1];
      const data = frame.match(/^data: (.+)$/m)?.[1];
      if (!data) continue;
      const parsed = JSON.parse(data) as {
        text?: string;
        message?: string;
        code?: string;
        retryable?: boolean;
        request_id?: string;
        free_quota_remaining?: number;
      };
      if (event === 'delta' && parsed.text) onDelta(parsed.text);
      if (event === 'done' && parsed.free_quota_remaining !== undefined) {
        freeQuotaRemaining = parsed.free_quota_remaining;
      }
      if (event === 'error') {
        throw new ApiError(
          parsed.message ?? '模型服务暂时不可用。',
          parsed.code,
          parsed.retryable,
          parsed.request_id
        );
      }
    }
    if (done) break;
  }
  return freeQuotaRemaining === undefined ? {} : { freeQuotaRemaining };
}
