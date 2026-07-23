import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface CharacterAssetStore {
  put(key: string, value: Buffer): Promise<string>;
  get(key: string): Promise<Buffer | null>;
}

function safeKey(key: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,199}$/.test(key)) throw new Error('INVALID_ASSET_KEY');
  return key;
}

export function createFileCharacterAssetStore(root: string): CharacterAssetStore {
  return {
    async put(key, value) {
      const checked = safeKey(key);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, checked), value);
      return checked;
    },
    async get(key) {
      try {
        return await readFile(join(root, safeKey(key)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    }
  };
}

export function createMemoryCharacterAssetStore(): CharacterAssetStore {
  const assets = new Map<string, Buffer>();
  return {
    async put(key, value) {
      const checked = safeKey(key);
      assets.set(checked, Buffer.from(value));
      return checked;
    },
    async get(key) {
      const value = assets.get(safeKey(key));
      return value ? Buffer.from(value) : null;
    }
  };
}
