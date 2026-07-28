import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

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
            .replace(/connect-src 'self'/, "connect-src 'self' ws:");
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
      const configured = process.env.VITE_CLOUD_BASE_URL;
      if (!configured) return html;
      let origin: string;
      try {
        origin = new URL(configured).origin;
      } catch {
        return html;
      }
      return html.replace(
        /(content="[^"]*)connect-src 'self'/,
        (_all, prefix: string) => `${prefix}connect-src 'self' ${origin}`
      );
    }
  };
}

function supportQrImgSrc(): Plugin {
  return {
    name: 'support-qr-img-src',
    apply: 'build',
    transformIndexHtml(html) {
      const configured = process.env.VITE_SUPPORT_WECHAT_QR_URL?.trim();
      if (!configured || !/^https?:\/\//i.test(configured)) return html;
      try {
        const origin = new URL(configured).origin;
        return html.replace(
          /(content="[^"]*)img-src 'self'/,
          (_all, prefix: string) => `${prefix}img-src 'self' ${origin}`
        );
      } catch {
        return html;
      }
    }
  };
}

// Cloudflare Pages reads `_redirects`; GitHub Pages serves `404.html`. Shipping
// both static-host fallbacks keeps `/support` refreshable without adding a server.
function githubPagesFallback(): Plugin {
  return {
    name: 'github-pages-spa-fallback',
    apply: 'build',
    async writeBundle(options) {
      if (!options.dir) return;
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
    supportQrImgSrc(),
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
