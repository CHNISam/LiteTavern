export interface CredentialLease {
  payload: Uint8Array;
  version: number;
}

export interface CredentialStore {
  save(ref: string, payload: Uint8Array): Promise<{ version: number }>;
  read(ref: string): Promise<CredentialLease | null>;
  compareAndSwap(
    ref: string,
    expectedVersion: number,
    payload: Uint8Array
  ): Promise<{ version: number }>;
  delete(ref: string): Promise<void>;
}

export class CredentialVersionConflictError extends Error {
  constructor(ref: string) {
    super(`Credential version conflict: ${ref}`);
    this.name = 'CredentialVersionConflictError';
  }
}

export class MemoryCredentialStore implements CredentialStore {
  readonly #credentials = new Map<string, CredentialLease>();

  async save(ref: string, payload: Uint8Array): Promise<{ version: number }> {
    const version = (this.#credentials.get(ref)?.version ?? 0) + 1;
    this.#credentials.set(ref, { payload: payload.slice(), version });
    return { version };
  }

  async read(ref: string): Promise<CredentialLease | null> {
    const credential = this.#credentials.get(ref);
    if (!credential) return null;
    return {
      payload: credential.payload.slice(),
      version: credential.version
    };
  }

  async compareAndSwap(
    ref: string,
    expectedVersion: number,
    payload: Uint8Array
  ): Promise<{ version: number }> {
    const current = this.#credentials.get(ref);
    if (!current || current.version !== expectedVersion) {
      throw new CredentialVersionConflictError(ref);
    }
    const version = expectedVersion + 1;
    this.#credentials.set(ref, { payload: payload.slice(), version });
    return { version };
  }

  async delete(ref: string): Promise<void> {
    this.#credentials.delete(ref);
  }
}
