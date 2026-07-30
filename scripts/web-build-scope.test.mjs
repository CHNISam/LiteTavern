import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));

test('v0.1.0 only installs the Web application as an npm workspace', () => {
  assert.deepEqual(packageJson.workspaces, ['apps/web']);
});

test('the Web workspace declares its build-time Node types directly', () => {
  const webPackageJson = JSON.parse(
    readFileSync('apps/web/package.json', 'utf8')
  );
  assert.equal(webPackageJson.devDependencies['@types/node'], 'latest');
});

test('default development and verification scripts target Web explicitly', () => {
  const expectedScripts = {
    dev: 'npm run dev --workspace @litetavern/web',
    build: 'npm run build --workspace @litetavern/web',
    'test:web': 'npm run test --workspace @litetavern/web',
    'test:coverage': 'npm run test:coverage --workspace @litetavern/web',
    typecheck: 'npm run typecheck --workspace @litetavern/web',
    lint: 'eslint apps/web scripts deploy eslint.config.js'
  };

  for (const [name, command] of Object.entries(expectedScripts)) {
    assert.equal(packageJson.scripts[name], command, `${name} must remain Web-only`);
  }

  assert.match(packageJson.scripts.test, /\btest:web\b/);
  assert.doesNotMatch(
    Object.values(packageJson.scripts).join('\n'),
    /--workspaces\b/
  );
});

test('release workflows only package the Web distribution', () => {
  for (const name of ['release-candidate', 'publish-release', 'staging']) {
    const source = readFileSync(`.github/workflows/${name}.yml`, 'utf8');
    assert.match(source, /apps\/web\/dist/);
    assert.doesNotMatch(source, /apps\/desktop|electron|tauri/i);
  }
});
