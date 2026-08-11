import { streamText, type LanguageModel, type ModelMessage } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { Character, Message, ModelConfiguration } from './api';
import { ByokCompatibilityError, publicByokOrigins, validateByokBaseUrl } from './byok-policy';
import { byokProvider } from './provider-catalog';

export interface ByokGenerationInput {
  configuration: ModelConfiguration;
  apiKey: string;
  character: Character;
  transcript: Message[];
  input: string;
  clientContext?: unknown;
}

export type ByokDirectCode =
  | 'BYOK_DIRECT_CORS_BLOCKED'
  | 'BYOK_DIRECT_PROVIDER_ERROR'
  | 'BYOK_DIRECT_EMPTY_COMPLETION';

export class ByokDirectError extends Error {
  constructor(
    readonly code: ByokDirectCode,
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = 'ByokDirectError';
  }
}

/**
 * The character brief, kept out of `messages`.
 *
 * The AI SDK rejects a `system` row inside `messages` and expects the same text
 * through `instructions`. It reports that rejection to `onError` rather than
 * throwing, so a system row here does not fail loudly — it produces a stream
 * that ends without a single delta.
 */
export function buildByokInstructions(input: ByokGenerationInput): string {
  const context = input.clientContext === undefined
    ? ''
    : `\nLocal persona, worldbook, and regex context:\n${JSON.stringify(input.clientContext)}`;
  return [
    `You are ${input.character.name}. Stay in character and write only the reply.`,
    `Description: ${input.character.profile_summary}`,
    `Personality: ${input.character.personality_summary}${context}`
  ].join('\n');
}

export function buildByokMessages(input: ByokGenerationInput): ModelMessage[] {
  return [
    ...input.transcript.flatMap((message): ModelMessage[] => {
      if (message.role === 'EVENT') return [];
      return [{
        role: message.role === 'USER' ? 'user' : 'assistant',
        content: message.content_text
      }];
    }),
    { role: 'user', content: input.input }
  ];
}

function modelFor(configuration: ModelConfiguration, apiKey: string): LanguageModel {
  const provider = byokProvider(configuration.provider);
  if (!provider) {
    throw new ByokCompatibilityError('BYOK_ORIGIN_NOT_ALLOWED', 'Unknown BYOK provider.');
  }
  const baseURL = validateByokBaseUrl(configuration.base_url, {
    pageProtocol: typeof window === 'undefined' ? 'https:' : window.location.protocol,
    ...(publicByokOrigins() ? { extraOrigins: publicByokOrigins() } : {})
  }).toString().replace(/\/$/, '');
  if (provider.adapter === 'ANTHROPIC') {
    return createAnthropic({ apiKey, baseURL })(configuration.model_name);
  }
  if (provider.adapter === 'GOOGLE') {
    return createGoogleGenerativeAI({ apiKey, baseURL })(configuration.model_name);
  }
  return createOpenAICompatible({
    name: provider.id,
    apiKey,
    baseURL
  })(configuration.model_name);
}

function isRetryableProviderError(reason: unknown): boolean {
  return (
    typeof reason === 'object' &&
    reason !== null &&
    'isRetryable' in reason &&
    (reason as { isRetryable?: unknown }).isRetryable === true
  );
}

export async function streamByokGeneration(
  input: ByokGenerationInput,
  options: { signal?: AbortSignal; onDelta?: (text: string) => void } = {}
): Promise<string> {
  try {
    // The SDK routes stream failures to `onError` and lets `textStream` finish
    // empty. Without capturing them here, a refused request is indistinguishable
    // from a reply of "" — and the caller stores that silence as the answer.
    let streamFailure: unknown = null;
    const result = streamText({
      model: modelFor(input.configuration, input.apiKey),
      instructions: buildByokInstructions(input),
      messages: buildByokMessages(input),
      onError: ({ error }) => { streamFailure = error; },
      ...(options.signal ? { abortSignal: options.signal } : {})
    });
    let text = '';
    for await (const delta of result.textStream) {
      text += delta;
      options.onDelta?.(delta);
    }
    if (streamFailure !== null) throw streamFailure;
    // A reader who pressed Stop asked for the stream to end. Whatever arrived
    // first is their answer, and an empty one is not a failure to report.
    if (options.signal?.aborted) return text;
    if (!text.trim()) {
      throw new ByokDirectError(
        'BYOK_DIRECT_EMPTY_COMPLETION',
        'The provider accepted the request but returned no reply.',
        true
      );
    }
    return text;
  } catch (reason) {
    if (reason instanceof ByokCompatibilityError) throw reason;
    if (reason instanceof ByokDirectError) throw reason;
    if (options.signal?.aborted) throw reason;
    if (reason instanceof TypeError) {
      throw new ByokDirectError(
        'BYOK_DIRECT_CORS_BLOCKED',
        'The provider blocked this browser request (CORS or network compatibility).'
      );
    }
    // Everything the provider or the SDK refused. Whether waiting can fix it is
    // the SDK's judgement (rate limits and 5xx are retryable, a rejected request
    // body is not), so it travels with the error rather than being guessed here.
    throw new ByokDirectError(
      'BYOK_DIRECT_PROVIDER_ERROR',
      reason instanceof Error ? reason.message : 'The provider request failed.',
      isRetryableProviderError(reason)
    );
  }
}
