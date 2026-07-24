export type ProviderProtocol = 'demo' | 'openai-compatible' | 'anthropic' | 'google';
export type ProviderRegion = 'CN' | 'GLOBAL' | 'LOCAL' | 'CUSTOM';

// OpenAI has not published a general third-party Web OAuth flow that grants
// model API access. Keep this static until the official support conditions in
// the v0.1.0 ADR are met.
export const OPENAI_WEB_OAUTH_ENABLED = false;

export type AuthMethodKind =
  | 'oauth'
  | 'device_code'
  | 'api_key'
  | 'token'
  | 'cli'
  | 'local'
  | 'custom';

export type ConnectionStatus =
  | 'connected'
  | 'expired'
  | 'revoked'
  | 'unavailable'
  | 'reconnect_required';

export type CredentialOwner = 'pomchat' | 'external' | 'none';
export type AuthMethodGroup = 'recommended' | 'other';
export type AdditionalBilling = 'none' | 'provider_quota' | 'usage_based' | 'unknown';
export type ProviderCategory = 'global' | 'cn' | 'local' | 'custom';

export interface AuthMethodDisplay {
  title: string;
  description: string;
  group: AuthMethodGroup;
  usesExistingSubscription: boolean;
  additionalBilling: AdditionalBilling;
  credentialLocation: string;
  requiresLocalSoftware?: string;
  modelScope: string;
}

export interface AuthMethodDefinition {
  id: string;
  kind: AuthMethodKind;
  runtimeAdapterId: string;
  credentialOwner: CredentialOwner;
  display: AuthMethodDisplay;
}

export interface ProviderDefinition {
  id: string;
  displayName: string;
  shortName: string;
  category: ProviderCategory;
  helpUrl: string;
  notice?: string;
  authMethods: readonly AuthMethodDefinition[];
}

