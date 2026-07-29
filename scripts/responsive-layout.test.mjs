import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const styles = await readFile(
  new URL('../apps/web/src/styles.css', import.meta.url),
  'utf8'
);

test('phone landscape keeps the Star Rail-style contact and content columns visible', () => {
  const landscape = styles.match(
    /@media \(max-width: 960px\) and \(orientation: landscape\) \{([\s\S]*?)\n\}/
  )?.[1];

  assert.ok(landscape, 'missing the phone-landscape layout contract');
  assert.match(
    landscape,
    /\.hsr-stage\s*\{[^}]*grid-template-columns:\s*minmax\(210px,\s*30vw\)\s+minmax\(0,\s*1fr\)/
  );
  assert.doesNotMatch(
    landscape,
    /\.contact-rail:has\(\.contact-item\.selected\)\s*\{[^}]*display:\s*none/
  );
  assert.match(landscape, /\.rail-actions\s*\{[^}]*grid-template-columns:\s*1fr/);
});

test('phone landscape uses the full short viewport without desktop minimum height', () => {
  const landscape = styles.match(
    /@media \(max-width: 960px\) and \(orientation: landscape\) \{([\s\S]*?)\n\}/
  )?.[1];

  assert.ok(landscape);
  assert.match(landscape, /\.hsr-stage\s*\{[^}]*height:\s*calc\(100dvh\s*-\s*56px\)/);
  assert.match(landscape, /\.hsr-stage\s*\{[^}]*min-height:\s*0/);
  assert.match(landscape, /\.top-chrome\s*\{[^}]*height:\s*56px/);
});
