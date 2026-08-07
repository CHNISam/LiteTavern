import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { analytics } from './lib/analytics';
import { resetLoreDatabaseForTests } from './lib/lore-store';

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  }));
}

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  // The client caches the last known LiteTavern Cloud status and contact list so it
  // can degrade gracefully; clear it so one test's cache never leaks into the next.
  localStorage.clear();
  await resetLoreDatabaseForTests();
});

type CloudQuotaOverrides = {
  daily_limit?: number;
  daily_used?: number;
  daily_remaining?: number;
  period_limit?: number;
  period_used?: number;
  period_remaining?: number;
};

/**
 * A `/v1/cloud/status` body on the wire contract.
 *
 * The default is an activated Alpha account with room left, because that is the
 * only state in which the platform models are usable at all — there is no
 * anonymous allowance any more, so a guest fixture can never chat.
 */
function cloudStatus(
  overrides: Record<string, unknown> = {},
  quota: CloudQuotaOverrides | null = {}
) {
  return {
    cloud: {
      stage: 'ALPHA',
      account_state: 'ALPHA',
      email_verified: true,
      platform_models_available: true,
      block_reason: null,
      byok_available: true,
      alpha: {
        active_batch: 1,
        cumulative_capacity: 10,
        remaining_capacity: 3,
        batch_no: 1,
        activated_at: '2026-08-01T00:00:00.000Z',
        promotion_expires_at: null
      },
      waitlist: { on_waitlist: false, joined_at: null },
      quota: quota && {
        period_limit: 1500,
        period_used: 41,
        period_reserved: 0,
        period_remaining: 1459,
        period_started_at: '2026-08-01T00:00:00.000Z',
        period_ends_at: '2026-08-31T00:00:00.000Z',
        daily_limit: 200,
        daily_used: 9,
        daily_reserved: 0,
        daily_remaining: 191,
        day_utc: '2026-08-06',
        ...quota
      },
      support: { enabled: false, url: '', headline: '', body: '' },
      ...overrides
    }
  };
}

/** The identity payload no longer carries any allowance; there is none to carry. */
function identity(registered = true) {
  return {
    user: {
      user_id: 'user-1',
      anonymous_id: 'anonymous-1',
      identity_type: registered ? 'EMAIL' : 'ANONYMOUS',
      email: registered ? 'a@example.com' : null,
      registered
    }
  };
}

