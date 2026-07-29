/* global window */

// Runtime configuration for a built LiteTavern client.
//
// Edit this file after deploying the static bundle to point the client at a
// LiteTavern Cloud instance on another origin, e.g.:
//
//   window.__LITETAVERN__ = { cloudBaseUrl: 'https://cloud.example.com' };
//
// Leave it empty to talk to the same origin the client is served from (the default
// for local development and single-origin hosting). A cross-origin value must also
// be allowed by the page's Content-Security-Policy `connect-src`, which the build
// derives from VITE_CLOUD_BASE_URL.
window.__LITETAVERN__ = { cloudBaseUrl: '' };
