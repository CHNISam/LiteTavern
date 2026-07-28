/* global console, process */

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const BRANCH_PATTERN = /^[a-z0-9][a-z0-9._/-]*$/;
const VERSION_PART = '(0|[1-9]\\d*)';
const STABLE_TAG_PATTERN = new RegExp(
  `^v${VERSION_PART}\\.${VERSION_PART}\\.${VERSION_PART}$`
);
const RC_TAG_PATTERN = new RegExp(
  `^v${VERSION_PART}\\.${VERSION_PART}\\.${VERSION_PART}-rc\\.([1-9]\\d*)$`
);

function policyError(message) {
  return new Error(`Release policy violation: ${message}`);
}

export function parseReleaseTag(tag) {
  const stable = STABLE_TAG_PATTERN.exec(tag);
  if (stable) {
    return {
      tag,
      version: `${stable[1]}.${stable[2]}.${stable[3]}`,
      channel: 'stable',
      rcNumber: null
    };
  }

  const rc = RC_TAG_PATTERN.exec(tag);
  if (rc) {
    return {
      tag,
      version: `${rc[1]}.${rc[2]}.${rc[3]}`,
      channel: 'rc',
      rcNumber: Number(rc[4])
    };
  }

  throw policyError(
    `"${tag}" is not a valid release tag (expected vX.Y.Z or vX.Y.Z-rc.N)`
  );
}

function assertBranchName(branch, label) {
  if (!BRANCH_PATTERN.test(branch) || branch.includes('..') || branch.includes('//')) {
    throw policyError(`${label} branch name is invalid`);
  }
}

export function assertBranchPromotionAllowed({ source, target }) {
  assertBranchName(source, 'source');
  assertBranchName(target, 'target');

  if (target === 'main') {
    if (!/^(release|hotfix)\/[a-z0-9][a-z0-9._-]*$/.test(source)) {
      throw policyError('main only accepts release/* or hotfix/* branches');
    }
    return;
  }

  if (target === 'develop') {
    if (!/^(feature|release|hotfix)\/[a-z0-9][a-z0-9._/-]*$/.test(source)) {
      throw policyError(
        'develop only accepts feature/*, release/*, or hotfix/* branches'
      );
    }
    return;
  }

  throw policyError(`unsupported protected target branch "${target}"`);
}

function assertPackageVersion(tagInfo, packageVersion) {
  if (tagInfo.version !== packageVersion) {
    throw policyError(
      `tag version ${tagInfo.version} does not match package version ${packageVersion}`
    );
  }
}

export function assertRcCreationAllowed({ tag, packageVersion }) {
  const tagInfo = parseReleaseTag(tag);
  if (tagInfo.channel !== 'rc') {
    throw policyError('candidate creation requires an RC tag');
  }
  assertPackageVersion(tagInfo, packageVersion);
}

export function assertStableReleaseAllowed({ tag, packageVersion }) {
  const tagInfo = parseReleaseTag(tag);
  if (tagInfo.channel !== 'stable') {
    throw policyError('release publication requires a stable tag');
  }
  assertPackageVersion(tagInfo, packageVersion);
}

export function assertProductionPromotionAllowed({
  tag,
  packageVersion,
  productionEnabled,
  releaseState
}) {
  if (!productionEnabled) {
    throw policyError(
      'PRODUCTION_RELEASE_ENABLED must be explicitly set to true'
    );
  }

  assertStableReleaseAllowed({ tag, packageVersion });

  if (releaseState !== 'published') {
    throw policyError('production promotion requires a published GitHub Release');
  }
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1] || args[index + 1].startsWith('--')) {
    throw policyError(`missing ${name}`);
  }
  return args[index + 1];
}

function packageVersion(packagePath) {
  const packageJson = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (typeof packageJson.version !== 'string') {
    throw policyError(`${packagePath} does not contain a string version`);
  }
  return packageJson.version;
}

function runCli(args) {
  const [command] = args;
  if (command === 'branch') {
    assertBranchPromotionAllowed({
      source: option(args, '--source'),
      target: option(args, '--target')
    });
  } else if (command === 'rc') {
    assertRcCreationAllowed({
      tag: option(args, '--tag'),
      packageVersion: packageVersion(option(args, '--package'))
    });
  } else if (command === 'production') {
    assertProductionPromotionAllowed({
      tag: option(args, '--tag'),
      packageVersion: packageVersion(option(args, '--package')),
      productionEnabled: process.env.PRODUCTION_RELEASE_ENABLED === 'true',
      releaseState: option(args, '--release-state')
    });
  } else if (command === 'stable') {
    assertStableReleaseAllowed({
      tag: option(args, '--tag'),
      packageVersion: packageVersion(option(args, '--package'))
    });
  } else {
    throw policyError('command must be branch, rc, stable, or production');
  }

  console.log(`Release policy passed for ${command}.`);
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
