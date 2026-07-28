/* global Response */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertAccessChallenge,
  assertHtmlResponse,
  normalizeDeploymentUrl,
  routeUrl
} from './verify-deployment.mjs';

test('deployment URL accepts HTTPS and local HTTP only', () => {
  assert.equal(
    normalizeDeploymentUrl('https://staging.example.com/path').href,
    'https://staging.example.com/path'
  );
  assert.equal(
    normalizeDeploymentUrl('http://127.0.0.1:4173').href,
    'http://127.0.0.1:4173/'
  );
  assert.throws(
    () => normalizeDeploymentUrl('javascript:alert(1)'),
    /HTTPS/
  );
  assert.throws(
    () => normalizeDeploymentUrl('http://staging.example.com'),
    /HTTPS/
  );
});

test('route URL preserves origin and safely applies route path', () => {
  assert.equal(
    routeUrl('https://staging.example.com/base', '/support?source=github').href,
    'https://staging.example.com/support?source=github'
  );
});

test('HTML response requires success, HTML content type, and LiteTavern shell', async () => {
  const response = new Response('<!doctype html><title>LiteTavern</title>', {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' }
  });
  await assert.doesNotReject(() => assertHtmlResponse(response, '/support'));

  await assert.rejects(
    () =>
      assertHtmlResponse(
        new Response('not found', {
          status: 404,
          headers: { 'content-type': 'text/plain' }
        }),
        '/support'
      ),
    /status 404/
  );
});

test('Access protection accepts redirects to Cloudflare Access or authorization errors', () => {
  assert.doesNotThrow(() =>
    assertAccessChallenge(
      new Response(null, {
        status: 302,
        headers: {
          location:
            'https://example.cloudflareaccess.com/cdn-cgi/access/login/app'
        }
      })
    )
  );
  assert.doesNotThrow(() => assertAccessChallenge(new Response(null, { status: 403 })));
  assert.throws(
    () =>
      assertAccessChallenge(
        new Response('<title>LiteTavern</title>', {
          status: 200,
          headers: { 'content-type': 'text/html' }
        })
      ),
    /publicly reachable/
  );
});
