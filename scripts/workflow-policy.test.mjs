import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function workflow(name) {
  return readFileSync(`.github/workflows/${name}.yml`, "utf8").replace(
    /\r\n/g,
    "\n",
  );
}

test("solo development validates direct pushes to develop without pushing main", () => {
  const source = workflow("ci");
  assert.match(source, /push:\n {4}branches:\n {6}- develop/);
  assert.doesNotMatch(
    source,
    /push:\n(?:.|\n)*?branches:\n(?:.|\n)*? {6}- main/,
  );
});

test("production is manual, approved, disabled by default, and artifact-only", () => {
  const source = workflow("production");
  assert.match(source, /\non:\n {2}workflow_dispatch:/);
  assert.doesNotMatch(source, /\n {2}push:/);
  assert.match(source, /name: production/);
  assert.match(source, /PRODUCTION_RELEASE_ENABLED/);
  assert.match(source, /gh release download/);
  assert.match(source, /sha256sum -c/);
  assert.doesNotMatch(source, /npm run build/);
});

test("rollback uses the same protected production boundary", () => {
  const source = workflow("rollback");
  assert.match(source, /\non:\n {2}workflow_dispatch:/);
  assert.match(source, /name: production/);
  assert.match(source, /PRODUCTION_RELEASE_ENABLED/);
  assert.match(source, /gh release download/);
  assert.match(source, /sha256sum -c/);
});

test("staging refuses deployment until Access is explicitly enabled", () => {
  const source = workflow("staging");
  assert.match(source, /STAGING_ACCESS_ENABLED/);
  assert.match(source, /--branch=staging/);
  assert.match(source, /CLOUDFLARE_STAGING_PROJECT/);
  assert.match(source, /--expect-access/);
  assert.doesNotMatch(source, /CLOUDFLARE_PRODUCTION_PROJECT/);
});

test("internal Pages deployment copies every static Worker dependency", () => {
  const source = workflow("deploy");
  assert.match(
    source,
    /cp deploy\/cloud-gateway\.js apps\/web\/dist\/cloud-gateway\.js/,
  );
  assert.match(
    source,
    /cp deploy\/internal-gate\/api\.js apps\/web\/dist\/internal-gate\/api\.js/,
  );
  assert.match(
    source,
    /cp deploy\/internal-gate\/relationship-import\.js apps\/web\/dist\/internal-gate\/relationship-import\.js/,
  );
});

test("the development workflow cannot deploy production", () => {
  const source = workflow("deploy");
  assert.match(source, /push:\n {4}branches: \[develop\]/);
  assert.doesNotMatch(source, /branches: \[[^\]]*main/);
  assert.doesNotMatch(source, /name:.*production/);
  assert.doesNotMatch(source, /deploy\/production-worker\.js/);
});

test("development and production bind to isolated Cloud Workers", () => {
  const development = readFileSync(
    "deploy/internal-gate/wrangler.jsonc",
    "utf8",
  );
  const production = readFileSync(
    "deploy/production/wrangler.jsonc",
    "utf8",
  );

  assert.match(development, /"service": "litetavern-cloud-development"/);
  assert.match(production, /"service": "litetavern-cloud-production"/);
  assert.doesNotMatch(production, /litetavern-cloud-dev(?:elopment)?"/);
});

test("every production path packages the same-origin Cloud gateway", () => {
  for (const name of ["production", "rollback"]) {
    const source = workflow(name);
    assert.match(source, /deploy\/production-worker\.js/);
    assert.match(source, /deploy\/cloud-gateway\.js/);
    assert.match(source, /--cwd deploy\/production/);
  }
});

test("candidate stays draft and stable release requires main", () => {
  const candidate = workflow("release-candidate");
  const stable = workflow("publish-release");
  assert.match(candidate, /--draft --prerelease/);
  assert.match(candidate, /rc --tag/);
  assert.match(stable, /ref: main/);
  assert.match(stable, /merge-base --is-ancestor/);
  assert.match(stable, /--verify-tag/);
});