describe('HSR message shell', () => {
  it('does not buy quick replies merely for opening an existing chat', async () => {
    const requested: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input);
      requested.push(path);
      if (path === '/v1/cloud/status') return json(cloudStatus());
      if (path === '/v1/cloud/sync/checkpoint') return json({ sync: {} });
      if (path === '/v1/identities/anonymous') {
        return json(identity());
      }
      if (path === '/v1/analytics/events') {
        return json({ accepted: 1, duplicates: 0 }, 202);
      }
      if (path === '/v1/characters') {
        return json({
          characters: [{
            character_id: 'firefly-card',
            name: '流萤',
            profile_summary: '星核猎手成员',
            personality_summary: '温柔而坚定',
            first_message: '',
            avatar_seed: '流萤',
            is_owned: true,
            last_message: null
          }]
        });
      }
      if (path === '/v1/model-configurations') {
        return json({ configurations: [] });
      }
      if (path === '/v1/conversations') {
        return json({ conversation_id: 'conversation-1' }, 201);
      }
      if (path === '/v1/conversations/conversation-1/messages') {
        return json({
          messages: [{
            message_id: 'message-1',
            role: 'ASSISTANT',
            content_text: '要一起出发吗？',
            status: 'COMPLETED'
          }]
        });
      }
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });

    render(<App />);

    expect(
      await screen.findByText('要一起出发吗？', {
        selector: '.message-bubble'
      })
    ).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(
      requested.some((path) => path.endsWith('/reply-suggestions'))
    ).toBe(false);
  });

  it('shows the LiteTavern Cloud allowance and updates it after a reply', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input);
      if (path === '/v1/cloud/status') return json(cloudStatus());
      if (path === '/v1/cloud/sync/checkpoint') return json({ sync: {} });
      if (path === '/v1/identities/anonymous') {
        return json(identity());
      }
      if (path === '/v1/analytics/events') return json({ accepted: 1, duplicates: 0 }, 202);
      if (path === '/v1/characters') return json({ characters: [{
        character_id: 'firefly-card', name: '流萤', profile_summary: '星核猎手成员',
        personality_summary: '温柔而坚定', first_message: '', avatar_seed: '流萤',
        is_owned: true, last_message: null
      }] });
      if (path === '/v1/model-configurations') return json({ configurations: [] });
      if (path === '/v1/conversations') return json({ conversation_id: 'conversation-1' }, 201);
      if (path === '/v1/conversations/conversation-1/messages') return json({ messages: [] });
      if (path === '/v1/conversations/conversation-1/turns') {
        return json({
          turn_id: 'turn-1',
          messages: ['收到。'],
          quota: {
            period_limit: 1500,
            period_used: 42,
            period_reserved: 0,
            period_remaining: 1458,
            period_started_at: '2026-08-01T00:00:00.000Z',
            period_ends_at: '2026-08-31T00:00:00.000Z',
            daily_limit: 200,
            daily_used: 10,
            daily_reserved: 0,
            daily_remaining: 190,
            day_utc: '2026-08-06'
          }
        }, 201);
      }
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });

    render(<App />);

    expect(
      await screen.findByTitle(
        'LiteTavern Cloud：今日剩余 191 / 200 次，本周期剩余 1459 / 1500 次'
      )
    ).toBeInTheDocument();
    const composer = screen.getByPlaceholderText('给流萤发送短信…');
    fireEvent.change(composer, { target: { value: '你好' } });
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));

    // One delivered reply costs exactly one unit, and the figure the client shows
    // is the one the server sent back — not a local decrement.
    expect(
      await screen.findByTitle(
        'LiteTavern Cloud：今日剩余 190 / 200 次，本周期剩余 1458 / 1500 次'
      )
    ).toBeInTheDocument();
  });

  it('points at BYOK and the reset time when the day is spent', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input);
      if (path === '/v1/cloud/status') {
        return json(
          cloudStatus(
            {
              platform_models_available: false,
              block_reason: 'DAILY_QUOTA_EXHAUSTED'
            },
            { daily_used: 200, daily_remaining: 0 }
          )
        );
      }
      if (path === '/v1/cloud/sync/checkpoint') return json({ sync: {} });
      if (path === '/v1/identities/anonymous') {
        return json(identity());
      }
      if (path === '/v1/analytics/events') return json({ accepted: 1, duplicates: 0 }, 202);
      if (path === '/v1/characters') return json({ characters: [{
        character_id: 'firefly-card', name: '流萤', profile_summary: '星核猎手成员',
        personality_summary: '温柔而坚定', first_message: '', avatar_seed: '流萤',
        is_owned: true, last_message: null
      }] });
      if (path === '/v1/model-configurations') return json({ configurations: [] });
      if (path === '/v1/conversations') return json({ conversation_id: 'conversation-1' }, 201);
      if (path === '/v1/conversations/conversation-1/messages') return json({ messages: [] });
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });

    render(<App />);

    // The daily wall says when it lifts, and says BYOK still works. It is not the
    // same message as a spent period or a dead provider.
    expect(
      await screen.findByText('今日云端额度已用完，UTC 2026-08-06 结束后重置。')
    ).toBeInTheDocument();
    expect(screen.getByText('你自己的 API Key 仍然可以使用。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '连接自己的模型' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
  });

  it('keeps the balance unchanged when the platform model service is busy', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input);
      if (path === '/v1/cloud/status') return json(cloudStatus());
      if (path === '/v1/cloud/sync/checkpoint') return json({ sync: {} });
      if (path === '/v1/identities/anonymous') {
        return json(identity());
      }
      if (path === '/v1/analytics/events') return json({ accepted: 1, duplicates: 0 }, 202);
      if (path === '/v1/characters') return json({ characters: [{
        character_id: 'firefly-card', name: '流萤', profile_summary: '星核猎手成员',
        personality_summary: '温柔而坚定', first_message: '', avatar_seed: '流萤',
        is_owned: true, last_message: null
      }] });
      if (path === '/v1/model-configurations') return json({ configurations: [] });
      if (path === '/v1/conversations') return json({ conversation_id: 'conversation-1' }, 201);
      if (path === '/v1/conversations/conversation-1/messages') return json({ messages: [] });
      if (path === '/v1/conversations/conversation-1/turns') {
        return json({
          error: {
            code: 'PROVIDER_UNAVAILABLE',
            message: '模型服务商暂时不可用，本次不会消耗额度。',
            retryable: true,
            request_id: 'request-1'
          }
        }, 503);
      }
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });

    render(<App />);
    const composer = await screen.findByPlaceholderText('给流萤发送短信…');
    fireEvent.change(composer, { target: { value: '你好' } });
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));

    expect(
      await screen.findByText('这是暂时的故障，稍后重试即可，本次不会消耗额度。')
    ).toBeInTheDocument();
    // The upstream's own wording never reaches the reader, and neither does any
    // hint about how the platform's credentials are configured.
    expect(screen.queryByText(/官方免费服务|凭证未配置/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '模型服务' }));
    // The allowance is untouched: a failed call costs nothing.
    const panel = await screen.findByRole('dialog', { name: '模型服务' });
    expect(within(panel).getByText('模型服务商暂时不可用')).toBeInTheDocument();
  });

  it('blocks a selected unavailable Cloud service without silently switching to BYOK', async () => {
    let statusRequest = 0;
    let finishRetry: ((response: Response) => void) | undefined;
    const retryResponse = new Promise<Response>((resolve) => {
      finishRetry = resolve;
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input);
      if (path === '/v1/cloud/status') {
        statusRequest += 1;
        if (statusRequest > 1) return retryResponse;
        return json(cloudStatus({
          platform_models_available: false,
          block_reason: 'PROVIDER_UNAVAILABLE'
        }));
      }
      if (path === '/v1/cloud/sync/checkpoint') return json({ sync: {} });
      if (path === '/v1/identities/anonymous') {
        return json(identity());
      }
      if (path === '/v1/analytics/events') return json({}, 202);
      if (path === '/v1/characters') return json({ characters: [{
        character_id: 'firefly-card', name: '流萤', profile_summary: '',
        personality_summary: '', first_message: '', avatar_seed: '流萤'
      }] });
      if (path === '/v1/model-configurations') {
        return json({
          configurations: [{
            model_configuration_id: 'own-model-1',
            provider: 'openai',
            model_name: 'gpt-test',
            display_name: '我的模型',
            base_url: 'https://example.test/v1',
            credential_id: 'credential-1',
            credential_configured: true
          }]
        });
      }
      if (path === '/v1/conversations') return json({ conversation_id: 'conversation-1' }, 201);
      if (path === '/v1/conversations/conversation-1/messages') return json({ messages: [] });
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });

    render(<App />);

    expect(await screen.findByText(
      '这是暂时的故障，稍后重试即可，本次不会消耗额度。'
    )).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '连接自己的模型' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '自己的模型' })).not.toHaveClass('active');
    // Nothing about how the *platform's* credentials are configured leaks out.
    // The BYOK hint mentions the reader's own key, which is the point of it.
    expect(screen.queryByText(/凭证|环境变量|Provider/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(
      (await screen.findAllByText('正在检查 LiteTavern Cloud…')).length
    ).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();

    finishRetry?.(new Response(JSON.stringify(cloudStatus({
      platform_models_available: false,
      block_reason: 'PROVIDER_UNAVAILABLE'
    })), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
  });

  it('shows the exact Alpha balance and its UTC reset without upstream units', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input);
      if (path === '/v1/cloud/status') {
        return json(
          cloudStatus({}, { daily_limit: 20, daily_used: 6, daily_remaining: 14 })
        );
      }
      if (path === '/v1/cloud/support') {
        return json({
          support: {
            enabled: false, url: '', headline: '', body: '',
            thanks_list_enabled: false, supporter_count: 0,
            confirmation: 'MANUAL', thanks: []
          }
        });
      }
      if (path === '/v1/cloud/sync/checkpoint') return json({ sync: {} });
      if (path === '/v1/identities/anonymous') {
        return json(identity());
      }
      if (path === '/v1/analytics/events') return json({ accepted: 1, duplicates: 0 }, 202);
      if (path === '/v1/characters') return json({ characters: [] });
      if (path === '/v1/model-configurations') return json({ configurations: [] });
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '模型服务' }));
    const panel = await screen.findByRole('dialog', { name: '模型服务' });
    const daily = within(panel).getByRole('meter', { name: '今日额度剩余量' });
    expect(daily).toHaveAttribute('aria-valuenow', '14');
    expect(daily).toHaveAttribute('aria-valuemax', '20');
    expect(within(panel).getByText('UTC 2026-08-06 结束后重置')).toBeInTheDocument();
    // A raw token count is never shown to an ordinary user.
    expect(screen.queryByText(/token/i)).not.toBeInTheDocument();
  });

  it('describes the waitlist honestly, without promising quota', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input);
      if (path === '/v1/cloud/status') {
        return json(
          cloudStatus(
            {
              account_state: 'WAITLIST',
              platform_models_available: false,
              block_reason: 'WAITLISTED',
              waitlist: {
                on_waitlist: true,
                joined_at: '2026-07-20T00:00:00.000Z'
              },
              alpha: {
                active_batch: 1,
                cumulative_capacity: 10,
                remaining_capacity: 0,
                batch_no: null,
                activated_at: null,
                promotion_expires_at: null
              }
            },
            null
          )
        );
      }
      if (path === '/v1/cloud/support') {
        return json({
          support: {
            enabled: false, url: '', headline: '', body: '',
            thanks_list_enabled: false, supporter_count: 0,
            confirmation: 'MANUAL', thanks: []
          },
          is_founding_supporter: false
        });
      }
      if (path === '/v1/cloud/sync/checkpoint') return json({ sync: {} });
      if (path === '/v1/identities/anonymous') {
        return json({
          user: {
            user_id: 'user-1', anonymous_id: 'anonymous-1', identity_type: 'EMAIL',
            email: 'a@example.com', registered: true
          }
        });
      }
      if (path === '/v1/analytics/events') return json({ accepted: 1, duplicates: 0 }, 202);
      if (path === '/v1/characters') return json({ characters: [] });
      if (path === '/v1/model-configurations') return json({ configurations: [] });
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '管理账号与同步' }));
    const panel = await screen.findByRole('dialog', { name: '账号与同步' });
    expect(within(panel).getByText('你已进入第二批候补名单。')).toBeInTheDocument();
    expect(
      within(panel).getByText('首批问题解决、服务稳定后，我们将再开放下一批名额。')
    ).toBeInTheDocument();
    expect(within(panel).getByText('等待期间可以使用自己的 API Key。')).toBeInTheDocument();
    // The join time is factual and shown; a queue position is not, because it
    // moves as people join, leave and are released.
    expect(within(panel).getByText(/候补时间：/)).toBeInTheDocument();
    expect(within(panel).queryByText(/第\s*\d+\s*位/)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/排名/)).not.toBeInTheDocument();
    // No allowance is shown, because a waitlisted account has none to show.
    expect(within(panel).queryByRole('meter')).not.toBeInTheDocument();
    // The stage disclaimer is always present, and no plan or price is invented.
    expect(within(panel).getByText(/仍处于测试阶段/)).toBeInTheDocument();
    expect(within(panel).queryByText(/Pro/)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/永久免费/)).not.toBeInTheDocument();
  });

  /**
   * Builds a fetch mock whose only interesting answer is the cloud status; every
   * other call the shell makes on boot gets a benign stub.
   */
  function mockCloud(
    overrides: Record<string, unknown>,
    quota: CloudQuotaOverrides | null
  ) {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input);
      if (path === '/v1/cloud/status') {
        return json(cloudStatus(overrides, quota));
      }
      if (path === '/v1/cloud/support') {
        return json({
          support: {
            enabled: false, url: '', headline: '', body: '',
            thanks_list_enabled: false, supporter_count: 0,
            confirmation: 'MANUAL', thanks: []
          },
          is_founding_supporter: false
        });
      }
      if (path === '/v1/cloud/sync/checkpoint') return json({ sync: {} });
      if (path === '/v1/identities/anonymous') {
        return json({
          user: {
            user_id: 'user-1', anonymous_id: 'anonymous-1', identity_type: 'EMAIL',
            email: 'a@example.com', registered: true
          }
        });
      }
      if (path === '/v1/analytics/events') return json({ accepted: 1, duplicates: 0 }, 202);
      if (path === '/v1/characters') return json({ characters: [] });
      if (path === '/v1/model-configurations') return json({ configurations: [] });
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });
  }

  /**
   * There is no "granted but not entered" state any more: a promoted waitlister
   * holds no seat, only permission to compete again inside a window. Until they
   * actually get a reply they are still on the list, and the panel must not
   * suggest a seat is being held for them.
   */
  it('shows a promoted waitlister as still waiting, holding no seat', async () => {
    mockCloud(
      {
        account_state: 'WAITLIST',
        platform_models_available: true,
        block_reason: null,
        waitlist: { on_waitlist: true, joined_at: '2026-07-20T00:00:00.000Z' },
        alpha: {
          active_batch: 2,
          cumulative_capacity: 30,
          remaining_capacity: 4,
          batch_no: null,
          activated_at: null,
          promotion_expires_at: '2026-08-13T00:00:00.000Z'
        }
      },
      null
    );

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '管理账号与同步' }));
    const panel = await screen.findByRole('dialog', { name: '账号与同步' });

    expect(within(panel).getByText('候补名单中')).toBeInTheDocument();
    expect(within(panel).getByText(/候补时间：/)).toBeInTheDocument();
    expect(within(panel).getByText(/剩余名额 4 \/ 30/)).toBeInTheDocument();
    // Nothing is activated, so no activation time and no allowance are claimed.
    expect(within(panel).queryByText(/启用时间：/)).not.toBeInTheDocument();
    expect(within(panel).queryByRole('meter')).not.toBeInTheDocument();
  });

  it('states the reason and withdraws every Alpha entry point once suspended', async () => {
    mockCloud(
      {
        account_state: 'SUSPENDED',
        platform_models_available: false,
        block_reason: 'ACCOUNT_SUSPENDED',
        byok_available: false
      },
      null
    );

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '管理账号与同步' }));
    const panel = await screen.findByRole('dialog', { name: '账号与同步' });

    const notice = within(panel).getByRole('alert');
    expect(notice).toHaveTextContent('账号已被停用');
    // Suspension outranks every other reason, and BYOK is withdrawn with it.
    expect(within(panel).queryByText(/你自己的 API Key 仍然可以使用/)).not.toBeInTheDocument();
    expect(within(panel).queryByRole('meter')).not.toBeInTheDocument();
    // Model service remains an independent top-level entry.
    expect(screen.getByRole('button', { name: '模型服务' })).toBeInTheDocument();
  });

  it('falls back to the cached contact list when LiteTavern Cloud is unreachable', async () => {
    // A previous online session cached the contacts.
    localStorage.setItem(
      'litetavern.cache.characters.v1',
      JSON.stringify([
        {
          character_id: 'firefly-card', name: '流萤', profile_summary: '星核猎手成员',
          personality_summary: '温柔而坚定', first_message: '又见面了。',
          avatar_seed: '流萤', is_owned: true, last_message: null
        }
      ])
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.reject(new TypeError('Failed to fetch'))
    );

    render(<App />);

    expect((await screen.findAllByText(/LiteTavern Cloud 暂时不可用/)).length).toBeGreaterThan(0);
    expect(screen.getByText('同步异常')).toBeInTheDocument();
    // The character survives the outage, and nothing claims the data is gone.
    expect(screen.getAllByText('流萤').length).toBeGreaterThan(0);
    expect(screen.queryByText(/数据.*丢失[^。]/)).not.toBeInTheDocument();
  });

  it('starts empty and asks for a Firefly character card instead of inventing characters', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input);
      if (path === '/v1/identities/anonymous') return json({ user_id: 'user-1' });
      if (path === '/v1/characters') return json({ characters: [] });
      if (path === '/v1/model-configurations') return json({ configurations: [] });
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });

    render(<App />);

    expect(await screen.findByRole('button', { name: '新建角色' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '导入角色卡' })).not.toBeInTheDocument();
    expect(screen.queryByText('林雾')).not.toBeInTheDocument();
    expect(screen.queryByText('祁安')).not.toBeInTheDocument();
    expect(screen.queryByText('阿澄')).not.toBeInTheDocument();
  });

  it('records login_started when the login and sync flow is opened', async () => {
    const criticalAction = vi.spyOn(analytics, 'criticalAction');
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input);
      if (path === '/v1/identities/anonymous') {
        return json({
          user: {
            user_id: 'user-1',
            anonymous_id: 'anonymous-1',
            // Signed out: this test opens the login flow, which only exists
            // for someone who has not registered yet.
            identity_type: 'ANONYMOUS',
            email: null,
            registered: false
          }
        });
      }
      if (path === '/v1/analytics/events') {
        return json({ accepted: 1, duplicates: 0 }, 202);
      }
      if (path === '/v1/characters') return json({ characters: [] });
      if (path === '/v1/model-configurations') return json({ configurations: [] });
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '登录' }));
    const accountPanel = await screen.findByRole('dialog', { name: '账号与同步' });
    fireEvent.click(
      within(accountPanel).getByRole('button', { name: '注册 LiteTavern Cloud 账号' })
    );
    expect(
      await screen.findByRole('dialog', { name: '注册或登录 LiteTavern Cloud 账号' })
    ).toBeInTheDocument();
    expect(criticalAction).toHaveBeenCalledWith(
      'login_started',
      'home',
      { result: 'attempted' }
    );
  });

  it('uses the imported card PNG as the avatar and keeps the profile a single page', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input);
      if (path === '/v1/identities/anonymous') return json({ user_id: 'user-1' });
      if (path === '/v1/characters') return json({ characters: [{
        character_id: 'firefly-card', name: '流萤', profile_summary: '星核猎手成员',
        personality_summary: '温柔而坚定', first_message: '又见面了。', avatar_seed: '流萤',
        is_owned: true, last_message: null
      }] });
      if (path === '/v1/model-configurations') return json({ configurations: [] });
      if (path === '/v1/conversations') return json({ conversation_id: 'conversation-1' }, 201);
      if (path === '/v1/conversations/conversation-1/messages') return json({ messages: [] });
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });

    render(<App />);

    const avatar = await screen.findByRole('img', { name: '流萤头像' });
    expect(avatar).toHaveAttribute('src', '/v1/characters/firefly-card/avatar');
    fireEvent.click(screen.getByRole('button', { name: '打开流萤档案' }));
    expect(await screen.findByRole('heading', { name: '流萤' })).toBeInTheDocument();

    // There is no second character-settings page to walk into any more: editing
    // is in the header, and the card operations are one menu away.
    expect(screen.queryByRole('button', { name: /^角色设置/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '编辑' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '更多操作' }));
    expect(screen.getByRole('menuitem', { name: /用角色卡更新设定/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /导出角色卡/ })).toBeInTheDocument();
    expect(screen.queryByText('模型选择')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '模型服务' })).toBeInTheDocument();
  });

  it('edits a profile field in place instead of opening the editor', async () => {
    const requests: Array<{ path: string; method: string; body?: string }> = [];
    let description = '星核猎手成员';
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const path = String(input);
      requests.push({
        path,
        method: init?.method ?? 'GET',
        ...(init?.body ? { body: String(init.body) } : {})
      });
      if (path === '/v1/identities/anonymous') return json({ user_id: 'user-1' });
      if (path === '/v1/characters') return json({ characters: [{
        character_id: 'firefly-card', name: '流萤', profile_summary: description,
        personality_summary: '温柔而坚定', first_message: '又见面了。', avatar_seed: '流萤',
        is_owned: true, last_message: null
      }] });
      if (path === '/v1/characters/firefly-card') {
        return json({ character: { character_id: 'firefly-card', name: '流萤', relationship_summary: '  ' } });
      }
      if (path === '/v1/characters/firefly-card/memories') return json({ memories: [] });
      if (path === '/v1/characters/firefly-card/card' && init?.method === 'PUT') {
        description = (JSON.parse(String(init.body)) as { description: string }).description;
        return json({ character_id: 'firefly-card' });
      }
      if (path === '/v1/characters/firefly-card/card') {
        return json({
          normalized_data: {
            name: '流萤', description, personality: '温柔而坚定', scenario: '',
            first_message: '又见面了。', alternate_greetings: [], example_messages: '',
            system_prompt: '守住设定', post_history_instructions: '', tags: [],
            creator: { name: '', notes: '', character_version: '' }
          },
          source_metadata: {
            compatibility_level: 'FORMAL', format: 'INTERNAL',
            container: 'INTERNAL', unapplied_fields: []
          },
          warnings: []
        });
      }
      if (path === '/v1/model-configurations') return json({ configurations: [] });
      if (path === '/v1/conversations') return json({ conversation_id: 'conversation-1' }, 201);
      if (path === '/v1/conversations/conversation-1/messages') return json({ messages: [] });
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '打开流萤档案' }));
    fireEvent.click(await screen.findByRole('button', { name: '编辑简介' }));
    fireEvent.change(screen.getByRole('textbox', { name: '简介' }), {
      target: { value: '格拉默铁骑士' }
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => expect(screen.getByText('格拉默铁骑士')).toBeInTheDocument());
    const update = requests.find((request) => request.method === 'PUT');
    // The whole card is replaced by this endpoint, so an inline edit must carry
    // the fields the reader could not see — not blank them out.
    expect(JSON.parse(String(update?.body))).toMatchObject({
      description: '格拉默铁骑士',
      system_prompt: '守住设定',
      personality: '温柔而坚定'
    });
  });

  it('shows the relationship summary the Cloud actually stored', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input);
      if (path === '/v1/identities/anonymous') return json({ user_id: 'user-1' });
      if (path === '/v1/characters') return json({ characters: [{
        character_id: 'firefly-card', name: '流萤', profile_summary: '星核猎手成员',
        personality_summary: '温柔而坚定', first_message: '又见面了。', avatar_seed: '流萤',
        is_owned: true, last_message: null
      }] });
      if (path === '/v1/characters/firefly-card') {
        return json({
          character: {
            character_id: 'firefly-card',
            name: '流萤',
            relationship_summary: '你们约好一起去看流星。'
          }
        });
      }
      if (path === '/v1/characters/firefly-card/memories') {
        return json({ memories: [{ memory_id: 'm-1', content: '喜欢甜食', memory_kind: 'PREFERENCE' }] });
      }
      if (path === '/v1/model-configurations') return json({ configurations: [] });
      if (path === '/v1/conversations') return json({ conversation_id: 'conversation-1' }, 201);
      if (path === '/v1/conversations/conversation-1/messages') return json({ messages: [] });
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '打开流萤档案' }));

    expect(await screen.findByText('你们约好一起去看流星。')).toBeInTheDocument();
    expect(screen.getByText('每次对话结束后自动更新。')).toBeInTheDocument();
    // The old copy promised a section that was never wired to anything.
    expect(screen.queryByText(/关系摘要与共同经历会自动沉淀在这里/)).not.toBeInTheDocument();
    // The memory entry states what the memories are for.
    expect(await screen.findByText('1 条，会随对话一起提供给流萤')).toBeInTheDocument();
  });

  it('deletes the active character from the profile menu and falls back to the empty state', async () => {
    let deleted = false;
    const requests: Array<{ path: string; method: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const path = String(input);
      requests.push({ path, method: init?.method ?? 'GET' });
      if (path === '/v1/identities/anonymous') return json({ user_id: 'user-1' });
      if (path === '/v1/characters') {
        if (deleted) return json({ characters: [] });
        return json({ characters: [{
          character_id: 'firefly-card', name: '流萤', profile_summary: '星核猎手成员',
          personality_summary: '温柔而坚定', first_message: '又见面了。', avatar_seed: '流萤',
          is_owned: true, last_message: null
        }] });
      }
      if (path === '/v1/model-configurations') return json({ configurations: [] });
      if (path === '/v1/conversations') return json({ conversation_id: 'conversation-1' }, 201);
      if (path === '/v1/conversations/conversation-1/messages') return json({ messages: [] });
      if (path === '/v1/characters/firefly-card' && init?.method === 'DELETE') {
        deleted = true;
        return json({ deleted: true });
      }
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '打开流萤档案' }));
    fireEvent.click(await screen.findByRole('button', { name: '更多操作' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /删除角色/ }));

    // Confirmation dialog gates the destructive action.
    const confirm = await screen.findByRole('button', { name: '删除角色' });
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(requests.some((r) => r.path === '/v1/characters/firefly-card' && r.method === 'DELETE')).toBe(true);
    });
    expect(await screen.findByRole('button', { name: '新建角色' })).toBeInTheDocument();
  });

  it('confirms and deletes a user message together with its later active branch', async () => {
    let messages = [
      { message_id: 'm-1', role: 'ASSISTANT', content_text: '开场白', status: 'COMPLETED' },
      { message_id: 'm-2', role: 'USER', content_text: '需要删除的问题', status: 'COMPLETED' },
      { message_id: 'm-3', role: 'ASSISTANT', content_text: '需要一并删除的回答', status: 'COMPLETED' }
    ];
    const requests: Array<{ path: string; method: string }> = [];
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const path = String(input);
      requests.push({ path, method: init?.method ?? 'GET' });
      if (path === '/v1/cloud/status') return json(cloudStatus());
      if (path === '/v1/cloud/sync/checkpoint') return json({ sync: {} });
      if (path === '/v1/identities/anonymous') return json({ user_id: 'user-1' });
      if (path === '/v1/analytics/events') return json({ accepted: 1, duplicates: 0 }, 202);
      if (path === '/v1/characters') return json({ characters: [{
        character_id: 'firefly-card', name: '流萤', profile_summary: '星核猎手成员',
        personality_summary: '温柔而坚定', first_message: '开场白', avatar_seed: '流萤',
        is_owned: true, last_message: null
      }] });
      if (path === '/v1/model-configurations') return json({ configurations: [] });
      if (path === '/v1/conversations') return json({ conversation_id: 'conversation-1' }, 201);
      if (path === '/v1/conversations/conversation-1/messages/m-2' && init?.method === 'DELETE') {
        messages = messages.slice(0, 1);
        return json({ deleted: true });
      }
      if (path === '/v1/conversations/conversation-1/messages') return json({ messages });
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });

    render(<App />);

    const userMessage = (await screen.findByText('需要删除的问题')).closest('.hsr-message') as HTMLElement;
    fireEvent.click(within(userMessage).getByRole('button', { name: '删除此消息及后续回复' }));

    await waitFor(() => expect(requests).toContainEqual({
      path: '/v1/conversations/conversation-1/messages/m-2',
      method: 'DELETE'
    }));
    expect(window.confirm).toHaveBeenCalledWith('删除这条消息以及本会话中它之后的全部回复？');
    await waitFor(() => expect(screen.queryByText('需要删除的问题')).not.toBeInTheDocument());
    expect(screen.queryByText('需要一并删除的回答')).not.toBeInTheDocument();
    expect(screen.getByText('开场白', { selector: '.message-bubble' })).toBeInTheDocument();
  });

  it('copies a sent message and edits it into a new multi-bubble turn', async () => {
    const turns: Array<Record<string, unknown>> = [];
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const path = String(input);
      if (path === '/v1/cloud/status') return json(cloudStatus());
      if (path === '/v1/identities/anonymous') return json({ user_id: 'user-1' });
      if (path === '/v1/characters') return json({ characters: [{
        character_id: 'firefly-card', name: '流萤', profile_summary: '星核猎手成员',
        personality_summary: '温柔而坚定', first_message: '又见面了。', avatar_seed: '流萤',
        is_owned: true, last_message: null
      }] });
      if (path === '/v1/model-configurations') return json({ configurations: [] });
      if (path === '/v1/conversations') return json({ conversation_id: 'conversation-1' }, 201);
      if (path === '/v1/conversations/conversation-1/messages') return json({ messages: [
        { message_id: 'm-1', role: 'ASSISTANT', content_text: '又见面了。', status: 'COMPLETED' },
        { message_id: 'm-2', role: 'USER', content_text: '你认为呢', status: 'COMPLETED' },
        { message_id: 'm-3', role: 'ASSISTANT', content_text: '我认为该出发了。', status: 'COMPLETED' }
      ] });
      if (path === '/v1/conversations/conversation-1/reply-suggestions') return json({ suggestions: [] });
      if (path === '/v1/conversations/conversation-1/turns') {
        turns.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return json({ turn_id: 'turn-1', messages: ['那就走吧。'] }, 201);
      }
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });

    render(<App />);

    expect(await screen.findByText('你认为呢')).toBeInTheDocument();
    // Both user and character bubbles now expose a copy button; scope to each one.
    const userBubble = screen.getByText('你认为呢').closest('.hsr-message') as HTMLElement;
    fireEvent.click(within(userBubble).getByRole('button', { name: '复制消息' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('你认为呢'));

    const charBubble = screen.getByText('我认为该出发了。', { selector: '.message-bubble' }).closest('.hsr-message') as HTMLElement;
    fireEvent.click(within(charBubble).getByRole('button', { name: '复制消息' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('我认为该出发了。'));
    // The character bubble offers copy only, never edit.
    expect(within(charBubble).queryByRole('button', { name: '编辑消息' })).not.toBeInTheDocument();

    fireEvent.click(within(userBubble).getByRole('button', { name: '编辑消息' }));
    const editor = await screen.findByRole('textbox', { name: '编辑消息内容' });
    expect(editor).toHaveValue('你认为呢');
    fireEvent.change(editor, { target: { value: '你先说' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    // The edit generates one turn carrying the rewritten text, and optimistically
    // drops the old branch (the original message + the reply that followed it).
    await waitFor(() => expect(turns).toHaveLength(1));
    expect(turns[0]).toMatchObject({
      edit_of_message_id: 'm-2',
      input: { type: 'text', text: '你先说' }
    });
    await waitFor(() => expect(screen.getByText('你先说')).toBeInTheDocument());
    expect(screen.queryByText('你认为呢')).not.toBeInTheDocument();
    expect(screen.queryByText('我认为该出发了。')).not.toBeInTheDocument();
  });
});
