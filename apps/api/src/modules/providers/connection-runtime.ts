import type { ProviderRegistry } from '@litetavern/contracts';
import { AppError } from '../../lib/errors.js';
import type { ConnectionRepository } from './connection-repository.js';
import type { CredentialLifecycle } from './credential-lifecycle.js';
import {
  RuntimeAdapterNotFoundError,
  type ConnectionRuntimeContext,
  type RuntimeAdapter,
  type RuntimeAdapterRegistry,
  type RuntimeGenerationInput,
  type RuntimeStreamResult
} from './runtime-adapter.js';

export interface ConnectionRuntimeOptions {
  providers: ProviderRegistry;
  connections: ConnectionRepository;
  adapters: RuntimeAdapterRegistry;
  lifecycle: CredentialLifecycle;
}

export class ConnectionRuntime {
  constructor(private readonly options: ConnectionRuntimeOptions) {}

  async validate(userId: string, connectionId: string) {
    const { adapter, context } = await this.resolveExecution(userId, connectionId);
    const result = await adapter.validate(context);
    await this.options.connections.updateStatus(
      connectionId,
      result.status,
      result.errorCode
    );
    return result;
  }

  async listModels(userId: string, connectionId: string) {
    const { adapter, context } = await this.resolveExecution(userId, connectionId);
    const models = await adapter.listModels(context);
    await this.options.connections.replaceModels(connectionId, models);
    return models;
  }

  async stream(
    userId: string,
    connectionId: string,
    input: RuntimeGenerationInput
  ): Promise<RuntimeStreamResult> {
    const { adapter, context } = await this.resolveExecution(userId, connectionId);
    return adapter.stream(context, input);
  }

  async complete(
    userId: string,
    connectionId: string,
    input: RuntimeGenerationInput
  ): Promise<string> {
    const { adapter, context } = await this.resolveExecution(userId, connectionId);
    return adapter.complete(context, input);
  }

  async resolveExecution(
    userId: string,
    connectionId: string
  ): Promise<{ adapter: RuntimeAdapter; context: ConnectionRuntimeContext }> {
    const connection = await this.options.connections.findOwned(userId, connectionId);
    if (!connection) {
      throw new AppError('RESOURCE_NOT_FOUND', '连接不存在。', 404);
    }
    if (connection.status === 'revoked' || connection.status === 'reconnect_required') {
      throw new AppError(
        'CONNECTION_RECONNECT_REQUIRED',
        '连接已失效，请重新连接。',
        409
      );
    }
    if (connection.status === 'unavailable') {
      throw new AppError('CONNECTION_UNAVAILABLE', '连接当前不可用。', 503, true);
    }

    let authMethod;
    try {
      authMethod = this.options.providers.getAuthMethod(
        connection.providerId,
        connection.authMethodId
      );
    } catch {
      await this.options.connections.updateStatus(
        connection.id,
        'reconnect_required',
        'AUTH_METHOD_NOT_REGISTERED'
      );
      throw new AppError('CONNECTION_INVALID', '连接方式未注册。', 500);
    }

    let adapter;
    try {
      adapter = this.options.adapters.get(authMethod.runtimeAdapterId);
    } catch (error) {
      if (!(error instanceof RuntimeAdapterNotFoundError)) throw error;
      await this.options.connections.updateStatus(
        connection.id,
        'unavailable',
        'RUNTIME_ADAPTER_NOT_FOUND'
      );
      throw new AppError(
        'RUNTIME_ADAPTER_NOT_FOUND',
        '连接所需的本机运行适配器不可用。',
        503
      );
    }

    const credential = await this.options.lifecycle.acquire(connection, authMethod);
    return {
      adapter,
      context: {
        connection,
        ...(credential ? { credential } : {})
      }
    };
  }
}
