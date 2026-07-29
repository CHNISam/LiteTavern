import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateDeploymentEnvironment } from './validate-deployment-env.mjs';

test('rejects a hosted deployment without a Cloud API URL', () => {
  assert.throws(
    () =>
      validateDeploymentEnvironment({
        apiMode: '',
        cloudBaseUrl: '',
        refName: 'develop'
      }),
    /VITE_CLOUD_BASE_URL/
  );
});

test('rejects an unsafe or non-HTTPS Cloud API URL', () => {
  for (const cloudBaseUrl of ['javascript:alert(1)', 'http://api.example.com']) {
    assert.throws(
      () =>
        validateDeploymentEnvironment({
          apiMode: '',
          cloudBaseUrl,
          refName: 'develop'
        }),
      /HTTPS/
    );
  }
});

test('accepts an explicit HTTPS Cloud API URL', () => {
  assert.doesNotThrow(() =>
    validateDeploymentEnvironment({
      apiMode: '',
      cloudBaseUrl: 'https://api-internal.litetavern.example',
      refName: 'develop'
    })
  );
});

test('accepts the explicitly configured same-origin Worker for internal only', () => {
  assert.doesNotThrow(() =>
    validateDeploymentEnvironment({
      apiMode: 'same-origin-worker',
      cloudBaseUrl: '',
      refName: 'develop'
    })
  );
  assert.throws(
    () =>
      validateDeploymentEnvironment({
        apiMode: 'same-origin-worker',
        cloudBaseUrl: '',
        refName: 'main'
      }),
    /VITE_CLOUD_BASE_URL/
  );
});

test('CLI exits non-zero before a hosted deployment can publish without an API', () => {
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL('./validate-deployment-env.mjs', import.meta.url))],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_REF_NAME: 'develop',
        HOSTED_API_MODE: '',
        VITE_CLOUD_BASE_URL: ''
      }
    }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /VITE_CLOUD_BASE_URL/);
});
