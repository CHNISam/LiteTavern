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
  // The stage owns the short viewport minus the chrome; on notched iOS home-screen
  // launches it also gives back the top safe-area inset the app shell padded in.
  assert.match(
    landscape,
    /\.hsr-stage\s*\{[^}]*height:\s*calc\(100dvh\s*-\s*56px(\s*-\s*var\(--safe-top\))?\)/
  );
  assert.match(landscape, /\.hsr-stage\s*\{[^}]*min-height:\s*0/);
  assert.match(landscape, /\.top-chrome\s*\{[^}]*height:\s*56px/);
});

test('the document opts into the full iOS viewport so safe-area insets are real', async () => {
  const html = await readFile(
    new URL('../apps/web/index.html', import.meta.url),
    'utf8'
  );

  assert.match(html, /name="viewport"[^>]*viewport-fit=cover/);
  assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/);
});

test('every viewport edge pays back the iOS safe-area insets', () => {
  assert.match(styles, /--safe-top:\s*env\(safe-area-inset-top, 0px\)/);
  assert.match(styles, /--safe-bottom:\s*env\(safe-area-inset-bottom, 0px\)/);

  // The shell keeps the stage out of the notch and the rounded corners.
  assert.match(
    styles,
    /\.hsr-app\s*\{[^}]*padding:\s*var\(--safe-top\)\s+var\(--safe-right\)\s+0\s+var\(--safe-left\)/
  );
  // The composer is the last row above the home indicator.
  assert.match(
    styles,
    /\.reply-area\s*\{[^}]*padding:[^;]*var\(--safe-bottom\)/
  );
});

test('the feedback launcher leaves the phone composer alone', () => {
  // It used to sit on top of the send button; phones reach it through Settings.
  // Both hides must come after the base rule, which declares display: flex at the
  // same specificity — declaring them earlier in the file loses on source order
  // and leaves the button on screen, which is exactly how this shipped broken.
  const source = styles.replace(/\r\n/g, '\n');
  const base = source.indexOf('.feedback-launcher {');
  assert.ok(base > -1, 'missing the feedback launcher');

  const portrait = source.indexOf(
    '@media (max-width: 900px) {\n  .feedback-launcher { display: none; }'
  );
  const landscape = source.indexOf(
    '@media (max-width: 960px) and (orientation: landscape) {\n  .feedback-launcher { display: none; }'
  );

  assert.ok(portrait > base, 'the portrait hide must come after the base rule');
  assert.ok(landscape > base, 'the landscape hide must come after the base rule');
});
