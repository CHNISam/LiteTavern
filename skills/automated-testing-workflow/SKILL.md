---
name: automated-testing-workflow
description: Enforce an incremental, requirements-first automated testing workflow across functional, state, data, API, core E2E, performance, and security tests. Use when implementing features, fixing bugs, changing business rules, refactoring risky logic, adding or modifying tests, investigating test failures, or reporting verification and regression risk.
---

# Automated Testing Workflow

Use tests to define correct behavior, guide development, and prevent regressions. Do not treat them only as final acceptance checks.

## Select Test Scope

Consider each applicable layer:

- Functional tests for user-visible behavior and business capabilities.
- State tests for transitions, lifecycle rules, persistence, and recovery.
- Data tests for validation, transformation, consistency, migrations, and boundaries.
- API tests for contracts, status codes, errors, authorization, and compatibility.
- Core-flow E2E tests for the few highest-value end-to-end journeys.
- Performance tests for latency, throughput, resource use, and regression thresholds.
- Security tests for authentication, authorization, input handling, exposure, and abuse cases.

Choose layers based on the change and its risks. Do not add every layer mechanically.

## Add Coverage Incrementally

Do not require a low-coverage project to become fully covered in one task. Prioritize tests for:

1. The current change.
2. Explicit business rules.
3. High-risk logic.
4. Previously observed bugs.

Keep unrelated coverage expansion out of scope unless it is necessary to test the change safely.

## Follow the Development Sequence

Execute work in this order:

1. Confirm the relevant rule or expected behavior from requirements, product decisions, existing contracts, or an authorized stakeholder.
2. Add or update tests that encode the confirmed behavior.
3. Modify business code.
4. Run the current tests and related module tests.
5. Run the full suite when time, environment, and cost permit.
6. Report results and remaining risks before ending the task.

If behavior is not confirmed and choosing an interpretation would materially change the product, stop and request confirmation before encoding that interpretation in a test.

## Diagnose Test Failures

Treat a failure only as evidence that source behavior and test expectation differ. Determine which of these is true before editing:

- The source violates a confirmed requirement: fix the source.
- The test incorrectly represents a confirmed requirement: obtain human confirmation before changing its business expectation.
- The requirement changed: confirm the new requirement before updating the test.

Never assume the test is wrong merely because it fails. Never assume the source is wrong without checking the confirmed rule.

## Enforce Modification Authority

Proceed directly with:

- Adding missing test cases.
- Fixing business code to satisfy confirmed behavior.
- Refactoring test code without changing its meaning.

Require human confirmation before:

- Changing a test's business expectation.
- Updating tests because requirements changed.

Do not delete, skip, quarantine, weaken, broaden, or make tests flaky-by-design unless the user explicitly authorizes it for a justified reason. This includes loosening assertions, removing boundary cases, adding skip markers, swallowing errors, and replacing deterministic checks with superficial snapshots.

## Verify and Report

After changes, run:

1. Every test added or modified in the task.
2. Tests for related modules and affected contracts.
3. The full test suite when feasible.

Report exactly:

- Commands or test targets run.
- Pass, fail, and skip outcomes.
- Tests not run and why.
- Remaining untested or partially tested risks.

Do not describe an unexecuted test as passing. Do not claim completion while a relevant failure remains unexplained.
