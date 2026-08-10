export const BUILTIN_BYOK_ORIGIN_LIST = [
  'https://api.openai.com',
  'https://api.anthropic.com',
  'https://generativelanguage.googleapis.com',
  'https://api.deepseek.com',
  'https://openrouter.ai',
  'https://api.siliconflow.cn'
] as const;

export const BUILTIN_BYOK_ORIGINS: ReadonlySet<string> = new Set(
  BUILTIN_BYOK_ORIGIN_LIST
);
