import { createId } from './id';

export type AnalyticsEventName =
  | 'app_session_started'
  | 'page_view'
  | 'critical_action'
  | 'core_blocking_error_shown'
  | 'support_page_view'
  | 'support_method_click'
  | 'support_qr_view'
  // LiteTavern Cloud program events the client is the one to witness. The rest of
  // the program vocabulary is emitted server-side; see the Cloud architecture doc.
  | 'first_message_sent'
  | 'return_visit'
  | 'byok_selected'
  | 'support_entry_viewed'
  | 'support_entry_clicked'
  // Founding Supporter claim funnel. These never carry contact details, amount
  // or message text — only where the claim was started from.
  | 'supporter_claim_opened'
  | 'supporter_claim_submitted';

export type AnalyticsPageName =
  | 'home'
  | 'chat'
  | 'character_detail'
  | 'character_memories'
  | 'character_settings'
  | 'character_create'
  | 'character_import'
  | 'relationship_import'
  | 'model_config'
  | 'support';

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
  source?: string;
  medium?: string;
  campaign_id?: string;
  content?: string;
  landing_path?: string;
  referrer?: string;
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
  firstSource?: string;
  firstMedium?: string | null;
  firstContent?: string | null;
  firstLandingPath?: string;
  firstReferrer?: string | null;
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
const PREVIOUS_ANALYTICS_PREFIX = ['pom', 'chat.analytics'].join('');
const PREVIOUS_SESSION_KEY = `${PREVIOUS_ANALYTICS_PREFIX}.session.v1`;
const PREVIOUS_ATTRIBUTION_KEY = `${PREVIOUS_ANALYTICS_PREFIX}.attribution.v1`;
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

