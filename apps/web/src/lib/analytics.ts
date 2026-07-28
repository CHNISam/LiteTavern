import { createId } from './id';

export type AnalyticsEventName =
  | 'app_session_started'
  | 'page_view'
  | 'critical_action'
  | 'core_blocking_error_shown';

export type AnalyticsPageName =
  | 'home'
  | 'chat'
  | 'character_detail'
  | 'character_memories'
  | 'character_settings'
  | 'character_create'
  | 'character_import'
  | 'model_config';

export type AnalyticsSourceChannel =
  | 'direct'
  | 'github'
  | 'bilibili'
  | 'xiaohongshu'
  | 'mihoyo_forum'
  | 'search'
  | 'friend_share'
  | 'other';

type PropertyValue = string | number | boolean | null;

export interface AnalyticsEventPayload {
  event_id: string;
  event_name: AnalyticsEventName;
  session_id: string;
  occurred_at: string;
  page_name?: AnalyticsPageName;
  page_path?: string;
  character_id?: string;
  conversation_id?: string;
  source_channel?: AnalyticsSourceChannel;
  campaign_id?: string;
  properties: Record<string, PropertyValue>;
}

interface SessionState {
  sessionId: string;
  startedAt: number;
  lastActivityAt: number;
  sessionNumber: number;
  pageViewIndex: number;
  interactionIndex: number;
  currentPage: AnalyticsPageName | null;
  pageDepth: number;
}

interface AttributionState {
  firstSourceChannel: AnalyticsSourceChannel;
  firstCampaignId: string | null;
}

interface AnalyticsClientOptions {
  storage?: Storage;
  fetcher?: typeof fetch;
  now?: () => number;
  sessionTimeoutMs?: number;
}

interface InitializeInput {
  userId: string;
  anonymousId: string;
  url: string;
  referrer: string;
  appVersion: string;
}

const SESSION_KEY = 'litetavern.analytics.session.v1';
const ATTRIBUTION_KEY = 'litetavern.analytics.attribution.v1';
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

function readJson<T>(storage: Storage, key: string): T | null {
  try {
    const raw = storage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson(storage: Storage, key: string, value: unknown) {
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // Analytics persistence is best-effort and must never block the product.
  }
}

function knownSource(value: string): AnalyticsSourceChannel {
  const normalized = value.trim().toLowerCase();
  if (normalized.includes('github')) return 'github';
  if (normalized.includes('bilibili') || normalized === 'bili') return 'bilibili';
  if (normalized.includes('xiaohongshu') || normalized.includes('xhs')) {
    return 'xiaohongshu';
  }
  if (
    normalized.includes('mihoyo') ||
    normalized.includes('miyoushe') ||
    normalized.includes('米游社')
  ) {
    return 'mihoyo_forum';
  }
  if (normalized.includes('friend') || normalized.includes('share')) {
    return 'friend_share';
  }
  if (
    ['google', 'bing', 'baidu', 'sogou', 'duckduckgo', 'search'].some((name) =>
      normalized.includes(name)
    )
  ) {
    return 'search';
  }
  if (!normalized || normalized === 'direct') return 'direct';
  return 'other';
}

function attributionFor(urlValue: string, referrer: string) {
  const url = new URL(urlValue);
  const utmSource = url.searchParams.get('utm_source');
  const ref = url.searchParams.get('ref');
  if (utmSource) {
    return {
      source: knownSource(utmSource),
      entrySource: 'utm_source',
      campaignId: url.searchParams.get('utm_campaign')
    };
  }
  if (ref) {
    return {
      source: knownSource(ref),
      entrySource: 'ref',
      campaignId: url.searchParams.get('utm_campaign')
    };
  }
  if (referrer) {
    return {
      source: knownSource(referrer),
      entrySource: 'referrer',
      campaignId: url.searchParams.get('utm_campaign')
    };
  }
  return {
    source: 'direct' as const,
    entrySource: 'direct',
    campaignId: url.searchParams.get('utm_campaign')
  };
}

function deviceType(): string {
  if (typeof navigator === 'undefined') return 'unknown';
  if (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)) return 'mobile';
  return 'desktop';
}

export class AnalyticsClient {
  private readonly storage: Storage;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly sessionTimeoutMs: number;
  private session: SessionState | null = null;
  private initialized = false;

  constructor(options: AnalyticsClientOptions = {}) {
    this.storage =
      options.storage ??
      (typeof localStorage === 'undefined'
        ? ({
            length: 0,
            clear() {},
            getItem() {
              return null;
            },
            key() {
              return null;
            },
            removeItem() {},
            setItem() {}
          } as Storage)
        : localStorage);
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.sessionTimeoutMs = options.sessionTimeoutMs ?? SESSION_TIMEOUT_MS;
  }

