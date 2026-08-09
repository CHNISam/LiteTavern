import { analytics } from './analytics';
import { t } from './i18n';
import { createId } from './id';
import { cloudUrl } from './runtime-config';
import {
  createGenerationDiagnosticTrace,
  type GenerationDiagnosticTraceV1
} from './generation-diagnostics';

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

/**
 * A character plus the state that accumulates between this reader and them.
 * `relationship_summary` is written by the Cloud's post-turn worker; it is a
 * single evolving summary, which is why it is not one of the discrete memories.
 */
export interface CharacterDetail extends Character {
  relationship_summary?: string | null;
}

export async function fetchCharacterDetail(characterId: string): Promise<CharacterDetail> {
  const response = await api<{ character: CharacterDetail }>(`/v1/characters/${characterId}`);
  return response.character;
}

export interface Message {
  message_id: string;
  // EVENT is a system note in the transcript (e.g. a relationship migration). It is
  // never attributed to the character and never sent to the model.
  role: 'USER' | 'ASSISTANT' | 'EVENT';
  content_text: string;
  status: string;
  /**
   * Which of several replies to the same message this one is. Sent by Cloud only when
   * there is more than one, so a swipe control drawn on truthy data never appears on
   * a bubble that has nothing to swipe to. `index` is zero-based.
   */
  variant?: { index: number; total: number };
  /** The message this one answers. Absent on USER messages and on the opening line. */
  reply_to_message_id?: string;
}

/** One entry of the swipe list: every reply given to the same message. */
export interface MessageVariant {
  message_id: string;
  content_text: string;
  status: string;
  variant_no: number;
  is_active: boolean;
}

/**
 * Every reply that has been given to the message this one answers, in the order they
 * were produced. `messageId` may be either end of the edge — Cloud resolves it.
 */
export async function fetchMessageVariants(
  conversationId: string,
  messageId: string
): Promise<MessageVariant[]> {
  const response = await api<{ variants?: MessageVariant[] }>(
    `/v1/conversations/${conversationId}/messages/${messageId}/variants`
  );
  return response.variants ?? [];
}

/**
 * Show a reply that was given earlier. Cloud accepts this only at the end of the
 * conversation: choosing a variant further back would discard everything after it,
 * which is an edit rather than the navigation this looks like.
 */
export async function activateMessageVariant(
  conversationId: string,
  messageId: string
): Promise<void> {
  await api(
    `/v1/conversations/${conversationId}/messages/${messageId}/activate`,
    { method: 'POST' }
  );
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
}

/**
 * The server's allowance snapshot, exactly as `/v1/cloud/status` and the
 * generation endpoints report it. Both windows are authoritative: the client
 * never derives one figure from another.
 *
 * It lives here rather than in `lib/cloud` because the generation transport
 * carries it too, and `lib/cloud` already depends on this module.
 */
export interface CloudQuotaSnapshot {
  period_limit: number;
  period_used: number;
  period_reserved: number;
  period_remaining: number;
  period_started_at: string;
  period_ends_at: string;
  daily_limit: number;
  daily_used: number;
  daily_reserved: number;
  daily_remaining: number;
  day_utc: string;
}

export type AuthOutcome = 'REGISTERED' | 'LOGGED_IN' | 'MERGED';

