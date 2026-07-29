import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsClient, type AnalyticsEventPayload } from './analytics';

interface StoredRequest {
  path: string;
  events: AnalyticsEventPayload[];
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    }
  };
}

beforeEach(() => {
  vi.useRealTimers();
});

describe('analytics client', () => {
  it('migrates session and attribution state from the previous storage keys', async () => {
    const storage = memoryStorage();
    const previousPrefix = ['pom', 'chat.analytics'].join('');
    storage.setItem(
      `${previousPrefix}.session.v1`,
      JSON.stringify({
        sessionId: 'existing-session',
        startedAt: Date.parse('2026-07-27T00:55:00Z'),
        lastActivityAt: Date.parse('2026-07-27T00:59:00Z'),
        sessionNumber: 1,
        pageViewIndex: 0,
        interactionIndex: 0,
        currentPage: null,
        pageDepth: 0
      })
    );
    storage.setItem(
      `${previousPrefix}.attribution.v1`,
      JSON.stringify({ firstSourceChannel: 'github', firstCampaignId: null })
    );
    const fetcher = vi.fn(async () => new Response('{}', { status: 202 }));
    const client = new AnalyticsClient({
      storage,
      fetcher,
      now: () => Date.parse('2026-07-27T01:00:00Z')
    });

    await client.initialize({
      userId: 'user-1',
      anonymousId: 'anonymous-1',
      url: 'https://litetavern.example/',
      referrer: '',
      appVersion: '0.1.0'
    });

    expect(client.getSessionId()).toBe('existing-session');
    expect(storage.getItem('litetavern.analytics.session.v1')).not.toBeNull();
    expect(storage.getItem('litetavern.analytics.attribution.v1')).not.toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('persists first attribution and starts a new session only after inactivity', async () => {
    const storage = memoryStorage();
    const requests: StoredRequest[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        path: String(input),
        events: JSON.parse(String(init?.body)).events as AnalyticsEventPayload[]
      });
      return new Response(JSON.stringify({ accepted: 1, duplicates: 0 }), { status: 202 });
    });
    const first = new AnalyticsClient({
      storage,
      fetcher,
      now: () => Date.parse('2026-07-27T01:00:00Z')
    });
    await first.initialize({
      userId: 'user-1',
      anonymousId: 'anonymous-1',
      url: 'https://litetavern.example/?utm_source=bilibili&utm_campaign=firefly_launch',
      referrer: '',
      appVersion: '0.1.0'
    });
    first.pageView('home', '/', { entryMethod: 'deep_link' });
    await Promise.resolve();

    const refreshed = new AnalyticsClient({
      storage,
      fetcher,
      now: () => Date.parse('2026-07-27T01:10:00Z')
    });
    await refreshed.initialize({
      userId: 'user-1',
      anonymousId: 'anonymous-1',
      url: 'https://litetavern.example/',
      referrer: '',
      appVersion: '0.1.0'
    });

    const returned = new AnalyticsClient({
      storage,
      fetcher,
      now: () => Date.parse('2026-07-27T02:00:00Z')
    });
    await returned.initialize({
      userId: 'user-1',
      anonymousId: 'anonymous-1',
      url: 'https://litetavern.example/',
      referrer: '',
      appVersion: '0.1.0'
    });
    await Promise.resolve();

    const sessionEvents = requests
      .flatMap((request) => request.events)
      .filter((event) => event.event_name === 'app_session_started');
    expect(sessionEvents).toHaveLength(2);
    expect(sessionEvents[0]).toMatchObject({
      source_channel: 'bilibili',
      campaign_id: 'firefly_launch',
      properties: {
        is_first_visit: true,
        session_number: 1,
        first_source_channel: 'bilibili',
        current_source_channel: 'bilibili'
      }
    });
    expect(sessionEvents[1]).toMatchObject({
      source_channel: 'direct',
      properties: {
        is_first_visit: false,
        session_number: 2,
        first_source_channel: 'bilibili',
        current_source_channel: 'direct'
      }
    });
    expect(returned.getSessionId()).not.toBe(first.getSessionId());
  });

  it('tracks page and interaction depth without sending message content', async () => {
    const storage = memoryStorage();
    const requests: StoredRequest[] = [];
    const client = new AnalyticsClient({
      storage,
      fetcher: async (input, init) => {
        requests.push({
          path: String(input),
          events: JSON.parse(String(init?.body)).events as AnalyticsEventPayload[]
        });
        return new Response('{}', { status: 202 });
      },
      now: () => Date.parse('2026-07-27T01:00:00Z')
    });
    await client.initialize({
      userId: 'user-1',
      anonymousId: 'anonymous-1',
      url: 'https://litetavern.example/',
      referrer: '',
      appVersion: '0.1.0'
    });

    client.pageView('home', '/', { entryMethod: 'deep_link' });
    client.pageView('character_detail', '/characters/firefly', {
      entryMethod: 'navigation',
      characterId: '018f7ec2-38a7-7fd7-8000-000000000001'
    });
    client.criticalAction('character_selected', 'character_detail', {
      characterId: '018f7ec2-38a7-7fd7-8000-000000000001',
      result: 'success'
    });
    await Promise.resolve();

    const events = requests.flatMap((request) => request.events);
    expect(events.filter((event) => event.event_name === 'page_view')).toEqual([
      expect.objectContaining({
        page_name: 'home',
        properties: expect.objectContaining({ page_view_index: 1, page_depth: 1 })
      }),
      expect.objectContaining({
        page_name: 'character_detail',
        properties: expect.objectContaining({
          from_page: 'home',
          page_view_index: 2,
          page_depth: 2
        })
      })
    ]);
    expect(events).toContainEqual(
      expect.objectContaining({
        event_name: 'critical_action',
        properties: expect.objectContaining({
          action_name: 'character_selected',
          interaction_index: 1,
          click_depth: 1
        })
      })
    );
    expect(JSON.stringify(events)).not.toContain('message');
    expect(JSON.stringify(events)).not.toContain('api_key');
  });

  it('sends support events through the existing endpoint without payment data', async () => {
    const requests: StoredRequest[] = [];
    const client = new AnalyticsClient({
      storage: memoryStorage(),
      fetcher: async (input, init) => {
        requests.push({
          path: String(input),
          events: JSON.parse(String(init?.body)).events as AnalyticsEventPayload[]
        });
        return new Response('{}', { status: 202 });
      },
      now: () => Date.parse('2026-07-27T01:00:00Z')
    });
    await client.initialize({
      userId: '',
      anonymousId: '',
      url: 'https://litetavern.example/support?source=github',
      referrer: '',
      appVersion: '0.1.0'
    });

    client.supportEvent('support_method_click', {
      source: 'github',
      method: 'afdian',
      placement: 'direct',
      isAuthenticated: false
    });
    await Promise.resolve();

    expect(requests.at(-1)?.path).toBe('/v1/analytics/events');
    expect(requests.at(-1)?.events[0]).toMatchObject({
      event_name: 'support_method_click',
      page_name: 'support',
      properties: {
        source: 'github',
        method: 'afdian',
        placement: 'direct',
        is_authenticated: false
      }
    });
    expect(JSON.stringify(requests.at(-1)?.events[0])).not.toMatch(
      /qr|wechat.?id|account|amount|payment/i
    );
  });
});
