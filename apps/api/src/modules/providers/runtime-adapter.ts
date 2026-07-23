import type { ModelMessage } from 'ai';
import type {
  AvailableModel,
  ProviderConnection
} from '@pomchat/contracts';
import type { CredentialLease } from './credential-store.js';

export interface ConnectionRuntimeContext {
  connection: ProviderConnection;
  credential?: CredentialLease;
}

export interface RuntimeGenerationInput {
  modelId: string;
  system: string;
  messages: ModelMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  abortSignal?: AbortSignal;
}

export interface RuntimeStreamResult {
  textStream: AsyncIterable<string>;
  usage: Promise<{ inputTokens: number; outputTokens: number }>;
}

export interface RuntimeAdapter {
  id: string;
  validate(context: ConnectionRuntimeContext): Promise<{
    status: 'connected' | 'unavailable' | 'reconnect_required' | 'revoked';
    errorCode?: string;
  }>;
  listModels(context: ConnectionRuntimeContext): Promise<AvailableModel[]>;
  stream(
    context: ConnectionRuntimeContext,
    input: RuntimeGenerationInput
  ): Promise<RuntimeStreamResult>;
  complete(
    context: ConnectionRuntimeContext,
    input: RuntimeGenerationInput
  ): Promise<string>;
}

export class RuntimeAdapterNotFoundError extends Error {
  constructor(adapterId: string) {
    super(`Runtime adapter is not registered: ${adapterId}`);
    this.name = 'RuntimeAdapterNotFoundError';
  }
}

export class RuntimeAdapterRegistry {
  readonly #adapters = new Map<string, RuntimeAdapter>();

  constructor(adapters: readonly RuntimeAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: RuntimeAdapter): void {
    if (this.#adapters.has(adapter.id)) {
      throw new Error(`Runtime adapter already registered: ${adapter.id}`);
    }
    this.#adapters.set(adapter.id, adapter);
  }

  get(adapterId: string): RuntimeAdapter {
    const adapter = this.#adapters.get(adapterId);
    if (!adapter) throw new RuntimeAdapterNotFoundError(adapterId);
    return adapter;
  }

  has(adapterId: string): boolean {
    return this.#adapters.has(adapterId);
  }
}
