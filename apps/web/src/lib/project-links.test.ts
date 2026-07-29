import { describe, expect, it } from 'vitest';
import { DEFAULT_GITHUB_URL, resolveGithubUrl } from './project-links';

describe('project links', () => {
  it('falls back to the canonical repository when unset or unsafe', () => {
    expect(resolveGithubUrl({}, 'https://litetavern.example')).toBe(DEFAULT_GITHUB_URL);
    expect(
      resolveGithubUrl({ VITE_GITHUB_URL: 'javascript:alert(1)' }, 'https://litetavern.example')
    ).toBe(DEFAULT_GITHUB_URL);
  });

  it('accepts a configured repository URL', () => {
    expect(
      resolveGithubUrl(
        { VITE_GITHUB_URL: 'https://github.com/example/fork' },
        'https://litetavern.example'
      )
    ).toBe('https://github.com/example/fork');
  });
});
