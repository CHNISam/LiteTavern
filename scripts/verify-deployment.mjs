/* global process, console, fetch, URL */

const baseUrl = process.argv[2];
if (!baseUrl) {
  console.error('Usage: node scripts/verify-deployment.mjs https://<pages-project>.pages.dev');
  process.exitCode = 2;
} else {
  const checks = [
    ['home', '/', 'text/html'],
    ['spa refresh', '/settings', 'text/html'],
    ['health', '/health', 'application/json']
  ];
  let failed = false;
  for (const [name, path, contentType] of checks) {
    const response = await fetch(new URL(path, baseUrl), {
      redirect: 'manual',
      headers: { Origin: new URL(baseUrl).origin }
    });
    const actualType = response.headers.get('content-type') ?? '';
    const ok = response.ok && actualType.includes(contentType);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${response.status} ${actualType}`);
    if (!ok) failed = true;
  }
  if (failed) process.exitCode = 1;
}
