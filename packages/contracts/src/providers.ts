export type ProviderProtocol = 'demo' | 'openai-compatible' | 'anthropic' | 'google';
export type ProviderRegion = 'CN' | 'GLOBAL' | 'LOCAL' | 'CUSTOM';

export interface ProviderPreset {
  id: string;
  name: string;
  shortName: string;
  region: ProviderRegion;
  protocol: ProviderProtocol;
  baseUrl: string;
  allowCustomBaseUrl: boolean;
  apiKeyRequired: boolean;
  modelDiscovery: 'openai-models' | 'manual' | 'native';
  helpUrl: string;
  placeholderModels: string[];
  notice?: string;
}

export const PROVIDERS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    shortName: 'DeepSeek',
    region: 'CN',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    allowCustomBaseUrl: false,
    apiKeyRequired: true,
    modelDiscovery: 'openai-models',
    helpUrl: 'https://api-docs.deepseek.com/',
    placeholderModels: ['deepseek-v4-flash', 'deepseek-v4-pro'],
    notice: '以连接后返回的模型列表为准，避免使用即将弃用的旧模型别名。'
  },
  {
    id: 'alibaba',
    name: '阿里云百炼 · 通义千问',
    shortName: '百炼 / Qwen',
    region: 'CN',
    protocol: 'openai-compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    allowCustomBaseUrl: true,
    apiKeyRequired: true,
    modelDiscovery: 'openai-models',
    helpUrl: 'https://help.aliyun.com/zh/model-studio/base-url',
    placeholderModels: ['qwen-plus', 'qwen-max'],
    notice: '生产环境可改用业务空间专属域名；Key 与地域必须匹配。'
  },
  {
    id: 'volcengine',
    name: '火山方舟 · 豆包',
    shortName: '方舟 / 豆包',
    region: 'CN',
    protocol: 'openai-compatible',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    allowCustomBaseUrl: true,
    apiKeyRequired: true,
    modelDiscovery: 'manual',
    helpUrl: 'https://www.volcengine.com/docs/82379',
    placeholderModels: ['doubao-seed-2-0-lite-260215'],
    notice: '请填写控制台中的模型 ID；不同地域或专属接入点可修改地址。'
  },
  {
    id: 'zhipu',
    name: '智谱 AI · GLM',
    shortName: '智谱 GLM',
    region: 'CN',
    protocol: 'openai-compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    allowCustomBaseUrl: false,
    apiKeyRequired: true,
    modelDiscovery: 'openai-models',
    helpUrl: 'https://docs.bigmodel.cn/cn/guide/develop/openai/introduction',
    placeholderModels: ['glm-5.2']
  },
  {
    id: 'moonshot',
    name: 'Kimi 开放平台',
    shortName: 'Kimi',
    region: 'CN',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    allowCustomBaseUrl: false,
    apiKeyRequired: true,
    modelDiscovery: 'openai-models',
    helpUrl: 'https://platform.kimi.com/docs/api/overview',
    placeholderModels: ['kimi-k2.5']
  },
  {
    id: 'minimax',
    name: 'MiniMax 开放平台',
    shortName: 'MiniMax',
    region: 'CN',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.minimaxi.com/v1',
    allowCustomBaseUrl: false,
    apiKeyRequired: true,
    modelDiscovery: 'openai-models',
    helpUrl: 'https://platform.minimaxi.com/docs/api-reference/api-overview',
    placeholderModels: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed']
  },
  {
    id: 'siliconflow',
    name: '硅基流动 SiliconFlow',
    shortName: 'SiliconFlow',
    region: 'CN',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.siliconflow.cn/v1',
    allowCustomBaseUrl: false,
    apiKeyRequired: true,
    modelDiscovery: 'openai-models',
    helpUrl: 'https://docs.siliconflow.cn/cn/userguide/quickstart',
    placeholderModels: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct']
  },
  {
    id: 'baidu-qianfan',
    name: '百度千帆',
    shortName: '百度千帆',
    region: 'CN',
    protocol: 'openai-compatible',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    allowCustomBaseUrl: false,
    apiKeyRequired: true,
    modelDiscovery: 'openai-models',
    helpUrl: 'https://cloud.baidu.com/doc/qianfan-api/',
    placeholderModels: ['ernie-4.5-turbo-128k']
  },
  {
    id: 'tencent-hunyuan',
    name: '腾讯混元',
    shortName: '腾讯混元',
    region: 'CN',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    allowCustomBaseUrl: true,
    apiKeyRequired: true,
    modelDiscovery: 'openai-models',
    helpUrl: 'https://cloud.tencent.com/document/product/1729/111007',
    placeholderModels: ['hunyuan-turbos-latest'],
    notice: '腾讯正在逐步迁移新模型能力至 TokenHub；请以控制台提供的最新端点为准。'
  },
  {
    id: 'stepfun',
    name: '阶跃星辰 StepFun',
    shortName: '阶跃星辰',
    region: 'CN',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.stepfun.com/v1',
    allowCustomBaseUrl: true,
    apiKeyRequired: true,
    modelDiscovery: 'openai-models',
    helpUrl: 'https://platform.stepfun.com/docs/zh/guides/developer/openai',
    placeholderModels: ['step-2-mini']
  },
  {
    id: 'modelscope',
    name: '魔搭社区 ModelScope',
    shortName: '魔搭社区',
    region: 'CN',
    protocol: 'openai-compatible',
    baseUrl: 'https://api-inference.modelscope.cn/v1',
    allowCustomBaseUrl: false,
    apiKeyRequired: true,
    modelDiscovery: 'manual',
    helpUrl: 'https://modelscope.cn/docs/model-service/API-Inference/intro',
    placeholderModels: ['Qwen/Qwen3.5-35B-A3B'],
    notice: '模型上下线与免费额度会变化，请以模型页的 API-Inference 标识和示例为准。'
  },
  {
    id: 'openai',
    name: 'OpenAI',
    shortName: 'OpenAI',
    region: 'GLOBAL',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    allowCustomBaseUrl: false,
    apiKeyRequired: true,
    modelDiscovery: 'openai-models',
    helpUrl: 'https://developers.openai.com/',
    placeholderModels: []
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    shortName: 'Anthropic',
    region: 'GLOBAL',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    allowCustomBaseUrl: true,
    apiKeyRequired: true,
    modelDiscovery: 'manual',
    helpUrl: 'https://docs.anthropic.com/en/api/getting-started',
    placeholderModels: ['claude-sonnet-4-6']
  },
  {
    id: 'google',
    name: 'Google Gemini',
    shortName: 'Gemini',
    region: 'GLOBAL',
    protocol: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com',
    allowCustomBaseUrl: false,
    apiKeyRequired: true,
    modelDiscovery: 'native',
    helpUrl: 'https://ai.google.dev/gemini-api/docs',
    placeholderModels: ['gemini-3-flash-preview']
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    shortName: 'OpenRouter',
    region: 'GLOBAL',
    protocol: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    allowCustomBaseUrl: false,
    apiKeyRequired: true,
    modelDiscovery: 'openai-models',
    helpUrl: 'https://openrouter.ai/docs',
    placeholderModels: []
  },
  {
    id: 'xai',
    name: 'xAI',
    shortName: 'xAI',
    region: 'GLOBAL',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.x.ai/v1',
    allowCustomBaseUrl: false,
    apiKeyRequired: true,
    modelDiscovery: 'openai-models',
    helpUrl: 'https://docs.x.ai/',
    placeholderModels: []
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    shortName: 'Mistral',
    region: 'GLOBAL',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.mistral.ai/v1',
    allowCustomBaseUrl: false,
    apiKeyRequired: true,
    modelDiscovery: 'openai-models',
    helpUrl: 'https://docs.mistral.ai/',
    placeholderModels: []
  },
  {
    id: 'groq',
    name: 'Groq',
    shortName: 'Groq',
    region: 'GLOBAL',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    allowCustomBaseUrl: false,
    apiKeyRequired: true,
    modelDiscovery: 'openai-models',
    helpUrl: 'https://console.groq.com/docs/overview',
    placeholderModels: []
  },
  {
    id: 'ollama',
    name: 'Ollama（本地）',
    shortName: 'Ollama',
    region: 'LOCAL',
    protocol: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:11434/v1',
    allowCustomBaseUrl: true,
    apiKeyRequired: false,
    modelDiscovery: 'openai-models',
    helpUrl: 'https://docs.ollama.com/api/openai-compatibility',
    placeholderModels: []
  },
  {
    id: 'lmstudio',
    name: 'LM Studio（本地）',
    shortName: 'LM Studio',
    region: 'LOCAL',
    protocol: 'openai-compatible',
    baseUrl: 'http://127.0.0.1:1234/v1',
    allowCustomBaseUrl: true,
    apiKeyRequired: false,
    modelDiscovery: 'openai-models',
    helpUrl: 'https://lmstudio.ai/docs/developer/openai-compat',
    placeholderModels: []
  },
  {
    id: 'custom-openai',
    name: '自定义 OpenAI-compatible',
    shortName: '自定义端点',
    region: 'CUSTOM',
    protocol: 'openai-compatible',
    baseUrl: '',
    allowCustomBaseUrl: true,
    apiKeyRequired: false,
    modelDiscovery: 'openai-models',
    helpUrl: 'https://ai-sdk.dev/providers/openai-compatible-providers/custom-providers',
    placeholderModels: []
  },
  {
    id: 'demo',
    name: 'PomChat Demo',
    shortName: 'Demo',
    region: 'LOCAL',
    protocol: 'demo',
    baseUrl: '',
    allowCustomBaseUrl: false,
    apiKeyRequired: false,
    modelDiscovery: 'manual',
    helpUrl: '',
    placeholderModels: ['pomchat-demo']
  }
] as const satisfies readonly ProviderPreset[];

export type ProviderId = (typeof PROVIDERS)[number]['id'];
export const providerIds = PROVIDERS.map((provider) => provider.id);

export function getProvider(id: string): ProviderPreset {
  const provider = PROVIDERS.find((candidate) => candidate.id === id);
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider;
}