function readMigratedJson<T>(
  storage: Storage,
  key: string,
  previousKey: string
): T | null {
  const current = readJson<T>(storage, key);
  if (current) return current;
  const previous = readJson<T>(storage, previousKey);
  if (previous) {
    try {
      storage.setItem(key, JSON.stringify(previous));
      storage.removeItem(previousKey);
    } catch {
      // Keep the previous value when migration cannot be persisted.
    }
  }
  return previous;
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
  const medium = url.searchParams.get('utm_medium');
  const content = url.searchParams.get('utm_content');
  const ref = url.searchParams.get('ref');
  const landingPath = `${url.pathname}${url.search}`;
  const referrerValue = referrer.slice(0, 500);
  if (utmSource) {
    return {
      source: knownSource(utmSource),
      rawSource: utmSource.slice(0, 200),
      entrySource: 'utm_source',
      medium,
      content,
      landingPath,
      referrer: referrerValue,
      campaignId: url.searchParams.get('utm_campaign')
    };
  }
  if (ref) {
    return {
      source: knownSource(ref),
      rawSource: ref.slice(0, 200),
      entrySource: 'ref',
      medium,
      content,
      landingPath,
      referrer: referrerValue,
      campaignId: url.searchParams.get('utm_campaign')
    };
  }
  if (referrer) {
    let referrerHost = referrer;
    try {
      referrerHost = new URL(referrer).hostname;
    } catch {
      // Keep the bounded raw referrer when it is not a URL.
    }
    return {
      source: knownSource(referrer),
      rawSource: referrerHost.slice(0, 200),
      entrySource: 'referrer',
      medium: medium ?? 'referral',
      content,
      landingPath,
      referrer: referrerValue,
      campaignId: url.searchParams.get('utm_campaign')
    };
  }
  return {
    source: 'direct' as const,
    rawSource: 'direct',
    entrySource: 'direct',
    medium,
    content,
    landingPath,
    referrer: '',
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
    const storedAttribution = readMigratedJson<AttributionState>(
      this.storage,
      ATTRIBUTION_KEY,
      PREVIOUS_ATTRIBUTION_KEY
    );
    const isFirstVisit = storedAttribution === null;
    const attribution =
      storedAttribution ??
      ({
        firstSourceChannel: current.source,
        firstCampaignId: current.campaignId,
        firstSource: current.rawSource,
        firstMedium: current.medium,
        firstContent: current.content,
        firstLandingPath: current.landingPath,
        firstReferrer: current.referrer || null
      } satisfies AttributionState);
    if (!storedAttribution) {
      writeJson(this.storage, ATTRIBUTION_KEY, attribution);
    }

    const previous = readMigratedJson<SessionState>(
      this.storage,
      SESSION_KEY,
      PREVIOUS_SESSION_KEY
    );
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
        source: current.rawSource,
        ...(current.medium ? { medium: current.medium } : {}),
        ...(current.campaignId ? { campaign_id: current.campaignId } : {}),
        ...(current.content ? { content: current.content } : {}),
        landing_path: current.landingPath,
        ...(current.referrer ? { referrer: current.referrer } : {}),
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

      // A session that is not the first one this browser has had is a return visit —
      // the denominator for "did the memory loop bring them back".
      if (this.session.sessionNumber > 1) {
        this.track('return_visit', {
          properties: {
            session_number: this.session.sessionNumber,
            first_source_channel: attribution.firstSourceChannel
          }
        });
      }
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

  /**
   * Emits a named LiteTavern Cloud program event the client is the one to witness
   * (a first message actually being sent, a returning session). Program facts only
   * the server sees — grants, quota, backups — are emitted server-side instead, so
   * one query spans both without double counting.
   */
  track(
    eventName: AnalyticsEventName,
    options: {
      pageName?: AnalyticsPageName;
      characterId?: string;
      conversationId?: string;
      properties?: Record<string, PropertyValue>;
    } = {}
  ) {
    if (!this.session || !this.initialized) return;
    this.touch();
    void this.emit({
      event_id: createId(),
      event_name: eventName,
      session_id: this.session.sessionId,
      occurred_at: new Date(this.now()).toISOString(),
      ...(options.pageName ? { page_name: options.pageName } : {}),
      ...(options.characterId ? { character_id: options.characterId } : {}),
      ...(options.conversationId
        ? { conversation_id: options.conversationId }
        : {}),
      properties: options.properties ?? {}
    });
  }

  /**
   * `properties` carries extra non-sensitive dimensions (counts, buckets, chosen
   * branch). Never pass user or character content through it — the server rejects
   * content-bearing property names outright.
   */
  criticalAction(
    actionName: string,
    pageName: AnalyticsPageName,
    options: {
      characterId?: string;
      conversationId?: string;
      result?: string;
      properties?: Record<string, PropertyValue>;
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
        ...options.properties,
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

  supportEvent(
    eventName:
      | 'support_page_view'
      | 'support_method_click'
      | 'support_qr_view',
    options: {
      source: 'bilibili' | 'douyin' | 'github' | 'website' | 'other';
      method?: 'wechat' | 'afdian' | 'bilibili' | 'douyin' | 'kofi' | 'github_sponsors';
      placement: 'footer' | 'about' | 'readme' | 'quota_prompt' | 'direct';
      isAuthenticated: boolean;
    }
  ) {
    if (!this.session || !this.initialized) return;
    this.touch();
    void this.emit({
      event_id: createId(),
      event_name: eventName,
      session_id: this.session.sessionId,
      occurred_at: new Date(this.now()).toISOString(),
      page_name: 'support',
      page_path:
        typeof window === 'undefined'
          ? '/support'
          : `${window.location.pathname}${window.location.search}`,
      properties: {
        source: options.source,
        ...(options.method ? { method: options.method } : {}),
        placement: options.placement,
        is_authenticated: options.isAuthenticated
      }
    });
  }

  supporterClaimEvent(
    eventName: 'supporter_claim_opened' | 'supporter_claim_submitted',
    options: {
      source: 'bilibili' | 'douyin' | 'github' | 'website' | 'other';
      placement: 'footer' | 'about' | 'readme' | 'quota_prompt' | 'direct';
      isAuthenticated: boolean;
    }
  ) {
    if (!this.session || !this.initialized) return;
    this.touch();
    void this.emit({
      event_id: createId(),
      event_name: eventName,
      session_id: this.session.sessionId,
      occurred_at: new Date(this.now()).toISOString(),
      page_name: 'support',
      properties: {
        source: options.source,
        placement: options.placement,
        is_authenticated: options.isAuthenticated
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