export interface ProviderConnection {
  id: string;
  providerId: string;
  authMethodId: string;
  displayName: string;
  status: ConnectionStatus;
  nonSecretConfig: Record<string, unknown>;
  credentialRef?: string;
  lastCheckedAt?: string;
  lastErrorCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CredentialMetadata {
  credentialRef: string;
  connectionId: string;
  kind: AuthMethodKind;
  store: 'os_keyring' | 'external_cli' | 'none';
  version: number;
  expiresAt?: string;
  updatedAt?: string;
}

export interface AvailableModel {
  id: string;
  displayName: string;
  capabilities: string[];
  contextWindow?: number;
  recommended?: boolean;
  billingNote?: string;
}

export interface ProviderRuntimePreset {
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

export const PROVIDER_RUNTIME_PRESETS = [
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
] as const satisfies readonly ProviderRuntimePreset[];

function categoryFor(region: ProviderRegion): ProviderCategory {
  if (region === 'CN') return 'cn';
  if (region === 'LOCAL') return 'local';
  if (region === 'CUSTOM') return 'custom';
  return 'global';
}

function apiKeyAuthMethod(providerId: string): AuthMethodDefinition {
  const runtimeAdapterId =
    providerId === 'openai'
      ? 'openai-api'
      : providerId === 'anthropic'
        ? 'anthropic-api'
        : providerId === 'google'
          ? 'google-api'
          : 'openai-compatible';
  return {
    id: 'api-key',
    kind: 'api_key',
    runtimeAdapterId,
    credentialOwner: 'pomchat',
    display: {
      title: '使用 API Key',
      description: '使用服务商开发者平台的按量调用通道。',
      group: 'other',
      usesExistingSubscription: false,
      additionalBilling: 'usage_based',
      credentialLocation: 'PomChat 本机安全存储',
      modelScope: '由 API 账号权限和服务商模型目录决定'
    }
  };
}

function localAuthMethod(providerId: string): AuthMethodDefinition {
  return {
    id: 'local',
    kind: 'local',
    runtimeAdapterId: providerId === 'ollama' ? 'ollama' : 'openai-compatible',
    credentialOwner: 'none',
    display: {
      title: '使用本地模型',
      description: '复用这台电脑上运行的本地模型服务。',
      group: 'recommended',
      usesExistingSubscription: false,
      additionalBilling: 'none',
      credentialLocation: '无需凭证',
      requiresLocalSoftware: providerId === 'ollama' ? 'Ollama' : 'LM Studio',
      modelScope: '由本机已安装模型决定'
    }
  };
}

function authMethodsFor(preset: ProviderRuntimePreset): readonly AuthMethodDefinition[] {
  if (preset.id === 'openai') {
    // These are Codex-product integrations, not general OpenAI Web OAuth.
    // The Web provider catalog intentionally exposes only the API-key preset.
    return [
      {
        id: 'codex-device-code',
        kind: 'device_code',
        runtimeAdapterId: 'openai-codex-app-server',
        credentialOwner: 'external',
        display: {
          title: '使用已有 ChatGPT/Codex 账号',
          description: '通过 Codex 官方登录流程连接已有账号。',
          group: 'recommended',
          usesExistingSubscription: true,
          additionalBilling: 'provider_quota',
          credentialLocation: 'Codex 官方本机凭证存储',
          requiresLocalSoftware: 'Codex CLI',
          modelScope: '由 Codex 订阅和本机 Codex 版本决定'
        }
      },
      {
        id: 'codex-cli',
        kind: 'cli',
        runtimeAdapterId: 'openai-codex-app-server',
        credentialOwner: 'external',
        display: {
          title: '使用本机已登录的 Codex',
          description: '复用当前电脑上的 Codex 登录状态。',
          group: 'recommended',
          usesExistingSubscription: true,
          additionalBilling: 'provider_quota',
          credentialLocation: 'Codex 官方本机凭证存储',
          requiresLocalSoftware: 'Codex CLI',
          modelScope: '由 Codex 订阅和本机 Codex 版本决定'
        }
      },
      apiKeyAuthMethod(preset.id)
    ];
  }
  if (preset.id === 'ollama' || preset.id === 'lmstudio') {
    return [localAuthMethod(preset.id)];
  }
  if (preset.id === 'custom-openai') {
    return [
      {
        id: 'openai-compatible',
        kind: 'custom',
        runtimeAdapterId: 'openai-compatible',
        credentialOwner: 'pomchat',
        display: {
          title: '自定义兼容接口',
          description: '连接兼容 OpenAI 协议的自定义服务。',
          group: 'other',
          usesExistingSubscription: false,
          additionalBilling: 'unknown',
          credentialLocation: '可选凭证保存在 PomChat 本机安全存储',
          modelScope: '由目标接口决定'
        }
      }
    ];
  }
  if (preset.id === 'demo') {
    return [
      {
        id: 'local',
        kind: 'local',
        runtimeAdapterId: 'demo',
        credentialOwner: 'none',
        display: {
          title: 'PomChat Demo',
          description: '不连接外部服务的本机演示通道。',
          group: 'recommended',
          usesExistingSubscription: false,
          additionalBilling: 'none',
          credentialLocation: '无需凭证',
          modelScope: 'PomChat Demo'
        }
      }
    ];
  }
  return [apiKeyAuthMethod(preset.id)];
}

const providerDefinitions = PROVIDER_RUNTIME_PRESETS.map(
  (preset: ProviderRuntimePreset): ProviderDefinition => ({
    id: preset.id,
    displayName: preset.name,
    shortName: preset.shortName,
    category: categoryFor(preset.region),
    helpUrl: preset.helpUrl,
    ...(preset.notice ? { notice: preset.notice } : {}),
    authMethods: authMethodsFor(preset)
  })
);

providerDefinitions.push({
  id: 'google-vertex',
  displayName: 'Google Vertex AI',
  shortName: 'Vertex AI',
  category: 'global',
  helpUrl: 'https://cloud.google.com/vertex-ai/generative-ai/docs/start/quickstart',
  authMethods: [
    {
      id: 'gcloud-adc',
      kind: 'cli',
      runtimeAdapterId: 'vertex-ai',
      credentialOwner: 'external',
      display: {
        title: '使用本机 Google Cloud 登录',
        description: '复用 gcloud Application Default Credentials。',
        group: 'recommended',
        usesExistingSubscription: false,
        additionalBilling: 'usage_based',
        credentialLocation: 'Google Cloud Application Default Credentials',
        requiresLocalSoftware: 'Google Cloud CLI',
        modelScope: '由 Google Cloud 项目、区域和 IAM 权限决定'
      }
    }
  ]
});

export const PROVIDERS: readonly ProviderDefinition[] = providerDefinitions;
export type ProviderId = string;
export const providerIds = PROVIDERS.map((provider) => provider.id);

export class ProviderRegistry {
  readonly #providers = new Map<string, ProviderDefinition>();

  constructor(providers: readonly ProviderDefinition[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: ProviderDefinition): void {
    if (this.#providers.has(provider.id)) {
      throw new Error(`Provider already registered: ${provider.id}`);
    }
    const authMethodIds = provider.authMethods.map((method) => method.id);
    if (new Set(authMethodIds).size !== authMethodIds.length) {
      throw new Error(`Duplicate auth method for provider: ${provider.id}`);
    }
    this.#providers.set(provider.id, provider);
  }

  get(providerId: string): ProviderDefinition {
    const provider = this.#providers.get(providerId);
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);
    return provider;
  }

  getAuthMethod(providerId: string, authMethodId: string): AuthMethodDefinition {
    const method = this.get(providerId).authMethods.find(
      (candidate) => candidate.id === authMethodId
    );
    if (!method) {
      throw new Error(`Unknown auth method: ${providerId}/${authMethodId}`);
    }
    return method;
  }

  list(): readonly ProviderDefinition[] {
    return [...this.#providers.values()];
  }
}

export const providerRegistry = new ProviderRegistry(PROVIDERS);

export function getProvider(id: string): ProviderDefinition {
  return providerRegistry.get(id);
}

export function getProviderRuntimePreset(id: string): ProviderRuntimePreset {
  const provider = PROVIDER_RUNTIME_PRESETS.find((candidate) => candidate.id === id);
  if (!provider) throw new Error(`Unknown provider runtime preset: ${id}`);
  return provider;
}
