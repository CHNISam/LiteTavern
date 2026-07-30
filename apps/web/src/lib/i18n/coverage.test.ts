import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from './en';
import { zhCN } from './zh-CN';

const SOURCE_ROOT = join(__dirname, '..', '..');

/**
 * Files that legitimately contain Chinese and must not be translated.
 *
 * Each entry states why, because "add it to the allowlist" is otherwise the
 * easiest way to quietly undo this test.
 */
const EXEMPT: { path: string; reason: string }[] = [
  {
    path: join('lib', 'migration-prompts.ts'),
    reason:
      'A prompt sent to a model, not copy shown to a reader. Translating it would ' +
      'change extraction behaviour rather than the interface.'
  },
  {
    path: join('lib', 'i18n'),
    reason: 'The dictionaries themselves.'
  },
  {
    path: join('lib', 'analytics.ts'),
    reason:
      'Contains a referrer-matching pattern ("米游社"). It matches a string the ' +
      'browser reports, so it is data to compare against, not copy to show.'
  },
  {
    path: 'admin',
    reason:
      'The operator console. It is used by the project team rather than by ' +
      'readers of the product, so it is deliberately out of the localisation scope.'
  },
  {
    path: 'test',
    reason: 'Test fixtures, never rendered outside tests.'
  }
];

const CHINESE = /[一-鿿]/;

/** Strips comments and import specifiers so only real copy is inspected. */
function strippedSource(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .split('\n')
    .filter((line) => !/^\s*import\s/.test(line))
    .join('\n');
}

function sourceFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, found);
      continue;
    }
    if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
    found.push(full);
  }
  return found;
}

function isExempt(relativePath: string): boolean {
  return EXEMPT.some(
    (entry) => relativePath === entry.path || relativePath.startsWith(entry.path + sep)
  );
}

describe('locale coverage', () => {
  /**
   * The completeness guarantee. A hardcoded Chinese string is a string an English
   * reader will meet in Chinese, so it fails here rather than shipping and being
   * discovered by that reader.
   */
  it('leaves no hardcoded Chinese copy in the localised surfaces', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SOURCE_ROOT)) {
      const relativePath = relative(SOURCE_ROOT, file);
      if (isExempt(relativePath)) continue;
      const stripped = strippedSource(readFileSync(file, 'utf8'));
      stripped.split('\n').forEach((line, index) => {
        if (CHINESE.test(line)) offenders.push(`${relativePath}:${index + 1}  ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('documents why every exemption exists', () => {
    for (const entry of EXEMPT) {
      expect(entry.reason.length).toBeGreaterThan(20);
    }
  });

  /**
   * `Dictionary` already makes a missing key a compile error, so this covers the
   * one thing types cannot: a key that was translated by copying the Chinese.
   */
  it('translates every leaf rather than copying the source locale', () => {
    const untranslated: string[] = [];

    function walk(source: unknown, target: unknown, path: string) {
      if (typeof source === 'string') {
        if (CHINESE.test(source) && source === target) untranslated.push(path);
        return;
      }
      if (typeof source === 'function') {
        // Compare rendered output using placeholder arguments.
        const sample = (value: unknown) =>
          (value as (...args: unknown[]) => string)('X', 1, 2, 3, 4);
        try {
          const rendered = sample(source);
          if (CHINESE.test(rendered) && rendered === sample(target)) untranslated.push(path);
        } catch {
          // A signature this probe cannot satisfy is covered by the type system.
        }
        return;
      }
      if (source && typeof source === 'object') {
        for (const key of Object.keys(source as Record<string, unknown>)) {
          walk(
            (source as Record<string, unknown>)[key],
            (target as Record<string, unknown>)?.[key],
            path ? `${path}.${key}` : key
          );
        }
      }
    }

    walk(zhCN, en, '');
    expect(untranslated).toEqual([]);
  });
});
