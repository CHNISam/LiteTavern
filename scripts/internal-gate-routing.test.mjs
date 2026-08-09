/**
 * Which paths the internal gateway hands to LiteTavern Cloud.
 *
 * This is the repository boundary expressed as a routing table, and it is worth
 * asserting because getting it wrong does not look like an outage. When the
 * gateway answered `/v1/providers` itself with an empty list, every request
 * succeeded with a 200 — and the reader was told "provider catalogue is empty,
 * check LiteTavern Cloud", blaming Cloud for a stub in the client repository.
 * A path that Cloud owns and this file answers is a silent fork of the
 * contract, so the list is pinned here rather than left to review.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { isCloudPath } from '../deploy/cloud-gateway.js';

test('accounts, quota and the model gateway are forwarded to Cloud', () => {
  for (const path of [
    '/v1/auth/email-code/send',
    '/v1/auth/email-code/verify',
    '/v1/auth/logout',
    // Product feedback is persisted and reviewed in LiteTavern Cloud. Keeping it
    // on the client-side gate makes a successful Cloud deployment look like a 404.
    '/v1/feedback',
    '/v1/cloud/status',
    // The catalogue decides which endpoint a provider id may reach, and the
    // connection check calls that endpoint with the reader's key.
    '/v1/providers',
    '/v1/provider-connections/validate',
    '/v1/conversations/conversation-1/generations',
    // The transcript. It used to be answered here, and that split is what produced
    // the failure this list exists to prevent: generation ran against Cloud's
    // database while the conversation was read from this deployment's, so nothing
    // ever wrote a reply where the client looked for it. A reply streamed in and
    // then disappeared on the next read, with quota correctly spent.
    //
    // It is Cloud's for a product reason too: a conversation has to survive the tab
    // that produced it and reappear on a second device, which is cloud sync.
    '/v1/conversations',
    '/v1/conversations/conversation-1/messages',
    // Swipe. The variant list and the activation both live in Cloud's `chat_message`,
    // so answering them here would describe a transcript this deployment never wrote.
    '/v1/conversations/conversation-1/messages/message-1/variants',
    '/v1/conversations/conversation-1/messages/message-1/activate',
    // 代写. A model call over the transcript, so it belongs where both live. It was
    // missing from this table and the gate's own 503 answered it instead, telling the
    // reader the model service was not enabled.
    '/v1/conversations/conversation-1/reply-suggestions'
  ]) {
    assert.equal(isCloudPath(path), true, path);
  }
});

test('local content stays local', () => {
  for (const path of [
    // Characters, model configuration and analytics are still this deployment's.
    // They move in the migration stage of
    // `docs/plans/2026-08-08-chat-infrastructure-rebuild.md`, not before.
    '/v1/characters',
    '/v1/model-configurations',
    '/v1/analytics/events',
    '/v1/cloud/sync/checkpoint'
  ]) {
    assert.equal(isCloudPath(path), false, path);
  }
});

test('the conversation patterns do not over-match', () => {
  assert.equal(isCloudPath('/v1/conversations/c1/generations'), true);
  assert.equal(isCloudPath('/v1/conversations/c1/messages'), true);
  assert.equal(isCloudPath('/v1/conversations/c1/generations/extra'), false);
  assert.equal(isCloudPath('/v1/conversations/c1/reply-suggestions'), true);
  assert.equal(isCloudPath('/v1/conversations/c1/reply-suggestions/extra'), false);
  // The legacy structured turn endpoint is not Cloud's. It stays a 503 on the gate,
  // which is the client's signal to stop using it.
  assert.equal(isCloudPath('/v1/conversations/c1/turns'), false);
  // A single message is not the transcript; deleting one is still answered locally
  // until characters move too.
  assert.equal(isCloudPath('/v1/conversations/c1/messages/m1'), false);
  assert.equal(isCloudPath('/v1/conversations/c1/messages/m1/variants'), true);
  assert.equal(isCloudPath('/v1/conversations/c1/messages/m1/activate'), true);
  // Only those two verbs on a message. An unknown suffix is not forwarded, so a
  // future Cloud route has to be added here deliberately rather than inherited.
  assert.equal(isCloudPath('/v1/conversations/c1/messages/m1/variants/extra'), false);
  assert.equal(isCloudPath('/v1/conversations/c1/messages/m1/branches'), false);
});
