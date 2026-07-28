export interface SaveCredentialInput {
  provider: string;
  label: string;
  apiKey: string;
}

export interface CredentialSummary {
  credentialId: string;
  provider: string;
  label: string;
  maskedKey: string;
  updatedAt: string;
}

interface StoredCredential {
  credentialId: string;
  provider: string;
  label: string;
  apiKey: string;
  createdAt: string;
  updatedAt: string;
}

const STORE_NAME = 'credentials';

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function maskKey(apiKey: string): string {
  if (apiKey.length <= 8) return '••••••••';
  return `${apiKey.slice(0, 4)}••••${apiKey.slice(-4)}`;
}

export class BrowserCredentialStore {
  constructor(private readonly databaseName = 'litetavern-credentials') {}

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          const store = request.result.createObjectStore(STORE_NAME, {
            keyPath: 'credentialId'
          });
          store.createIndex('provider', 'provider', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async save(input: SaveCredentialInput): Promise<CredentialSummary> {
    const database = await this.open();
    try {
      const now = new Date().toISOString();
      const credential: StoredCredential = {
        credentialId: createId(),
        provider: input.provider,
        label: input.label,
        apiKey: input.apiKey,
        createdAt: now,
        updatedAt: now
      };
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(credential);
      await transactionDone(transaction);
      return this.toSummary(credential);
    } finally {
      database.close();
    }
  }

  async list(): Promise<CredentialSummary[]> {
    const database = await this.open();
    try {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const records = await requestResult(
        transaction.objectStore(STORE_NAME).getAll() as IDBRequest<StoredCredential[]>
      );
      await transactionDone(transaction);
      return records
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map((record) => this.toSummary(record));
    } finally {
      database.close();
    }
  }

  async readSecret(credentialId: string): Promise<string | null> {
    const database = await this.open();
    try {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const credential = await requestResult(
        transaction.objectStore(STORE_NAME).get(credentialId) as IDBRequest<
          StoredCredential | undefined
        >
      );
      await transactionDone(transaction);
      return credential?.apiKey ?? null;
    } finally {
      database.close();
    }
  }

  async update(credentialId: string, apiKey: string): Promise<CredentialSummary> {
    const database = await this.open();
    try {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const credential = await requestResult(
        store.get(credentialId) as IDBRequest<StoredCredential | undefined>
      );
      if (!credential) {
        transaction.abort();
        throw new Error('CREDENTIAL_NOT_FOUND');
      }
      const updated = { ...credential, apiKey, updatedAt: new Date().toISOString() };
      store.put(updated);
      await transactionDone(transaction);
      return this.toSummary(updated);
    } finally {
      database.close();
    }
  }

  async remove(credentialId: string): Promise<void> {
    const database = await this.open();
    try {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(credentialId);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  private toSummary(credential: StoredCredential): CredentialSummary {
    return {
      credentialId: credential.credentialId,
      provider: credential.provider,
      label: credential.label,
      maskedKey: maskKey(credential.apiKey),
      updatedAt: credential.updatedAt
    };
  }
}

export const credentialStore = new BrowserCredentialStore();
import { createId } from './id';
