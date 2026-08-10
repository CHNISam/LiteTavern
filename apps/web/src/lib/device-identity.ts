import { createId } from './id';

const DEVICE_ID_KEY = 'litetavern.device-id.v1';

/**
 * Stable browser identity for partitioning guest data. It is never an account id
 * and is never promoted into one when the reader signs in.
 */
export function getOrCreateDeviceId(storage: Storage = localStorage): string {
  const existing = storage.getItem(DEVICE_ID_KEY)?.trim();
  if (existing) return existing;
  const created = globalThis.crypto?.randomUUID?.() ?? createId();
  storage.setItem(DEVICE_ID_KEY, created);
  return created;
}
