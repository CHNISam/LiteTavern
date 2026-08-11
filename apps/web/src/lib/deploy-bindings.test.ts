import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

// apps/web/src/lib -> repository root
const root = resolve(import.meta.dirname, '../../../..');

/**
 * Strips `//` line comments from JSONC without touching sequences inside string
 * literals, so a config value that happens to contain `//` survives.
 */
function stripLineComments(source: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    out += char;
  }
  return out;
}

interface PagesConfig {
  name: string;
  pages_build_output_dir: string;
  services?: { binding: string; service: string; environment?: string }[];
}

function readPagesConfig(environment: string): PagesConfig {
  const source = readFileSync(
    resolve(root, 'deploy', environment, 'wrangler.jsonc'),
    'utf8'
  );
  return JSON.parse(stripLineComments(source)) as PagesConfig;
}

// The Cloud Worker is `litetavern-cloud` with named Wrangler environments;
// `wrangler deploy --env <name>` publishes each one under the flattened Worker
// name asserted here. A Pages project bound to the wrong one would deploy and
// serve successfully while reading another environment's database.
const EXPECTED_CLOUD_SERVICE: Record<string, string> = {
  development: 'litetavern-cloud-development',
  staging: 'litetavern-cloud-staging',
  production: 'litetavern-cloud-production'
};

describe('Pages -> Cloud Worker service bindings', () => {
  for (const [environment, service] of Object.entries(EXPECTED_CLOUD_SERVICE)) {
    it(`binds ${environment} to its own Cloud Worker`, () => {
      const config = readPagesConfig(environment);
      expect(config.services).toHaveLength(1);
      const binding = config.services?.[0];
      expect(binding?.binding).toBe('CLOUD');
      expect(binding?.service).toBe(service);
    });

    it(`does not use the removed service-binding environment key in ${environment}`, () => {
      // Wrangler 4 service bindings are `additionalProperties: false` and define no
      // `environment`. Adding one to "be explicit" breaks config validation, so the
      // environment must stay encoded in the service name above.
      expect(readPagesConfig(environment).services?.[0]).not.toHaveProperty(
        'environment'
      );
    });
  }

  it('keeps every environment on a distinct Pages project and Worker', () => {
    const projects = Object.keys(EXPECTED_CLOUD_SERVICE).map(
      (environment) => readPagesConfig(environment).name
    );
    expect(new Set(projects).size).toBe(projects.length);
    expect(new Set(Object.values(EXPECTED_CLOUD_SERVICE)).size).toBe(
      Object.keys(EXPECTED_CLOUD_SERVICE).length
    );
  });
});
