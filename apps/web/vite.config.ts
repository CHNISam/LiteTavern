import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parsePublicOrigins } from './src/lib/connect-origins';
import { BUILTIN_BYOK_ORIGIN_LIST } from './src/lib/byok-origins';

function allowedConnectOrigins(): string[] {
  return parsePublicOrigins(
    process.env.VITE_CLOUD_BASE_URL,
    process.env.VITE_BYOK_CONNECT_ORIGINS,
    BUILTIN_BYOK_ORIGIN_LIST.join(' ')
  );
}

// The production index.html ships a strict Content-Security-Policy. Vite's dev
// server injects CSS (and HMR runtime) through inline <style>/<script>, which a
// strict `style-src 'self'` / `script-src 'self'` blocks — leaving the app
// completely unstyled in dev. This plugin relaxes the CSP for the dev server
// only; the built index.html keeps the strict policy untouched.
function devCspRelax(): Plugin {
  return {
    name: 'dev-csp-relax',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(
        /(<meta http-equiv="Content-Security-Policy" content=")([^"]*)(")/,
        (_all, open: string, policy: string, close: string) => {
          const relaxed = policy
            .replace(/script-src 'self'/, "script-src 'self' 'unsafe-inline'")
            .replace(/style-src 'self'/, "style-src 'self' 'unsafe-inline'")
            .replace(
              /connect-src 'self'/,
              `connect-src 'self' ws: ${allowedConnectOrigins().join(' ')}`.trimEnd()
            );
          return open + relaxed + close;
        }
      );
    }
  };
}

// A static LiteTavern build may talk to LiteTavern Cloud on another origin, which a
// strict `connect-src 'self'` would block. The Cloud origin is added to the built
// page's CSP (and only there) when VITE_CLOUD_BASE_URL is set at build time.
function cloudConnectSrc(): Plugin {
  return {
    name: 'cloud-connect-src',
    apply: 'build',
    transformIndexHtml(html) {
      const origins = allowedConnectOrigins();
      if (!origins.length) return html;
      return html.replace(
        /(content="[^"]*)connect-src 'self'/,
        (_all, prefix: string) => `${prefix}connect-src 'self' ${origins.join(' ')}`
      );
    }
  };
}

export function shouldWriteGithubPagesFallback(target: string | undefined): boolean {
  return target === 'github-pages';
}

// Cloudflare Pages treats a build without 404.html as an SPA and reads `_redirects`.
// GitHub Pages needs an index copy named 404.html, so only create it for an
// explicitly targeted GitHub Pages build.
function githubPagesFallback(): Plugin {
  return {
    name: 'github-pages-spa-fallback',
    apply: 'build',
    async writeBundle(options) {
      if (
        !options.dir ||
        !shouldWriteGithubPagesFallback(process.env.VITE_DEPLOY_TARGET)
      ) {
        return;
      }
      await copyFile(
        resolve(options.dir, 'index.html'),
        resolve(options.dir, '404.html')
      );
    }
  };
}

export default defineConfig({
  // Sub-path deployments (e.g. GitHub Pages project sites) set VITE_BASE_PATH.
  base: process.env.VITE_BASE_PATH ?? '/',
  plugins: [
    react(),
    devCspRelax(),
    cloudConnectSrc(),
    githubPagesFallback()
  ],
  server: {
    port: 5173,
    proxy: {
      '/v1': 'http://127.0.0.1:3000'
    }
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts'
  }
});
