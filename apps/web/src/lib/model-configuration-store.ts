import type { ModelConfiguration } from './api';
import { createId } from './id';

const DATABASE_NAME = 'litetavern-model-configurations';
const CONFIGURATIONS = 'configurations';
const META = 'meta';
const LEGACY_MIGRATION = 'legacy-cloud-model-configurations-v1';

type ConfigurationInput = Omit<ModelConfiguration,
  'model_configuration_id' | 'credential_configured'>;

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

export class ModelConfigurationStore {
  constructor(private readonly databaseName = DATABASE_NAME) {}

  private open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(CONFIGURATIONS)) {
          request.result.createObjectStore(CONFIGURATIONS, {
            keyPath: 'model_configuration_id'
          });
        }
        if (!request.result.objectStoreNames.contains(META)) {
          request.result.createObjectStore(META, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async list(): Promise<ModelConfiguration[]> {
    const database = await this.open();
    try {
      const transaction = database.transaction(CONFIGURATIONS, 'readonly');
      const records = await requestResult(transaction.objectStore(CONFIGURATIONS).getAll()) as ModelConfiguration[];
      await transactionDone(transaction);
      return records;
    } finally { database.close(); }
  }

  async save(input: ConfigurationInput): Promise<ModelConfiguration> {
    const configuration: ModelConfiguration = {
      ...input,
      model_configuration_id: createId(),
      credential_configured: true
    };
    const database = await this.open();
    try {
      const transaction = database.transaction(CONFIGURATIONS, 'readwrite');
      transaction.objectStore(CONFIGURATIONS).put(configuration);
      await transactionDone(transaction);
      return configuration;
    } finally { database.close(); }
  }

  async remove(configurationId: string): Promise<void> {
    const database = await this.open();
    try {
      const transaction = database.transaction(CONFIGURATIONS, 'readwrite');
      transaction.objectStore(CONFIGURATIONS).delete(configurationId);
      await transactionDone(transaction);
    } finally { database.close(); }
  }

  async migrateLegacyOnce(fetcher: typeof fetch = fetch): Promise<void> {
    const database = await this.open();
    try {
      const read = database.transaction(META, 'readonly');
      const completed = await requestResult(read.objectStore(META).get(LEGACY_MIGRATION));
      await transactionDone(read);
      if (completed) return;
    } finally { database.close(); }

    const response = await fetcher('/v1/model-configurations', { credentials: 'include' });
    if (!response.ok && response.status !== 404) throw new Error('LEGACY_MODEL_CONFIGURATION_READ_FAILED');
    const payload = response.status === 404
      ? { configurations: [] }
      : await response.json() as { configurations?: ModelConfiguration[] };
    const migrated = Array.isArray(payload.configurations) ? payload.configurations : [];
    const target = await this.open();
    try {
      const transaction = target.transaction([CONFIGURATIONS, META], 'readwrite');
      const configurations = transaction.objectStore(CONFIGURATIONS);
      for (const configuration of migrated) configurations.put(configuration);
      transaction.objectStore(META).put({ key: LEGACY_MIGRATION, completed_at: new Date().toISOString() });
      await transactionDone(transaction);
    } finally { target.close(); }
  }

  async reset(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(this.databaseName);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => resolve();
    });
  }
}

export const modelConfigurationStore = new ModelConfigurationStore();
