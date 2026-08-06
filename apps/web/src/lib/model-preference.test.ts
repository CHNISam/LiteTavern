import { afterEach, describe, expect, it } from 'vitest';
import {
  readModelPreference,
  writeModelPreference
} from './model-preference';

afterEach(() => localStorage.clear());

describe('model preference persistence', () => {
  it('restores the selected mode and configuration after a reload', () => {
    writeModelPreference({ usageMode: 'BYOK', configurationId: 'config-1' });
    expect(readModelPreference()).toEqual({
      usageMode: 'BYOK',
      configurationId: 'config-1'
    });
  });

  it('falls back safely when storage is malformed', () => {
    localStorage.setItem('litetavern.model-preference.v1', '{bad json');
    expect(readModelPreference()).toEqual({
      usageMode: 'PLATFORM',
      configurationId: ''
    });
  });
});
