import { describe, expect, it } from 'vitest';
import { shouldWriteGithubPagesFallback } from '../vite.config';

describe('GitHub Pages build fallback', () => {
  it('only writes 404.html for an explicit GitHub Pages build', () => {
    expect(shouldWriteGithubPagesFallback('github-pages')).toBe(true);
    expect(shouldWriteGithubPagesFallback('cloudflare-pages')).toBe(false);
    expect(shouldWriteGithubPagesFallback(undefined)).toBe(false);
  });
});
