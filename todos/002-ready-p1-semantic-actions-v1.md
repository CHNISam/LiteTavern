---
status: ready
priority: p1
issue_id: "002"
tags: [chat, generation, diagnostics, semantic-actions, streaming]
dependencies: []
---

# Chat core semantic actions v1

## Problem Statement

The production `/generations` path can only render one accumulated assistant bubble,
permits long output, and does not expose enough privacy-safe evidence to identify where
repeated or corrupted text first appears.

## Findings

- The Web client appends every legacy SSE delta into one transient assistant message.
- The existing playback controller supports a queue but is only used by `/turns` fallback.
- Worker streaming defaults are `temperature=0.8` and `maxOutputTokens=2048`.
- Provider, adapter, SSE, persistence, runtime, and UI text do not yet have correlated
  length/hash evidence.
- Existing Product Feedback work remains outside this isolated branch by user choice.

## Proposed Solutions

1. Upgrade `/generations` through protocol negotiation, preserving its auth, quota,
   idempotency, persistence, and BYOK pipeline. Lowest duplication and recommended.
2. Promote legacy `/turns` and duplicate or move the production pipeline. Higher drift
   and compatibility risk.

## Recommended Action

Implement option 1 in gated phases: privacy-safe tracing and reproduction support,
strict generation-config comparison artifacts, evidence-backed fixes, then
`semantic_actions_v1`, atomic multi-message persistence, playback integration, and
versioned guards.

## Technical Details

- Client worktree: `D:\tmp\litetavern-semantic-actions-v1`
- Cloud worktree: `D:\tmp\litetavern-cloud-semantic-actions-v1`
- No Cloud migration is expected for semantic text actions.
- `max_actions=4` is a versioned v0.1.0 policy, not a permanent model rule.

## Acceptance Criteria

- [x] A diagnostic turn can export hashes, lengths, sequence data, provider/model,
      normalized generation config, finish state, and usage without chat text or keys.
- [ ] Strict LiteTavern/SillyTavern comparison fixtures preserve identical config.
- [x] Legacy deltas use monotonic sequence numbers and duplicate sequence handling.
- [ ] `semantic_actions_v1` returns one validated complete turn from one model call.
- [ ] Actions persist atomically as grouped assistant messages and replay in order.
- [ ] Validator, persistence, and runtime tests pass with action caps 1, 2, and 4.
- [ ] Relevant tests, full checks where feasible, and repository status audits complete.

## Work Log

### 2026-08-09 - Repository gate and baseline

**By:** Codex

**Actions:**
- Confirmed both repositories are on `develop`, use HTTPS remotes, and are ahead of
  `origin/develop` by one commit.
- Preserved existing Product Feedback changes in the original worktrees.
- Created isolated `feature/semantic-actions-v1` worktrees from each current `HEAD`.
- Passed the client baseline (55 files / 248 Web tests and 40 deployment tests).
- Passed five focused Cloud generation-path files (74 tests).

**Learnings:**
- Appending file arguments through the Cloud workspace test script still runs its
  hard-coded `src` target; direct Vitest invocation is required for focused tests.
- The full serial Cloud suite exceeded the five-minute command limit and remains a
  final-regression item.

### 2026-08-09 - Instrumentation and reproducible capture

**By:** Codex

**Actions:**
- Added opt-in Worker trace packages covering request, prompt, provider adapter,
  effective-body assembly, SSE output, persistence input, config, usage, and context IDs.
- Added monotonic delta sequence numbers, replay-safe client deduplication, and
  conflicting-sequence rejection as `STREAM_PROTOCOL_CORRUPTED`.
- Added `?generation_trace=1`, a content-free JSON export control, the reviewed fixed
  input matrix, and desktop/iPhone capture instructions.
- Passed 58 client test files / 256 Web tests, 40 deployment tests, lint, typecheck,
  and production build.
- Passed five focused Cloud test files / 75 tests, lint, typecheck, and build.

**Learnings:**
- The Worker has separate quota-generation and transcript-generation IDs. The trace
  records both explicitly so a correlation mismatch is visible instead of hidden.
- Diagnostic hashing must be best-effort; failure to hash may never change whether a
  completed reply is delivered or classified as incomplete.
