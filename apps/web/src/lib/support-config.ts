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
    afdianUrl: safePublicUrl(environment.VITE_SUPPORT_AFDIAN_URL, origin),
    bilibiliUrl: safePublicUrl(environment.VITE_SUPPORT_BILIBILI_URL, origin),
    douyinUrl: safePublicUrl(environment.VITE_SUPPORT_DOUYIN_URL, origin)
  };
}

export function supportConfig(): SupportConfig {
  return resolveSupportConfig(import.meta.env);
}
