---
status: complete
priority: p1
issue_id: "001"
tags: [admin, cloud, analytics, security, alpha]
dependencies: []
---

# LiteTavern v0.1.0 minimal admin

## Problem Statement

LiteTavern needs a focused administration surface that answers Alpha release,
core-experience validation, and platform cost/provider sustainability questions
without becoming a generic database or CRM product.

## Findings

- The open repository owns the Pages UI, client feedback entry, and browser-only
  attribution events.
- The private Cloud repository owns Fastify/PGlite auth, Alpha, quota, provider,
  generation, memory, cost, and operator APIs.
- Alpha, quota/cost, supporter claims, thin feedback/blocker registers, and several
  product metrics already exist and must be reused.
- The authoritative v0.1.0 migration and tests currently enforce 10 total seats and
  no second-wave capacity.
- v0.1.0 explicitly has no Free/Pro commercial plan.

## Proposed Solutions

1. Extend the current Fastify/PGlite Cloud service and add a lazy Pages `/admin`
   route. Lowest migration risk and preserves the repository boundary.
2. Migrate the whole Cloud service to Workers/D1 before building admin. High risk,
   duplicates existing capabilities, and is outside the minimal admin objective.

## Recommended Action

Use option 1. Preserve the current 10-seat and no-commercial-plan rules, keep the
existing admin token compatible, centralize authorization, and add append-only
auditing plus focused read/write APIs.

## Acceptance Criteria

- [x] Six lazy-loaded admin modules are available under `/admin`.
- [x] Every admin API is server-authorized and ordinary users are rejected.
- [x] Every high-risk write validates a reason and appends a before/after audit row.
- [x] Alpha, users, feedback, analytics, and provider/runtime views reuse business
      tables rather than client assertions.
- [x] Quota adjustment is ledger-backed and cannot silently overwrite a balance.
- [x] Feedback captures diagnostics without API keys or chat content.
- [x] Relevant unit, API, data, and permission tests pass in both repositories.
- [x] Local and hosted configuration is documented.

## Work Log

### 2026-07-30 - Baseline and repository boundary

**By:** Codex

**Actions:**
- Confirmed both repository roots, HTTPS remotes, branches, and dirty-worktree scope.
- Created isolated `feature/admin-v0.1.0` worktrees from each repository's `develop`.
- Ran the complete client and Cloud baseline test suites.

**Learnings:**
- The open internal-gate D1 deployment is a development skeleton, not the
  authoritative hosted service.
- The current Cloud test suite is intentionally serial and takes about five minutes.

### 2026-07-30 - Implementation and verification

**By:** Codex

**Actions:**
- Added the version 13 Cloud migration, unified admin authentication/audit, focused
  admin APIs, product feedback, attribution fields, business-derived metrics, and
  runtime Provider policy.
- Added the lazy `/admin` UI, all six modules, user detail, audited operator actions,
  and the in-product feedback form.
- Removed privileged token persistence after security review and ensured contact
  values never enter logs or audit snapshots.
- Passed Cloud API (221), contracts (17), database (8), client (125), deployment
  (21), release governance (16), typecheck, lint, branding, and production builds.
