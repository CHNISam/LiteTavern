export const SUPPORT_SOURCES = [
  'bilibili',
  'douyin',
  'github',
  'website',
  'other'
] as const;

export type SupportSource = (typeof SUPPORT_SOURCES)[number];

export const SUPPORT_PLACEMENTS = [
  'footer',
  'about',
  'readme',
  'quota_prompt',
  'direct'
] as const;

export type SupportPlacement = (typeof SUPPORT_PLACEMENTS)[number];
export type SupportMethod = 'wechat' | 'afdian' | 'bilibili' | 'douyin';

/**
 * The project's own recurring-support page. Unlike the WeChat QR — which is a
 * private payment code and must stay deployment-supplied — this is a published
 * project link, so a build without the deployment variable still reaches it.
 */
export const DEFAULT_AFDIAN_URL = 'https://afdian.com/a/litetavern';

export interface SupportConfig {
  wechatQrUrl: string | null;
  afdianUrl: string | null;
  bilibiliUrl: string | null;
  douyinUrl: string | null;
}

interface SupportEnvironment {
  VITE_SUPPORT_WECHAT_QR_URL?: string | undefined;
  VITE_SUPPORT_AFDIAN_URL?: string | undefined;
  VITE_SUPPORT_BILIBILI_URL?: string | undefined;
  VITE_SUPPORT_DOUYIN_URL?: string | undefined;
}

export function normalizeSupportSource(value: string | null | undefined): SupportSource {
  return SUPPORT_SOURCES.includes(value as SupportSource)
    ? (value as SupportSource)
    : 'other';
}

export function normalizeSupportPlacement(
  value: string | null | undefined
): SupportPlacement {
  return SUPPORT_PLACEMENTS.includes(value as SupportPlacement)
    ? (value as SupportPlacement)
    : 'direct';
}

/**
 * Support destinations are deployment-controlled, never query-controlled. Only
 * ordinary web URLs are accepted so `javascript:`, `data:` and local file schemes
 * cannot turn a configuration mistake into executable content.
 */
export function safePublicUrl(
  value: string | null | undefined,
  origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin
): string | null {
  const candidate = value?.trim();
  if (!candidate) return null;
  try {
    const url = new URL(candidate, origin);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

export function resolveSupportConfig(
  environment: SupportEnvironment,
  origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin
): SupportConfig {
  return {
    wechatQrUrl: safePublicUrl(environment.VITE_SUPPORT_WECHAT_QR_URL, origin),
    // Only an *unset* variable falls back to the published project page. A variable
    // that is set but unsafe stays null, so a deployment mistake surfaces as a
    // missing entry point instead of being quietly papered over.
    afdianUrl:
      environment.VITE_SUPPORT_AFDIAN_URL?.trim()
        ? safePublicUrl(environment.VITE_SUPPORT_AFDIAN_URL, origin)
        : DEFAULT_AFDIAN_URL,
    bilibiliUrl: safePublicUrl(environment.VITE_SUPPORT_BILIBILI_URL, origin),
    douyinUrl: safePublicUrl(environment.VITE_SUPPORT_DOUYIN_URL, origin)
  };
}

export function supportConfig(): SupportConfig {
  return resolveSupportConfig(import.meta.env);
}