  async initialize(input: InitializeInput): Promise<void> {
    const now = this.now();
    const current = attributionFor(input.url, input.referrer);
    const storedAttribution = readJson<AttributionState>(
      this.storage,
      ATTRIBUTION_KEY
    );
    const isFirstVisit = storedAttribution === null;
    const attribution =
      storedAttribution ??
      ({
        firstSourceChannel: current.source,
        firstCampaignId: current.campaignId
      } satisfies AttributionState);
    if (!storedAttribution) {
      writeJson(this.storage, ATTRIBUTION_KEY, attribution);
    }

    const previous = readJson<SessionState>(this.storage, SESSION_KEY);
    const isNewSession =
      !previous || now - previous.lastActivityAt >= this.sessionTimeoutMs;
    this.session = isNewSession
      ? {
          sessionId: createId(),
          startedAt: now,
          lastActivityAt: now,
          sessionNumber: (previous?.sessionNumber ?? 0) + 1,
          pageViewIndex: 0,
          interactionIndex: 0,
          currentPage: null,
          pageDepth: 0
        }
      : { ...previous, lastActivityAt: now };
    this.initialized = true;
    this.persistSession();

    if (isNewSession) {
      const url = new URL(input.url);
      await this.emit({
        event_id: createId(),
        event_name: 'app_session_started',
        session_id: this.session.sessionId,
        occurred_at: new Date(now).toISOString(),
        source_channel: current.source,
        ...(current.campaignId ? { campaign_id: current.campaignId } : {}),
        properties: {
          is_first_visit: isFirstVisit,
          session_number: this.session.sessionNumber,
          entry_source: current.entrySource,
          current_source_channel: current.source,
          first_source_channel: attribution.firstSourceChannel,
          first_campaign_id: attribution.firstCampaignId,
          landing_page: `${url.pathname}${url.search}`,
          app_version: input.appVersion,
          device_type: deviceType(),
          locale:
            typeof navigator === 'undefined' ? 'unknown' : navigator.language
        }
      });
    }
  }

  getSessionId(): string | null {
    return this.session?.sessionId ?? null;
  }

  getSessionHeaders(): Record<string, string> {
    const sessionId = this.getSessionId();
    return sessionId ? { 'X-LiteTavern-Session-Id': sessionId } : {};
  }

  pageView(
    pageName: AnalyticsPageName,
    pagePath: string,
    options: {
      entryMethod: 'navigation' | 'back' | 'refresh' | 'deep_link' | 'share_link';
      characterId?: string;
      conversationId?: string;
    }
  ) {
    if (!this.session || !this.initialized) return;
    const fromPage = this.session.currentPage;
    this.session.pageViewIndex += 1;
    if (this.session.pageDepth === 0) this.session.pageDepth = 1;
    else if (options.entryMethod === 'back') {
      this.session.pageDepth = Math.max(1, this.session.pageDepth - 1);
    } else if (
      options.entryMethod !== 'refresh' &&
      pageName !== this.session.currentPage
    ) {
      this.session.pageDepth += 1;
    }
    this.session.currentPage = pageName;
    this.touch();
    void this.emit({
      event_id: createId(),
      event_name: 'page_view',
      session_id: this.session.sessionId,
      occurred_at: new Date(this.now()).toISOString(),
      page_name: pageName,
      page_path: pagePath,
      ...(options.characterId ? { character_id: options.characterId } : {}),
      ...(options.conversationId
        ? { conversation_id: options.conversationId }
        : {}),
      properties: {
        from_page: fromPage,
        entry_method: options.entryMethod,
        page_view_index: this.session.pageViewIndex,
        page_depth: this.session.pageDepth,
        time_since_session_start_ms: Math.max(
          0,
          this.now() - this.session.startedAt
        )
      }
    });
  }

  criticalAction(
    actionName: string,
    pageName: AnalyticsPageName,
    options: {
      characterId?: string;
      conversationId?: string;
      result?: string;
    } = {}
  ) {
    if (!this.session || !this.initialized) return;
    this.session.interactionIndex += 1;
    this.touch();
    void this.emit({
      event_id: createId(),
      event_name: 'critical_action',
      session_id: this.session.sessionId,
      occurred_at: new Date(this.now()).toISOString(),
      page_name: pageName,
      ...(options.characterId ? { character_id: options.characterId } : {}),
      ...(options.conversationId
        ? { conversation_id: options.conversationId }
        : {}),
      properties: {
        action_name: actionName,
        interaction_index: this.session.interactionIndex,
        click_depth: this.session.interactionIndex,
        result: options.result ?? 'attempted'
      }
    });
  }

  blockingError(
    errorCode: string,
    pageName: AnalyticsPageName,
    options: {
      errorStage: string;
      retryable: boolean;
      requestId?: string;
      characterId?: string;
      conversationId?: string;
    }
  ) {
    if (!this.session || !this.initialized) return;
    this.touch();
    void this.emit({
      event_id: createId(),
      event_name: 'core_blocking_error_shown',
      session_id: this.session.sessionId,
      occurred_at: new Date(this.now()).toISOString(),
      page_name: pageName,
      ...(options.characterId ? { character_id: options.characterId } : {}),
      ...(options.conversationId
        ? { conversation_id: options.conversationId }
        : {}),
      properties: {
        error_code: errorCode,
        error_stage: options.errorStage,
        retryable: options.retryable,
        request_id: options.requestId ?? ''
      }
    });
  }

  private touch() {
    if (!this.session) return;
    this.session.lastActivityAt = this.now();
    this.persistSession();
  }

  private persistSession() {
    if (this.session) writeJson(this.storage, SESSION_KEY, this.session);
  }

  private async emit(event: AnalyticsEventPayload): Promise<void> {
    try {
      await this.fetcher('/v1/analytics/events', {
        method: 'POST',
        credentials: 'include',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: [event] })
      });
    } catch {
      // Product analytics is intentionally non-blocking.
    }
  }
}

export const analytics = new AnalyticsClient();
