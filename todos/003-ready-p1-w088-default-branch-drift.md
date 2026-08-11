---
status: ready
priority: p1
issue_id: "003"
tags: [ci, github-actions, branching, deployment, release, w088]
dependencies: []
---

# W088 client: release workflows are absent from the default branch

## Problem Statement

`origin/main` is the repository's default branch and contains a single file,
`LICENSE`. Every workflow except CI and Deploy lives only on `develop`. A
`workflow_dispatch` workflow must exist on the default branch to be dispatchable, so
`production.yml`, `rollback.yml`, `publish-release.yml` and `release-candidate.yml`
cannot be triggered at all. The documented release path from `main` has never worked.

## Findings

- `git ls-tree origin/main` returns `LICENSE` and nothing else. Its history is one
  commit, `Initial commit`.
- `git log --oneline origin/main..origin/develop` is 126 commits.
- `git ls-tree -r origin/main -- .github` is empty; all seven workflow files exist
  only on `develop`.
- `gh workflow list --all` shows only `CI` and `Deploy` as registered, because those
  are the two that have ever run (both trigger on push to `develop`). The five
  release-path workflows are unknown to GitHub Actions.
- The repository is **public**, and `develop` is already a public branch, so this is
  not a question of disclosure — merging publishes no code that is not already
  visible. It changes which tree the default branch, and therefore the repository
  landing page and any default-branch clone, presents.
- Blockers beyond the branch itself:
  - No version tags exist (`git ls-remote --tags` returns only
    `archive/cloudflare-deployment`) and `gh release list` is empty.
    `production.yml` requires a published, non-draft, non-prerelease `stable_tag`.
  - Repository variable `PRODUCTION_RELEASE_ENABLED` is `false`, which
    `scripts/release-policy.mjs` treats as a hard stop.
- Staging is **not** blocked by the branch drift. `staging.yml` triggers on push to
  `release/**` / `hotfix/**`, and a push trigger only needs the workflow file on the
  branch being pushed. Cutting `release/x.y.z` from `develop` makes staging run
  immediately. The five GitHub Environments (`internal`, `production`, `release`,
  `release-candidate`, `staging`) and all six repository variables already exist.

## Proposed Solutions

### Option 1: Merge `develop` into `main`, then run the release path in order

**Approach:** Merge `develop` into `main` so the default branch holds the real tree
and the release workflows become dispatchable. Then cut `release/x.y.z` (staging
deploys on push), publish a release candidate, publish the stable tag, and only then
flip `PRODUCTION_RELEASE_ENABLED` to `true` and dispatch production.

**Pros:** Restores the designed pipeline without weakening any guard. The repository
landing page stops showing an empty project, which for a public repository is also a
credibility problem.

**Cons:** One large first merge, and `main` becomes the branch an operator can deploy
production from.

**Effort:** Merge is minutes. The release sequence afterwards is a real release.

**Risk:** Medium. Reversing a default-branch merge on a public repository means a
force-push, which is destructive.

### Option 2: Cut a release branch now and leave `main` alone

**Approach:** Cut `release/x.y.z` from `develop` to unblock staging only, and defer
the `main` merge until an actual production release is wanted.

**Pros:** Zero irreversible action; gets the staging environment exercised, which is
the thing that has never been verified.

**Cons:** Production and rollback stay unreachable; the public landing page stays
empty.

**Effort:** Minutes.

**Risk:** Low.

## Recommended Action

Option 2 first, then Option 1 when a release is actually intended. Both require human
approval — the `main` merge is a release decision on a public repository and must not
be performed autonomously. Option 2 is the cheap way to finally exercise staging and
Cloudflare Access before committing to anything irreversible.

## Technical Details

**Affected files:**
- `.github/workflows/{production,rollback,publish-release,release-candidate}.yml`
  (unchanged; they need to exist on `main`, not to be edited)
- Repository variable `PRODUCTION_RELEASE_ENABLED`

**Database changes:** None.

## Acceptance Criteria

- [ ] `origin/main` contains the deployable tree rather than `LICENSE` alone.
- [ ] `gh workflow list --all` lists the release-path workflows.
- [ ] A `release/x.y.z` branch exists and its push has deployed the protected staging
      alias `https://staging.litetavern-dev.pages.dev` successfully.
- [ ] A published, non-draft, non-prerelease stable tag exists.
- [ ] `PRODUCTION_RELEASE_ENABLED` is `true` only at the moment production is meant
      to be deployable.

## Work Log

### 2026-08-12 - Audit

**By:** Claude

**Actions:**
- Compared `origin/main` and `origin/develop` trees and workflow inventories.
- Enumerated GitHub Environments, repository variables and their values, remote tags
  and releases.
- Read `staging.yml` and confirmed staging is reachable today via a `release/*` push,
  independently of the default-branch problem.
- Ran `npm run check`: typecheck, lint, 73 test files / 333 tests, deployment tests,
  branding, release-policy tests and build all pass on `develop`.

**Learnings:**
- The drift is not uniform. Staging was blocked only by the absence of a release
  branch; production is blocked by three independent things at once (workflow not on
  the default branch, no published tag, release flag off). Treating "分支漂移" as one
  fix would have unblocked none of them.

## Notes

- The Cloud repository has the same class of drift; see its `todos/002`.