export async function sendEmailCode(
  email: string,
  turnstileToken: string
): Promise<{ success: boolean; message: string }> {
  return api('/v1/auth/email-code/send', {
    method: 'POST',
    // The challenge is verified server-side before a code is ever sent, so an
    // absent or stale token costs the mail provider nothing.
    body: JSON.stringify({ email, turnstile_token: turnstileToken })
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
  diagnosticTrace?: GenerationDiagnosticTraceV1;
  constructor(
    message: string,
    readonly code = 'REQUEST_FAILED',
    readonly retryable = false,
    readonly requestId?: string,
    /**
     * HTTP status, when there was one. A route that does not exist yet answers 404
     * without any LiteTavern error code (that is the framework's own handler), so the
     * status is the only way to tell "this deployment is older than this feature"
     * apart from "your request failed".
     */
    readonly status?: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface ApiErrorPayload {
  error?: {
    code?: string;
    message?: string;
    retryable?: boolean;
    request_id?: string;
  };
}

const cloudUnavailableMessage = () => t().cloud.unavailable;

/**
 * Parse a JSON API response without leaking browser JSON parser errors into the UI.
 *
 * A static Pages deployment returns an empty 404 (or sometimes HTML) when its
 * Cloud API origin is missing. That is an availability/configuration failure, not
 * malformed user data, so surface one stable and actionable error.
 */
export async function readApiJson<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text.trim()) {
    throw new ApiError(cloudUnavailableMessage(), 'INVALID_API_RESPONSE', true);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(cloudUnavailableMessage(), 'INVALID_API_RESPONSE', true);
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
  const payload = await readApiJson<T & ApiErrorPayload>(response);
  if (!response.ok) {
    throw new ApiError(
      payload.error?.message ?? t().cloud.requestFailed,
      payload.error?.code,
      payload.error?.retryable,
      payload.error?.request_id,
      response.status
    );
  }
  return payload;
}

export interface TurnPlan {
  turn_id: string;
  messages: string[];
  // No `suggestions` here on purpose. A turn used to return user-reply candidates
  // alongside the character's bubbles, from one model call carrying both jobs. They
  // come from `fetchReplySuggestions` now — see the note there.
  /**
   * The post-deduction allowance for a platform-paid turn, so the badge stays
   * honest without an extra round trip. Null for a BYOK turn: the client's own
   * key has no server-side allowance to report.
   */
  quota?: CloudQuotaSnapshot | null;
}

// Generate a whole Agent turn (1–4 bubbles) in one model call. The bubbles are not
// persisted server-side here — the client reveals and saves them one by one.
export async function generateTurn(
  conversationId: string,
  payload: unknown,
  idempotencyKey = createId()
): Promise<TurnPlan> {
  return api<TurnPlan>(`/v1/conversations/${conversationId}/turns`, {
    method: 'POST',
    headers: { 'Idempotency-Key': idempotencyKey },
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
  options: {
    onDelta: (text: string) => void;
    signal?: AbortSignal;
    idempotencyKey?: string;
    captureTrace?: boolean;
  }
): Promise<{
  generationRequestId?: string;
  messageId?: string;
  /** The allowance after this generation, when the platform paid for it. */
  quota?: CloudQuotaSnapshot | null;
  diagnosticTrace?: GenerationDiagnosticTraceV1;
}> {
  const response = await fetch(cloudUrl(`/v1/conversations/${conversationId}/generations`), {
    method: 'POST',
    credentials: 'include',
    ...(options.signal ? { signal: options.signal } : {}),
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': options.idempotencyKey ?? createId(),
      ...analytics.getSessionHeaders()
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const body = await readApiJson<ApiErrorPayload>(response);
    throw new ApiError(
      body.error?.message ?? t().chat.sendFailed,
      body.error?.code,
      body.error?.retryable,
      body.error?.request_id,
      response.status
    );
  }
  if (!response.body) throw new Error(t().cloud.streamUnsupported);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let generationRequestId: string | undefined;
  let messageId: string | undefined;
  let quota: CloudQuotaSnapshot | null | undefined;
  let serverTrace: Record<string, unknown> | undefined;
  let pendingStreamError: ApiError | undefined;
  let lastDeltaSeq = 0;
  const deltaBySeq = new Map<number, string>();
  const diagnosticFrames: Array<{ event: string; data: string; seq?: number }> = [];
  const diagnosticDeltas: string[] = [];
  const consumeFrame = (frame: string) => {
    const lines = frame.split(/\r?\n/);
    const event = lines.find((line) => line.startsWith('event:'))
      ?.slice('event:'.length).trim();
    const data = lines
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('');
    if (!data) return;
    const parsed = JSON.parse(data) as {
      text?: string;
      message?: string;
      message_id?: string;
      generation_request_id?: string;
      code?: string;
      retryable?: boolean;
      request_id?: string;
      quota?: CloudQuotaSnapshot | null;
      seq?: number;
    };
    if (options.captureTrace) {
      diagnosticFrames.push({
        event: event ?? 'message',
        data,
        ...(parsed.seq === undefined ? {} : { seq: parsed.seq })
      });
    }
    if (event === 'start') generationRequestId = parsed.generation_request_id;
    if (event === 'delta' && parsed.text) {
      if (parsed.seq !== undefined) {
        if (!Number.isSafeInteger(parsed.seq) || parsed.seq < 1) {
          throw streamProtocolError();
        }
        const previous = deltaBySeq.get(parsed.seq);
        if (previous !== undefined) {
          if (previous !== parsed.text) throw streamProtocolError();
          return;
        }
        if (parsed.seq !== lastDeltaSeq + 1) throw streamProtocolError();
        deltaBySeq.set(parsed.seq, parsed.text);
        lastDeltaSeq = parsed.seq;
      }
      diagnosticDeltas.push(parsed.text);
      options.onDelta(parsed.text);
    }
    if (event === 'trace') serverTrace = parsed as Record<string, unknown>;
    if (event === 'done') {
      generationRequestId = parsed.generation_request_id ?? generationRequestId;
      messageId = parsed.message_id;
      // `null` is a real answer (a BYOK turn), so absence and null differ here.
      if (parsed.quota !== undefined) quota = parsed.quota;
    }
    if (event === 'error') {
      pendingStreamError = new ApiError(
        parsed.message ?? t().cloud.modelUnavailable,
        parsed.code,
        parsed.retryable,
        parsed.request_id
      );
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? '';
    for (const frame of frames) consumeFrame(frame);
    if (done) break;
  }
  if (buffer.trim()) consumeFrame(buffer);
  const diagnosticTrace = options.captureTrace
    ? await createGenerationDiagnosticTrace({
        ...(generationRequestId ? { generationRequestId } : {}),
        ...(serverTrace ? { server: serverTrace } : {}),
        frames: diagnosticFrames,
        deltas: diagnosticDeltas
      })
    : undefined;
  if (pendingStreamError) {
    if (diagnosticTrace) pendingStreamError.diagnosticTrace = diagnosticTrace;
    throw pendingStreamError;
  }
  return {
    ...(generationRequestId ? { generationRequestId } : {}),
    ...(messageId ? { messageId } : {}),
    ...(quota === undefined ? {} : { quota }),
    ...(diagnosticTrace ? { diagnosticTrace } : {})
  };
}

function streamProtocolError(): ApiError {
  return new ApiError(
    t().cloud.modelUnavailable,
    'STREAM_PROTOCOL_CORRUPTED',
    false
  );
}

export interface ReplySuggestions {
  suggestions: string[];
  /** The allowance after a platform-paid set. Null when the reader's own key paid. */
  quota?: CloudQuotaSnapshot | null;
}

/**
 * A few things the *user* could send next, given the conversation so far.
 *
 * Its own model call, never part of a turn. Folding it into the generation request
 * would mean one prompt telling the model both to stay in character and to step out of
 * it, so switching this feature on would change what the character says.
 *
 * Nothing is written to the transcript: the reader picks a candidate, edits it, or
 * ignores it. The idempotency key is what keeps a repeat press — or the manual button
 * pressed after the automatic trigger already ran — from buying a second set. Derive it
 * from the conversation state (see `suggestionKeyFor`) and the same state returns the
 * same candidates, charged once.
 */
export async function fetchReplySuggestions(
  conversationId: string,
  modelSelector: Record<string, unknown>,
  options: { idempotencyKey?: string; clientContext?: unknown } = {}
): Promise<ReplySuggestions> {
  const result = await api<{ suggestions?: unknown; quota?: CloudQuotaSnapshot | null }>(
    `/v1/conversations/${conversationId}/reply-suggestions`,
    {
      method: 'POST',
      headers: { 'Idempotency-Key': options.idempotencyKey ?? createId() },
      body: JSON.stringify({
        ...modelSelector,
        ...(options.clientContext ? { client_context: options.clientContext } : {})
      })
    }
  );
  const suggestions = Array.isArray(result.suggestions)
    ? result.suggestions
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.trim())
        .filter(Boolean)
        .slice(0, 3)
    : [];
  return {
    suggestions,
    ...(result.quota === undefined ? {} : { quota: result.quota })
  };
}
