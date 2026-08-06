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
  source?: 'TRIAL' | 'ALPHA' | 'NONE';
  total?: number;
  available?: number;
  remaining_ratio?: number;
};

/** A `/v1/cloud/status` body with sensible anonymous-Trial defaults. */
function cloudStatus(
  overrides: Record<string, unknown> = {},
  quota: CloudQuotaOverrides = {}
) {
  const available = quota.available ?? 30;
  return {
    cloud: {
      stage: 'ALPHA',
      platform_models_available: true,
      model_service: {
        available: available > 0,
        reason_code: available > 0 ? null : 'QUOTA_EXHAUSTED'
      },
      identity_type: 'ANONYMOUS',
      registered: false,
      membership_status: 'ANONYMOUS_TRIAL',
      on_waitlist: false,
      waitlist_joined_at: null,
      alpha_active: false,
      alpha_granted: false,
      alpha_granted_at: null,
      alpha_activated_at: null,
      alpha_batch_id: null,
      alpha_grant_source: null,
      alpha_status_reason: null,
      founding_supporter: false,
      quota: {
        source: 'TRIAL',
        total: 30,
        used: 0,
        reserved: 0,
        available: 30,
        remaining_ratio: 1,
        cycle_no: null,
        cycle_starts_at: null,
        cycle_ends_at: null,
        ...quota
      },
      support: { enabled: false, url: '', headline: '', body: '' },
      next_actions: ['START_CHATTING', 'REGISTER'],
      ...overrides
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
        return json({
          user: {
            user_id: 'user-1',
            anonymous_id: 'anonymous-1',
            identity_type: 'ANONYMOUS',
            free_quota_remaining: 30,
            free_quota_enabled: true
          }
        });
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

  it('shows the LiteTavern Cloud trial balance and updates it after a reply', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input);
      if (path === '/v1/cloud/status') return json(cloudStatus());
      if (path === '/v1/cloud/sync/checkpoint') return json({ sync: {} });
      if (path === '/v1/identities/anonymous') {
        return json({
          user: {
            user_id: 'user-1',
            anonymous_id: 'anonymous-1',
            identity_type: 'ANONYMOUS',
            free_quota_remaining: 30,
            free_quota_enabled: true
          }
        });
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
          free_quota_remaining: 29,
          cloud_quota: {
            source: 'TRIAL',
            total: 30,
            available: 29,
            remaining_ratio: 0.97,
            cycle_ends_at: null
          }
        }, 201);
      }
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });

    render(<App />);

    expect(await screen.findByTitle('LiteTavern Cloud 试用额度：剩余 30 / 30 次')).toBeInTheDocument();
    const composer = screen.getByPlaceholderText('给流萤发送短信…');
    fireEvent.change(composer, { target: { value: '你好' } });
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));

    expect(await screen.findByTitle('LiteTavern Cloud 试用额度：剩余 29 / 30 次')).toBeInTheDocument();
  });

  it('points an anonymous visitor at registration and BYOK when the trial is spent', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input);
      if (path === '/v1/cloud/status') {
        return json(
          cloudStatus({ next_actions: ['REGISTER', 'USE_BYOK'] }, {
            available: 0,
            remaining_ratio: 0
          })
        );
      }
      if (path === '/v1/cloud/sync/checkpoint') return json({ sync: {} });
      if (path === '/v1/identities/anonymous') {
        return json({
          user: {
            user_id: 'user-1',
            anonymous_id: 'anonymous-1',
            identity_type: 'ANONYMOUS',
            free_quota_remaining: 0,
            free_quota_enabled: true
          }
        });
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

    expect(
      await screen.findByText(
        'LiteTavern Cloud 的额度已用完。你可以接入自己的模型继续聊天。'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '连接自己的模型' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看 LiteTavern Cloud 额度' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'LiteTavern Cloud · 额度已用完' })).not.toHaveClass('active');
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
  });

  it('keeps the balance unchanged when the platform model service is busy', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input);
      if (path === '/v1/cloud/status') return json(cloudStatus());
      if (path === '/v1/cloud/sync/checkpoint') return json({ sync: {} });
      if (path === '/v1/identities/anonymous') {
        return json({
          user: {
            user_id: 'user-1',
            anonymous_id: 'anonymous-1',
            identity_type: 'ANONYMOUS',
            free_quota_remaining: 30,
            free_quota_enabled: true
          }
        });
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
            code: 'FREE_SERVICE_UNAVAILABLE',
            message: '官方免费服务暂时繁忙，请稍后再试。本次不会扣除免费次数。',
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
      await screen.findByText(
        'LiteTavern Cloud 暂时不可用。请稍后重试，或连接自己的模型。'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/官方免费服务|凭证未配置/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'LiteTavern Cloud 暂不可用' })).not.toHaveClass('active');
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '模型服务' }));
    expect(
      within(await screen.findByRole('dialog', { name: '模型服务' }))
        .getByText('剩余 30 次，服务恢复后可用')
    ).toBeInTheDocument();
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
          model_service: {
            available: false,
            reason_code: 'SERVICE_UNAVAILABLE'
          }
        }));
      }
      if (path === '/v1/cloud/sync/checkpoint') return json({ sync: {} });
      if (path === '/v1/identities/anonymous') {
        return json({
          user: {
            user_id: 'user-1',
            anonymous_id: 'anonymous-1',
            identity_type: 'ANONYMOUS',
            free_quota_remaining: 30,
            free_quota_enabled: true
          }
        });
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
      'LiteTavern Cloud 暂时不可用。请稍后重试，或连接自己的模型。'
    )).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'LiteTavern Cloud 暂不可用' })).not.toHaveClass('active');
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '连接自己的模型' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '自己的模型' })).not.toHaveClass('active');
    expect(screen.queryByText(/凭证|API Key|环境变量|Provider/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(
      (await screen.findAllByText('正在检查 LiteTavern Cloud…')).length
    ).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();

    finishRetry?.(new Response(JSON.stringify(cloudStatus({
      platform_models_available: false,
      model_service: {
        available: false,
        reason_code: 'SERVICE_UNAVAILABLE'
      }
    })), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));
  });

  it('shows the exact Alpha daily balance and 08:00 reset without upstream units', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input);
      if (path === '/v1/cloud/status') {
        return json(
          cloudStatus(
            {
              identity_type: 'EMAIL',
              registered: true,
              membership_status: 'ALPHA_ACTIVE',
              alpha_active: true,
              alpha_batch_id: 'batch-1',
              alpha_grant_source: 'WAITLIST'
            },
            {
              source: 'ALPHA',
              total: 20,
              available: 14,
              remaining_ratio: 0.7
            }
          )
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
        return json({
          user: {
            user_id: 'user-1',
            anonymous_id: 'anonymous-1',
            identity_type: 'EMAIL',
            email: 'a@example.com',
            registered: true,
            free_quota_remaining: 0,
            free_quota_enabled: true
          }
        });
      }
      if (path === '/v1/analytics/events') return json({ accepted: 1, duplicates: 0 }, 202);
      if (path === '/v1/characters') return json({ characters: [] });
      if (path === '/v1/model-configurations') return json({ configurations: [] });
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });

    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '模型服务' }));
    const panel = await screen.findByRole('dialog', { name: '模型服务' });
    expect(within(panel).getByRole('meter', { name: 'Alpha 每日额度剩余量' })).toBeInTheDocument();
    expect(within(panel).getByText('每天 08:00 恢复')).toBeInTheDocument();
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
              identity_type: 'EMAIL',
              registered: true,
              membership_status: 'REGISTERED_WAITLIST',
              on_waitlist: true,
              waitlist_joined_at: '2026-07-20T00:00:00.000Z',
              next_actions: ['WAIT_FOR_ALPHA', 'USE_BYOK']
            },
            { source: 'NONE', total: 0, available: 0, remaining_ratio: 0 }
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
            email: 'a@example.com', registered: true,
            free_quota_remaining: 0, free_quota_enabled: true
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
    expect(
      within(panel).getByText(
        '已加入 LiteTavern Cloud Alpha 候补名单。名额有限，我们会按候补顺序逐批开放，暂时无法承诺确切的开放日期。'
      )
    ).toBeInTheDocument();
    // The application time is factual and shown; a queue position is not, because it
    // moves as people join, leave and are released.
    expect(within(panel).getByText(/申请时间：/)).toBeInTheDocument();
    expect(within(panel).queryByText(/第\s*\d+\s*位/)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/排名/)).not.toBeInTheDocument();
    // A waitlisted user is not offered the Alpha entry point.
    expect(
      within(panel).queryByRole('button', { name: /开始使用 Alpha/ })
    ).not.toBeInTheDocument();
    // The stage disclaimer is always present, and no plan or price is invented.
    expect(within(panel).getByText(/仍处于测试阶段/)).toBeInTheDocument();
    expect(within(panel).queryByText(/Pro/)).not.toBeInTheDocument();
    expect(within(panel).queryByText(/永久免费/)).not.toBeInTheDocument();
  });

  /**
   * Builds a fetch mock whose only interesting answer is the cloud status; every
   * other call the shell makes on boot gets a benign stub.
   */
  function mockCloud(overrides: Record<string, unknown>, quota: CloudQuotaOverrides) {
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
            email: 'a@example.com', registered: true,
            free_quota_remaining: 0, free_quota_enabled: true
          }
        });
      }
      if (path === '/v1/analytics/events') return json({ accepted: 1, duplicates: 0 }, 202);
      if (path === '/v1/characters') return json({ characters: [] });
      if (path === '/v1/model-configurations') return json({ configurations: [] });
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });
  }

  it('offers the Alpha entry point to a granted user who has not entered yet', async () => {
    mockCloud(
      {
        identity_type: 'EMAIL',
        registered: true,
        membership_status: 'ALPHA_GRANTED',
        alpha_granted: true,
        alpha_granted_at: '2026-07-25T00:00:00.000Z',
        alpha_batch_id: 'batch-1',
        alpha_grant_source: 'WAITLIST',
        next_actions: ['ENTER_ALPHA', 'USE_BYOK']
      },
      { source: 'NONE', total: 0, available: 0, remaining_ratio: 0 }
    );

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '管理账号与同步' }));
    const panel = await screen.findByRole('dialog', { name: '账号与同步' });

    expect(
      within(panel).getByText(/你已获得 LiteTavern Cloud Alpha 资格，还没有开始使用/)
    ).toBeInTheDocument();
    expect(within(panel).getByText(/获得资格时间：/)).toBeInTheDocument();
    expect(
      within(panel).getByRole('button', { name: '开始使用 Alpha 资格' })
    ).toBeInTheDocument();
  });

  it('states the reason and withdraws the Alpha entry point once a seat is suspended', async () => {
    mockCloud(
      {
        identity_type: 'EMAIL',
        registered: true,
        membership_status: 'ALPHA_PAUSED',
        alpha_status_reason: '疑似异常调用',
        next_actions: ['USE_BYOK']
      },
      { source: 'NONE', total: 0, available: 0, remaining_ratio: 0 }
    );

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '管理账号与同步' }));
    const panel = await screen.findByRole('dialog', { name: '账号与同步' });

    const notice = within(panel).getByRole('alert');
    expect(notice).toHaveTextContent('访问已暂停：疑似异常调用');
    // A suspended user is not offered any Alpha-only entry point.
    expect(
      within(panel).queryByRole('button', { name: /开始使用 Alpha/ })
    ).not.toBeInTheDocument();
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
            identity_type: 'ANONYMOUS',
            free_quota_total: 30,
            free_quota_remaining: 30,
            free_quota_available: 30,
            free_quota_enabled: true
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
