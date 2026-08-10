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

export class ByokDirectError extends Error {
  readonly retryable = false;

  constructor(readonly code: 'BYOK_DIRECT_CORS_BLOCKED', message: string) {
    super(message);
    this.name = 'ByokDirectError';
  }
}

export function buildByokMessages(input: ByokGenerationInput): ModelMessage[] {
  const context = input.clientContext === undefined
    ? ''
    : `\nLocal persona, worldbook, and regex context:\n${JSON.stringify(input.clientContext)}`;
  return [
    {
      role: 'system',
      content: [
        `You are ${input.character.name}. Stay in character and write only the reply.`,
        `Description: ${input.character.profile_summary}`,
        `Personality: ${input.character.personality_summary}${context}`
      ].join('\n')
    },
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

export async function streamByokGeneration(
  input: ByokGenerationInput,
  options: { signal?: AbortSignal; onDelta?: (text: string) => void } = {}
): Promise<string> {
  try {
    const result = streamText({
      model: modelFor(input.configuration, input.apiKey),
      messages: buildByokMessages(input),
      ...(options.signal ? { abortSignal: options.signal } : {})
    });
    let text = '';
    for await (const delta of result.textStream) {
      text += delta;
      options.onDelta?.(delta);
    }
    return text;
  } catch (reason) {
    if (reason instanceof ByokCompatibilityError) throw reason;
    if (reason instanceof TypeError) {
      throw new ByokDirectError(
        'BYOK_DIRECT_CORS_BLOCKED',
        'The provider blocked this browser request (CORS or network compatibility).'
      );
    }
    throw reason;
  }
}
