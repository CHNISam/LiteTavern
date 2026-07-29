## What and why

<!-- Explain the change, its user impact, and link the issue. -->

## Target

- [ ] `feature/*` → `develop`
- [ ] `release/*` → `main`
- [ ] `hotfix/*` → `main` and back to `develop`

## Verification

- [ ] `npm run check`
- [ ] Relevant browser/API checks
- [ ] No secrets, credentials, personal data, or production-only values
- [ ] User-visible changes documented
- [ ] Breaking changes include migration notes

## Release safety

- [ ] This PR does not deploy production
- [ ] Production remains behind the protected environment and explicit enable flag
- [ ] Release artifacts will be produced by CI, not a local manual build

## Evidence

<!-- Screenshots, logs, test output, or “not applicable”. -->
