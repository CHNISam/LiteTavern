import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOSTED_BRANCHES = new Set(['develop', 'main']);

export function validateDeploymentEnvironment({ cloudBaseUrl, refName }) {
  if (!HOSTED_BRANCHES.has(refName)) return;

  const candidate = cloudBaseUrl?.trim();
  if (!candidate) {
    throw new Error(
      `VITE_CLOUD_BASE_URL is required for the hosted ${refName} deployment.`
    );
  }

  let url;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error('VITE_CLOUD_BASE_URL must be a valid HTTPS URL.');
  }
  if (url.protocol !== 'https:') {
    throw new Error('VITE_CLOUD_BASE_URL must use HTTPS.');
  }
  if (url.username || url.password) {
    throw new Error('VITE_CLOUD_BASE_URL must not contain credentials.');
  }
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectExecution) {
  try {
    validateDeploymentEnvironment({
      cloudBaseUrl: process.env.VITE_CLOUD_BASE_URL,
      refName: process.env.GITHUB_REF_NAME ?? ''
    });
    console.log('Hosted deployment environment is valid.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
