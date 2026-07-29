import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { analytics } from './lib/analytics';

function json(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // The client caches the last known LiteTavern Cloud status and contact list so it
  // can degrade gracefully; clear it so one test's cache never leaks into the next.
  localStorage.clear();
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
  return {
    cloud: {
      stage: 'ALPHA',
      platform_models_available: true,
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
  it('loads quick replies from the Cloud suggestion endpoint for an existing chat', async () => {
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
      if (path === '/v1/conversations/conversation-1/reply-suggestions') {
        return json({ suggestions: ['当然，一起走吧'] });
      }
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });

    render(<App />);

    expect(
      await screen.findByRole('button', { name: '当然，一起走吧' })
    ).toBeInTheDocument();
    expect(requested).toContain(
      '/v1/conversations/conversation-1/reply-suggestions'
    );
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

    expect(await screen.findByTitle('试用额度剩余 30 次')).toBeInTheDocument();
    const composer = screen.getByPlaceholderText('给流萤发送短信…');
    fireEvent.change(composer, { target: { value: '你好' } });
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));

    expect(await screen.findByTitle('试用额度剩余 29 次')).toBeInTheDocument();
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
        '当前没有可用模型。请配置自己的模型，或查看 LiteTavern 提供的模型额度。'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '配置自己的模型' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看平台额度' })).toBeInTheDocument();
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
      await screen.findByText('官方免费服务暂时繁忙，请稍后再试。本次不会扣除免费次数。')
    ).toBeInTheDocument();
    expect(screen.getByTitle('试用额度剩余 30 次')).toBeInTheDocument();
  });

  it('shows a clear BYOK path when the platform model channel is disabled', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const path = String(input);
      if (path === '/v1/cloud/status') {
        return json(cloudStatus({ platform_models_available: false }));
      }
      if (path === '/v1/cloud/sync/checkpoint') return json({ sync: {} });
      if (path === '/v1/identities/anonymous') {
        return json({
          user: {
            user_id: 'user-1',
            anonymous_id: 'anonymous-1',
            identity_type: 'ANONYMOUS',
            free_quota_remaining: 30,
            free_quota_enabled: false
          }
        });
      }
      if (path === '/v1/analytics/events') return json({}, 202);
      if (path === '/v1/characters') return json({ characters: [{
        character_id: 'firefly-card', name: '流萤', profile_summary: '',
        personality_summary: '', first_message: '', avatar_seed: '流萤'
      }] });
      if (path === '/v1/model-configurations') return json({ configurations: [] });
      if (path === '/v1/conversations') return json({ conversation_id: 'conversation-1' }, 201);
      if (path === '/v1/conversations/conversation-1/messages') return json({ messages: [] });
      return json({ error: { message: `unexpected ${path}` } }, 404);
    });

    render(<App />);

    expect(
      await screen.findByText(
        '当前没有可用模型。请配置自己的模型，或查看 LiteTavern 提供的模型额度。'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '配置自己的模型' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看平台额度' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送消息' })).toBeDisabled();
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
    expect(within(panel).getByText('今日平台回复：剩余 14 / 20')).toBeInTheDocument();
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

    expect(await screen.findByText(/LiteTavern Cloud 暂时不可用/)).toBeInTheDocument();
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

  it('uses the imported card PNG as the avatar and follows chat → profile → settings', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: /^角色设置/ }));
    await waitFor(() => {
      expect(screen.getByText('角色设置', { selector: '.detail-title' })).toBeInTheDocument();
    });
    expect(screen.getByText('用角色卡更新设定')).toBeInTheDocument();
    expect(screen.queryByText('模型选择')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '模型服务' })).toBeInTheDocument();
  });

  it('deletes the active character from settings and falls back to the empty state', async () => {
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
    fireEvent.click(await screen.findByRole('button', { name: /^角色设置/ }));
    fireEvent.click(await screen.findByRole('button', { name: /删除角色/ }));

    // Confirmation dialog gates the destructive action.
    const confirm = await screen.findByRole('button', { name: '删除角色' });
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(requests.some((r) => r.path === '/v1/characters/firefly-card' && r.method === 'DELETE')).toBe(true);
    });
    expect(await screen.findByRole('button', { name: '新建角色' })).toBeInTheDocument();
  });

  it('copies a sent message and edits it into a new multi-bubble turn', async () => {
    const turns: Array<Record<string, unknown>> = [];
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const path = String(input);
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
