import type {
  AuthMethodDefinition,
  ConnectionStatus,
  ProviderConnection
} from '@pomchat/contracts';
import { AppError } from '../../lib/errors.js';
import type { ConnectionRepository } from './connection-repository.js';
import {
  CredentialVersionConflictError,
  type CredentialLease,
  type CredentialStore
} from './credential-store.js';

export interface AuthValidation {
  status: ConnectionStatus;
  errorCode?: string;
}

export interface AuthLifecycleContext {
  connection: ProviderConnection;
  credential?: CredentialLease;
}

export interface UpdatedCredential {
  payload: Uint8Array;
  expiresAt?: string;
}

export interface AuthLifecycleHandler {
  validate(context: AuthLifecycleContext): Promise<AuthValidation>;
  refresh?(context: AuthLifecycleContext): Promise<UpdatedCredential>;
  revoke?(context: AuthLifecycleContext): Promise<void>;
  reconnect(context: AuthLifecycleContext): Promise<UpdatedCredential | void>;
}

export class AuthLifecycleRegistry {
  readonly #handlers = new Map<string, AuthLifecycleHandler>();

  register(providerId: string, authMethodId: string, handler: AuthLifecycleHandler): void {
    const key = `${providerId}:${authMethodId}`;
    if (this.#handlers.has(key)) throw new Error(`Auth lifecycle already registered: ${key}`);
    this.#handlers.set(key, handler);
  }

  get(providerId: string, authMethodId: string): AuthLifecycleHandler | undefined {
    return this.#handlers.get(`${providerId}:${authMethodId}`);
  }
}

export interface CredentialLifecycleOptions {
  store: CredentialStore;
  connections: ConnectionRepository;
  handlers: AuthLifecycleRegistry;
  now?: () => Date;
}

export class CredentialLifecycle {
  readonly #refreshing = new Map<string, Promise<CredentialLease>>();
  readonly #now: () => Date;

  constructor(private readonly options: CredentialLifecycleOptions) {
    this.#now = options.now ?? (() => new Date());
  }

  async acquire(
    connection: ProviderConnection,
    authMethod: AuthMethodDefinition
  ): Promise<CredentialLease | undefined> {
    if (authMethod.credentialOwner !== 'pomchat') return undefined;

    const metadata = await this.options.connections.getCredentialMetadata(connection.id);
    if (!metadata) return this.#missing(connection);
    const credential = await this.options.store.read(metadata.credentialRef);
    if (!credential) return this.#missing(connection);

    const expired = metadata.expiresAt
      ? new Date(metadata.expiresAt).getTime() <= this.#now().getTime()
      : connection.status === 'expired';
    if (!expired) return credential;

    const existing = this.#refreshing.get(connection.id);
    if (existing) return existing;
    const refreshing = this.#refresh(connection, authMethod);
    this.#refreshing.set(connection.id, refreshing);
    try {
      return await refreshing;
    } finally {
      this.#refreshing.delete(connection.id);
    }
  }

  async #refresh(
    connection: ProviderConnection,
    authMethod: AuthMethodDefinition
  ): Promise<CredentialLease> {
    const metadata = await this.options.connections.getCredentialMetadata(connection.id);
    if (!metadata) return this.#missing(connection);
    const latest = await this.options.store.read(metadata.credentialRef);
    if (!latest) return this.#missing(connection);
    if (
      metadata.expiresAt &&
      new Date(metadata.expiresAt).getTime() > this.#now().getTime()
    ) {
      await this.options.connections.updateStatus(connection.id, 'connected');
      return latest;
    }

    const handler = this.options.handlers.get(connection.providerId, authMethod.id);
    if (!handler?.refresh) return this.#refreshFailed(connection);

    try {
      const updated = await handler.refresh({ connection, credential: latest });
      let stored: { version: number };
      try {
        stored = await this.options.store.compareAndSwap(
          metadata.credentialRef,
          latest.version,
          updated.payload
        );
      } catch (error) {
        if (!(error instanceof CredentialVersionConflictError)) throw error;
        const winner = await this.options.store.read(metadata.credentialRef);
        if (!winner) return this.#missing(connection);
        return winner;
      }
      await this.options.connections.saveCredentialMetadata({
        credentialRef: metadata.credentialRef,
        connectionId: connection.id,
        kind: metadata.kind,
        store: metadata.store,
        version: stored.version,
        ...(updated.expiresAt ? { expiresAt: updated.expiresAt } : {})
      });
      await this.options.connections.updateStatus(connection.id, 'connected');
      return { payload: updated.payload.slice(), version: stored.version };
    } catch (error) {
      if (error instanceof AppError) throw error;
      return this.#refreshFailed(connection);
    }
  }

  async #missing(connection: ProviderConnection): Promise<never> {
    await this.options.connections.updateStatus(
      connection.id,
      'reconnect_required',
      'CREDENTIAL_MISSING'
    );
    throw new AppError(
      'CONNECTION_RECONNECT_REQUIRED',
      '连接凭证缺失，请重新连接。',
      409
    );
  }

  async #refreshFailed(connection: ProviderConnection): Promise<never> {
    await this.options.connections.updateStatus(
      connection.id,
      'reconnect_required',
      'CREDENTIAL_REFRESH_FAILED'
    );
    throw new AppError(
      'CONNECTION_RECONNECT_REQUIRED',
      '连接已失效，请重新连接。',
      409
    );
  }
}
