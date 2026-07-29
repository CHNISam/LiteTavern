import { safePublicUrl } from './support-config';

/**
 * The canonical open-source repository. It is a fixed project link rather than a
 * support destination, but deployments on a fork still need to be able to point
 * the public pages at their own repository.
 */
export const DEFAULT_GITHUB_URL = 'https://github.com/CHNISam/LiteTavern';

interface ProjectLinkEnvironment {
  VITE_GITHUB_URL?: string | undefined;
}

export function resolveGithubUrl(
  environment: ProjectLinkEnvironment,
  origin?: string
): string {
  return safePublicUrl(environment.VITE_GITHUB_URL, origin) ?? DEFAULT_GITHUB_URL;
}

export function githubUrl(): string {
  return resolveGithubUrl(import.meta.env);
}
