import type { Provider } from './api';
export { BUILTIN_BYOK_ORIGINS } from './byok-origins';

export type ByokAdapter = 'ANTHROPIC' | 'GOOGLE' | 'OPENAI_COMPATIBLE';

export interface ByokProvider extends Provider {
  adapter: ByokAdapter;
}

export const BYOK_PROVIDERS: readonly ByokProvider[] = [
  {
    id: 'openai', name: 'OpenAI', shortName: 'OpenAI', region: 'GLOBAL',
    baseUrl: 'https://api.openai.com/v1', allowCustomBaseUrl: false,
    apiKeyRequired: true, placeholderModels: ['gpt-4.1-mini'],
    helpUrl: 'https://platform.openai.com/docs/overview', adapter: 'OPENAI_COMPATIBLE'
  },
  {
    id: 'anthropic', name: 'Anthropic', shortName: 'Claude', region: 'GLOBAL',
    baseUrl: 'https://api.anthropic.com/v1', allowCustomBaseUrl: false,
    apiKeyRequired: true, placeholderModels: ['claude-sonnet-4-20250514'],
    helpUrl: 'https://docs.anthropic.com/en/api/getting-started', adapter: 'ANTHROPIC'
  },
  {
    id: 'google', name: 'Google AI', shortName: 'Gemini', region: 'GLOBAL',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta', allowCustomBaseUrl: false,
    apiKeyRequired: true, placeholderModels: ['gemini-2.5-flash'],
    helpUrl: 'https://ai.google.dev/gemini-api/docs', adapter: 'GOOGLE'
  },
  {
    id: 'deepseek', name: 'DeepSeek', shortName: 'DeepSeek', region: 'CN',
    baseUrl: 'https://api.deepseek.com', allowCustomBaseUrl: false,
    apiKeyRequired: true, placeholderModels: ['deepseek-chat'],
    helpUrl: 'https://api-docs.deepseek.com/', adapter: 'OPENAI_COMPATIBLE'
  },
  {
    id: 'openrouter', name: 'OpenRouter', shortName: 'OpenRouter', region: 'GLOBAL',
    baseUrl: 'https://openrouter.ai/api/v1', allowCustomBaseUrl: false,
    apiKeyRequired: true, placeholderModels: ['openai/gpt-4.1-mini'],
    helpUrl: 'https://openrouter.ai/docs/quickstart', adapter: 'OPENAI_COMPATIBLE'
  },
  {
    id: 'siliconflow', name: 'SiliconFlow', shortName: 'SiliconFlow', region: 'CN',
    baseUrl: 'https://api.siliconflow.cn/v1', allowCustomBaseUrl: false,
    apiKeyRequired: true, placeholderModels: ['deepseek-ai/DeepSeek-V3'],
    helpUrl: 'https://docs.siliconflow.cn/', adapter: 'OPENAI_COMPATIBLE'
  },
  {
    id: 'custom-openai', name: 'OpenAI-compatible', shortName: 'Custom', region: 'CUSTOM',
    baseUrl: '', allowCustomBaseUrl: true, apiKeyRequired: true,
    placeholderModels: [], helpUrl: '', adapter: 'OPENAI_COMPATIBLE',
    notice: 'Only build-approved HTTPS origins can be used.'
  }
] as const;

export function byokProvider(providerId: string): ByokProvider | null {
  return BYOK_PROVIDERS.find((provider) => provider.id === providerId) ?? null;
}
