import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertBranchPromotionAllowed,
  assertProductionPromotionAllowed,
  assertRcCreationAllowed,
  assertStableReleaseAllowed,
  parseReleaseTag
} from './release-policy.mjs';

test('main only accepts release and hotfix branches', () => {
  assert.doesNotThrow(() =>
    assertBranchPromotionAllowed({ source: 'release/0.1.0', target: 'main' })
  );
  assert.doesNotThrow(() =>
    assertBranchPromotionAllowed({ source: 'hotfix/0.1.1', target: 'main' })
  );
  assert.throws(
    () => assertBranchPromotionAllowed({ source: 'feature/support', target: 'main' }),
    /release\/\* or hotfix\/\*/
  );
  assert.throws(
    () => assertBranchPromotionAllowed({ source: 'develop', target: 'main' }),
    /release\/\* or hotfix\/\*/
  );
});

test('develop accepts feature, release, and hotfix integration branches', () => {
  for (const source of [
    'feature/support',
    'release/0.1.0',
    'hotfix/0.1.1'
  ]) {
    assert.doesNotThrow(() =>
      assertBranchPromotionAllowed({ source, target: 'develop' })
    );
  }
});

test('release tag parser distinguishes stable and RC tags', () => {
  assert.deepEqual(parseReleaseTag('v1.2.3'), {
    tag: 'v1.2.3',
    version: '1.2.3',
    channel: 'stable',
    rcNumber: null
  });
  assert.deepEqual(parseReleaseTag('v1.2.3-rc.4'), {
    tag: 'v1.2.3-rc.4',
    version: '1.2.3',
    channel: 'rc',
    rcNumber: 4
  });
  assert.throws(() => parseReleaseTag('1.2.3'), /valid release tag/);
  assert.throws(() => parseReleaseTag('v1.2'), /valid release tag/);
  assert.throws(() => parseReleaseTag('v01.2.3'), /valid release tag/);
  assert.throws(() => parseReleaseTag('v1.2.3-rc.0'), /valid release tag/);
});

test('RC creation requires an RC tag matching package version', () => {
  assert.doesNotThrow(() =>
    assertRcCreationAllowed({
      tag: 'v0.1.0-rc.1',
      packageVersion: '0.1.0'
    })
  );
  assert.throws(
    () =>
      assertRcCreationAllowed({
        tag: 'v0.1.0',
        packageVersion: '0.1.0'
      }),
    /RC tag/
  );
  assert.throws(
    () =>
      assertRcCreationAllowed({
        tag: 'v0.2.0-rc.1',
        packageVersion: '0.1.0'
      }),
    /package version/
  );
});

test('production promotion is disabled by default', () => {
  assert.throws(
    () =>
      assertProductionPromotionAllowed({
        tag: 'v0.1.0',
        packageVersion: '0.1.0',
        productionEnabled: false,
        releaseState: 'published'
      }),
    /PRODUCTION_RELEASE_ENABLED/
  );
});

test('stable release requires a stable tag matching package version', () => {
  assert.doesNotThrow(() =>
    assertStableReleaseAllowed({
      tag: 'v0.1.0',
      packageVersion: '0.1.0'
    })
  );
  assert.throws(
    () =>
      assertStableReleaseAllowed({
        tag: 'v0.1.0-rc.2',
        packageVersion: '0.1.0'
      }),
    /stable tag/
  );
});

test('production requires a published stable tag matching package version', () => {
  const base = {
    packageVersion: '0.1.0',
    productionEnabled: true
  };

  assert.doesNotThrow(() =>
    assertProductionPromotionAllowed({
      ...base,
      tag: 'v0.1.0',
      releaseState: 'published'
    })
  );
  assert.throws(
    () =>
      assertProductionPromotionAllowed({
        ...base,
        tag: 'v0.1.0-rc.1',
        releaseState: 'published'
      }),
    /stable tag/
  );
  assert.throws(
    () =>
      assertProductionPromotionAllowed({
        ...base,
        tag: 'v0.2.0',
        releaseState: 'published'
      }),
    /package version/
  );
  assert.throws(
    () =>
      assertProductionPromotionAllowed({
        ...base,
        tag: 'v0.1.0',
        releaseState: 'draft'
      }),
    /published GitHub Release/
  );
});
