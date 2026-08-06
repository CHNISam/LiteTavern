export interface ModelPreference {
  usageMode: 'PLATFORM' | 'BYOK';
  configurationId: string;
}

const KEY = 'litetavern.model-preference.v1';
const DEFAULT: ModelPreference = {
  usageMode: 'PLATFORM',
  configurationId: ''
};

export function readModelPreference(): ModelPreference {
  if (typeof localStorage === 'undefined') return DEFAULT;
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '') as Partial<ModelPreference>;
    return {
      usageMode: value.usageMode === 'BYOK' ? 'BYOK' : 'PLATFORM',
      configurationId:
        typeof value.configurationId === 'string' ? value.configurationId : ''
    };
  } catch {
    return DEFAULT;
  }
}

export function writeModelPreference(preference: ModelPreference): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(KEY, JSON.stringify(preference));
}
