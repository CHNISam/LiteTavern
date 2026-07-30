import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

function json(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' }
    })
  );
}

function cloudStatus({
  registered = false,
  platformAvailable = true,
  quotaAvailable = 30
}: {
  registered?: boolean;
  platformAvailable?: boolean;
  quotaAvailable?: number;
} = {}) {
  return {
    cloud: {
      stage: 'ALPHA',
      platform_models_available: platformAvailable,
      model_service: {
        available: platformAvailable && quotaAvailable > 0,
        reason_code: !platformAvailable
          ? 'SERVICE_UNAVAILABLE'
          : quotaAvailable > 0
            ? null
            : 'QUOTA_EXHAUSTED'
      },
      identity_type: registered ? 'EMAIL' : 'ANONYMOUS',
      registered,
      membership_status: registered ? 'REGISTERED_WAITLIST' : 'ANONYMOUS_TRIAL',
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
        source: quotaAvailable > 0 ? 'TRIAL' : 'NONE',
        total: quotaAvailable > 0 ? 30 : 0,
        used: 30 - quotaAvailable,
        reserved: 0,
        available: quotaAvailable,
        remaining_ratio: quotaAvailable / 30,
        cycle_no: null,
        cycle_starts_at: null,
        cycle_ends_at: null
      },
      support: { enabled: false, url: '', headline: '', body: '' },
      next_actions: registered ? ['JOIN_WAITLIST', 'USE_BYOK'] : ['REGISTER', 'USE_BYOK']
    }
  };
}

function mockShell({
  registered = false,
  withCharacter = false,
  platformAvailable = true,
  quotaAvailable = 30
}: {
  registered?: boolean;
  withCharacter?: boolean;
  platformAvailable?: boolean;
  quotaAvailable?: number;
} = {}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const path = String(input);
    if (path === '/v1/cloud/status') {
      return json(cloudStatus({ registered, platformAvailable, quotaAvailable }));
    }
    if (path === '/v1/cloud/sync/checkpoint') return json({ sync: {} });
    if (path === '/v1/identities/anonymous') {
      return json({
        user: {
          user_id: 'user-1',
          anonymous_id: 'anonymous-1',
          identity_type: registered ? 'EMAIL' : 'ANONYMOUS',
          email: registered ? 'user@example.com' : null,
          registered,
          free_quota_total: quotaAvailable > 0 ? 30 : 0,
          free_quota_remaining: quotaAvailable,
          free_quota_available: quotaAvailable,
          free_quota_enabled: platformAvailable
        }
      });
    }
    if (path === '/v1/analytics/events') return json({ accepted: 1 }, 202);
    if (path === '/v1/characters') {
      return json({
        characters: withCharacter
          ? [{
              character_id: 'firefly-card',
              name: '流萤',
              profile_summary: '星核猎手成员',
              personality_summary: '温柔而坚定',
              first_message: '又见面了。',
              avatar_seed: '流萤',
              is_owned: true,
              last_message: null
            }]
          : []
      });
    }
    if (path === '/v1/model-configurations') return json({ configurations: [] });
    if (path === '/v1/conversations') return json({ conversation_id: 'conversation-1' }, 201);
    if (path === '/v1/conversations/conversation-1/messages') return json({ messages: [] });
    if (path === '/v1/providers') return json({ providers: [] });
    return json({ error: { message: `unexpected ${path}` } }, 404);
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('home information architecture', () => {
  it('keeps one role entry and moves import, migration, about, and support under settings', async () => {
    mockShell();
    render(<App />);

    expect(await screen.findAllByRole('button', { name: '新建角色' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: '模型服务' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '设置' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '登录' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /LiteTavern Cloud 状态/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '支持 LiteTavern' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '导入角色卡' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '迁移角色关系' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '设置' }));
    const settings = screen.getByRole('dialog', { name: '设置' });
    fireEvent.click(within(settings).getByRole('button', { name: /数据导入与迁移/ }));
    expect(within(settings).getByRole('button', { name: /导入角色卡/ })).toBeInTheDocument();
    expect(within(settings).getByRole('button', { name: /迁移角色关系/ })).toBeInTheDocument();
    expect(within(settings).getByRole('link', { name: /导出云端数据/ })).toBeInTheDocument();

    fireEvent.click(within(settings).getByRole('button', { name: /返回设置/ }));
    fireEvent.click(within(settings).getByRole('button', { name: /关于 LiteTavern/ }));
    expect(within(settings).getByRole('link', { name: '支持 LiteTavern' })).toBeInTheDocument();
    expect(within(settings).getByText(/自愿贡献/)).toBeInTheDocument();
    expect(within(settings).getByText(/不影响正常使用、Cloud 注册、同步、套餐或 Alpha 资格/)).toBeInTheDocument();
  });

  it('explains Cloud registration, sync, plan, quota, and Alpha before opening auth', async () => {
    mockShell();
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '登录' }));
    const account = screen.getByRole('dialog', { name: '账号与同步' });
    expect(within(account).getByText('未登录')).toBeInTheDocument();
    expect(within(account).getByText('角色、对话与记忆')).toBeInTheDocument();
    expect(within(account).getByText('未注册')).toBeInTheDocument();
    expect(within(account).getByText(/注册不会自动获得 Alpha 资格/)).toBeInTheDocument();

    fireEvent.click(
      within(account).getByRole('button', { name: '注册 LiteTavern Cloud 账号' })
    );
    const auth = screen.getByRole('dialog', {
      name: '注册或登录 LiteTavern Cloud 账号'
    });
    expect(within(auth).getByText(/创建云端账号并进入 LiteTavern Free/)).toBeInTheDocument();
    expect(within(auth).getByText(/Alpha 资格需要单独申请/)).toBeInTheDocument();
  });

  it('keeps platform quota and BYOK together in model services', async () => {
    mockShell();
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '模型服务' }));
    const models = screen.getByRole('dialog', { name: '模型服务' });
    expect(within(models).getByRole('heading', { name: 'LiteTavern Cloud' })).toBeInTheDocument();
    expect(within(models).getByRole('heading', { name: '自己的模型' })).toBeInTheDocument();
    // Nothing is connected yet, so the BYOK card states where a key would live.
    expect(within(models).getByText(/API Key 只保存在这台设备上/)).toBeInTheDocument();
    expect(within(models).getByRole('meter', { name: '试用额度剩余量' })).toBeInTheDocument();
  });

  it('shows one accurate chat prompt only when no model is available', async () => {
    mockShell({ withCharacter: true, platformAvailable: true, quotaAvailable: 0 });
    render(<App />);

    const message =
      'LiteTavern Cloud 的额度已用完。你可以接入自己的模型继续聊天。';
    expect(await screen.findAllByText(message)).toHaveLength(1);
    expect(screen.getByRole('button', { name: '连接自己的模型' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看 LiteTavern Cloud 额度' })).toBeInTheDocument();
    expect(screen.queryByText('查看 LiteTavern Cloud')).not.toBeInTheDocument();
    expect(screen.queryByText('自愿支持 LiteTavern')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /连接自己的模型继续聊天/ })).not.toBeInTheDocument();
  });
});
