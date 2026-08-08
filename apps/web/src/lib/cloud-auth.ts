import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, logout, type AnonymousIdentity } from './api';

export type CloudAccountState =
  | 'restoring'
  | 'authenticated'
  | 'signed_out'
  | 'unavailable';

interface AuthSnapshot {
  state: CloudAccountState;
  account: AnonymousIdentity | null;
}

type RestoreResult =
  | { state: 'authenticated'; account: AnonymousIdentity }
  | { state: 'signed_out' }
  | { state: 'unavailable' };

let restoreInFlight: Promise<RestoreResult> | null = null;

function isEmailAccount(value: unknown): value is AnonymousIdentity {
  if (!value || typeof value !== 'object') return false;
  const user = value as Partial<AnonymousIdentity>;
  return user.identity_type === 'EMAIL'
    && user.registered === true
    && typeof user.user_id === 'string'
    && typeof user.anonymous_id === 'string'
    && typeof user.email === 'string'
    && user.email.length > 0;
}

async function requestRestore(): Promise<RestoreResult> {
  try {
    const response = await api<{ user?: unknown }>('/v1/auth/me');
    if (!isEmailAccount(response.user)) return { state: 'unavailable' };
    return { state: 'authenticated', account: response.user };
  } catch (reason) {
    if (reason instanceof ApiError && reason.status === 401) {
      return { state: 'signed_out' };
    }
    return { state: 'unavailable' };
  }
}

function restoreSingleFlight(): Promise<RestoreResult> {
  if (restoreInFlight) return restoreInFlight;
  restoreInFlight = requestRestore().finally(() => {
    restoreInFlight = null;
  });
  return restoreInFlight;
}

export function useCloudAccount() {
  const [snapshot, setSnapshot] = useState<AuthSnapshot>({
    state: 'restoring',
    account: null
  });
  const mounted = useRef(true);

  const restore = useCallback(async () => {
    const result = await restoreSingleFlight();
    if (!mounted.current) return;
    setSnapshot((current) => {
      if (result.state === 'authenticated') return result;
      if (result.state === 'signed_out') return { state: 'signed_out', account: null };
      return { state: 'unavailable', account: current.account };
    });
  }, []);

  const acceptAuthenticated = useCallback((account: AnonymousIdentity) => {
    if (!isEmailAccount(account)) return;
    setSnapshot({ state: 'authenticated', account });
  }, []);

  const signOut = useCallback(async () => {
    await logout();
    setSnapshot({ state: 'signed_out', account: null });
  }, []);

  useEffect(() => {
    mounted.current = true;
    void restore();
    const retryOnline = () => { void restore(); };
    const retryVisible = () => {
      if (document.visibilityState === 'visible') void restore();
    };
    window.addEventListener('online', retryOnline);
    document.addEventListener('visibilitychange', retryVisible);
    return () => {
      mounted.current = false;
      window.removeEventListener('online', retryOnline);
      document.removeEventListener('visibilitychange', retryVisible);
    };
  }, [restore]);

  return {
    state: snapshot.state,
    account: snapshot.account,
    restore,
    acceptAuthenticated,
    signOut
  };
}

export function resetCloudAccountRestoreForTests(): void {
  restoreInFlight = null;
}
