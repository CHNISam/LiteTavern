/* global URL, console, fetch, process */

import { pathToFileURL } from 'node:url';

export function normalizeDeploymentUrl(value) {
  const url = new URL(value);
  const isLocalHttp =
    url.protocol === 'http:' &&
    (url.hostname === '127.0.0.1' || url.hostname === 'localhost');

  if (url.protocol !== 'https:' && !isLocalHttp) {
    throw new Error('Deployment URL must use HTTPS (local HTTP is allowed).');
  }
  if (url.username || url.password) {
    throw new Error('Deployment URL must not contain credentials.');
  }
  return url;
}

export function routeUrl(base, route) {
  const url = normalizeDeploymentUrl(base);
  const routeUrlValue = new URL(route, url.origin);
  if (routeUrlValue.origin !== url.origin) {
    throw new Error('Deployment route must stay on the configured origin.');
  }
  return routeUrlValue;
}

export async function assertHtmlResponse(response, route) {
  if (!response.ok) {
    throw new Error(`${route} returned status ${response.status}.`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.toLowerCase().includes('text/html')) {
    throw new Error(`${route} did not return HTML.`);
  }

  const body = await response.text();
  if (!body.includes('LiteTavern')) {
    throw new Error(`${route} did not return the LiteTavern shell.`);
  }
}

export function assertAccessChallenge(response) {
  if (response.status === 401 || response.status === 403) return;

  const location = response.headers.get('location');
  if (
    response.status >= 300 &&
    response.status < 400 &&
    location &&
    new URL(location).hostname.endsWith('.cloudflareaccess.com')
  ) {
    return;
  }

  throw new Error(
    'Staging is publicly reachable; a Cloudflare Access challenge was expected.'
  );
}

function hasFlag(args, flag) {
  return args.includes(flag);
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1] || args[index + 1].startsWith('--')) {
    throw new Error(`Missing ${name}.`);
  }
  return args[index + 1];
}

async function verifyRoutes(baseUrl, headers) {
  const routes = ['/', '/support?source=github'];
  for (const route of routes) {
    const response = await fetch(routeUrl(baseUrl, route), {
      headers,
      redirect: 'follow'
    });
    await assertHtmlResponse(response, route);
    console.log(`Verified ${route}`);
  }
}

async function runCli(args) {
  const baseUrl = option(args, '--url');
  const expectAccess = hasFlag(args, '--expect-access');

  if (expectAccess) {
    const anonymousResponse = await fetch(normalizeDeploymentUrl(baseUrl), {
      redirect: 'manual'
    });
    assertAccessChallenge(anonymousResponse);
    console.log('Verified Cloudflare Access challenge.');

    const clientId = process.env.CF_ACCESS_CLIENT_ID;
    const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      console.log(
        'Access is protected; authenticated route checks require CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET.'
      );
      return;
    }

    await verifyRoutes(baseUrl, {
      'CF-Access-Client-Id': clientId,
      'CF-Access-Client-Secret': clientSecret
    });
    return;
  }

  await verifyRoutes(baseUrl, {});
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  try {
    await runCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
