/* global Response */

import assert from 'node:assert/strict';
import test from 'node:test';

import productionWorker from '../deploy/production-worker.js';

test('production forwards Cloud-owned paths through the service binding', async () => {
  let forwarded;
  const request = new Request('https://litetavern.pages.dev/v1/auth/me', {
    headers: { cookie: 'lt_session=opaque' }
  });
  const response = await productionWorker.fetch(request, {
    CLOUD: {
      async fetch(candidate) {
        forwarded = candidate;
        return new Response('cloud');
      }
    },
    ASSETS: { fetch: () => Promise.resolve(new Response('asset')) }
  });

  assert.equal(await response.text(), 'cloud');
  assert.equal(forwarded, request);
});

test('production keeps non-Cloud paths on the Pages asset binding', async () => {
  let cloudCalls = 0;
  const response = await productionWorker.fetch(
    new Request('https://litetavern.pages.dev/characters', {
      headers: { accept: 'text/html' }
    }),
    {
      CLOUD: { fetch: async () => { cloudCalls += 1; return new Response('cloud'); } },
      ASSETS: { fetch: async () => new Response('asset') }
    }
  );

  assert.equal(cloudCalls, 0);
  assert.equal(await response.text(), 'asset');
});

test('production fails closed when its Cloud binding is absent', async () => {
  const response = await productionWorker.fetch(
    new Request('https://litetavern.pages.dev/v1/cloud/status'),
    { ASSETS: { fetch: async () => new Response('asset') } }
  );

  assert.equal(response.status, 503);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).error.code, 'CLOUD_BINDING_MISSING');
});
