import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';

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

export default defineConfig({
  plugins: [react(), devCspRelax()],
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
