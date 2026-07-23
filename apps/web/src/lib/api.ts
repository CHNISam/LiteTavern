export interface Character {
  character_id: string;
  name: string;
  profile_summary: string;
  personality_summary: string;
  first_message: string;
  avatar_seed: string;
  is_owned?: boolean;
  conversation_id?: string | null;
  last_message?: string | null;
}

export interface Message {
  message_id: string;
  role: 'USER' | 'ASSISTANT';
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

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers
    }
  });
  const payload = (await response.json()) as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(payload.error?.message ?? '请求失败，请稍后重试。');
  return payload;
}

export async function streamGeneration(
  conversationId: string,
  payload: unknown,
  onDelta: (text: string) => void
): Promise<void> {
  const response = await fetch(`/v1/conversations/${conversationId}/generations`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': createId()
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    const body = (await response.json()) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? '发送失败，请稍后重试。');
  }
  if (!response.body) throw new Error('浏览器不支持流式响应。');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      const event = frame.match(/^event: (.+)$/m)?.[1];
      const data = frame.match(/^data: (.+)$/m)?.[1];
      if (!data) continue;
      const parsed = JSON.parse(data) as { text?: string; message?: string };
      if (event === 'delta' && parsed.text) onDelta(parsed.text);
      if (event === 'error') throw new Error(parsed.message ?? '模型服务暂时不可用。');
    }
    if (done) break;
  }
}
import { createId } from './id';
