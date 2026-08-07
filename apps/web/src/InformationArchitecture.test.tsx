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

/**
 * The server decides everything here. The fixture therefore mirrors the wire
 * contract exactly — an account state and a block reason — instead of a quota
 * number the client would have to interpret.
 */
function cloudStatus({
  accountState = 'ALPHA',
  blockReason = null,
  dailyRemaining = 191
}: {
  accountState?: string;
  blockReason?: string | null;
  dailyRemaining?: number;
} = {}) {
  return {
    cloud: {
      stage: 'ALPHA',
      account_state: accountState,
      email_verified: accountState !== 'GUEST' && accountState !== 'UNVERIFIED',
      platform_models_available: blockReason === null,
      block_reason: blockReason,
      byok_available: accountState !== 'GUEST' && accountState !== 'SUSPENDED',
      alpha: {
        active_batch: 1,
        cumulative_capacity: 10,
        remaining_capacity: 3,
        batch_no: accountState === 'ALPHA' ? 1 : null,
        activated_at: accountState === 'ALPHA' ? '2026-08-01T00:00:00.000Z' : null,
        promotion_expires_at: null
      },
      waitlist: {
        on_waitlist: accountState === 'WAITLIST',
        joined_at: accountState === 'WAITLIST' ? '2026-08-02T00:00:00.000Z' : null
      },
      quota:
        accountState === 'ALPHA'
          ? {
              period_limit: 1500,
              period_used: 41,
              period_reserved: 0,
              period_remaining: 1459,
              period_started_at: '2026-08-01T00:00:00.000Z',
              period_ends_at: '2026-08-31T00:00:00.000Z',
              daily_limit: 200,
              daily_used: 200 - dailyRemaining,
              daily_reserved: 0,
              daily_remaining: dailyRemaining,
              day_utc: '2026-08-06'
            }
          : null,
      support: { enabled: false, url: '', headline: '', body: '' }
    }
  };
}

function mockShell({
  accountState = 'GUEST',
  blockReason = null,
  withCharacter = false,
  dailyRemaining = 191
}: {
  accountState?: string;
  blockReason?: string | null;
  withCharacter?: boolean;
  dailyRemaining?: number;
} = {}) {
  const registered = accountState !== 'GUEST';
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const path = String(input);
    if (path === '/v1/cloud/status') {
      return json(cloudStatus({ accountState, blockReason, dailyRemaining }));
    }
    if (path === '/v1/cloud/sync/checkpoint') return json({ sync: {} });
    if (path === '/v1/identities/anonymous') {
      return json({
        user: {
          user_id: 'user-1',
          anonymous_id: 'anonymous-1',
          identity_type: registered ? 'EMAIL' : 'ANONYMOUS',
          email: registered ? 'user@example.com' : null,
          registered
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

  it('explains Cloud registration, sync and Alpha before opening auth', async () => {
    mockShell({ accountState: 'GUEST' });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '登录' }));
    const account = screen.getByRole('dialog', { name: '账号与同步' });
    expect(within(account).getByText('未登录')).toBeInTheDocument();
    expect(within(account).getByText('角色、对话与记忆')).toBeInTheDocument();
    expect(within(account).getByText('游客')).toBeInTheDocument();
    // Registering is not the same as getting in, and the panel must not imply it.
    expect(within(account).getByText(/注册并验证邮箱本身不占用名额/)).toBeInTheDocument();

    fireEvent.click(
      within(account).getByRole('button', { name: '注册 LiteTavern Cloud 账号' })
    );
    const auth = screen.getByRole('dialog', {
      name: '注册或登录 LiteTavern Cloud 账号'
    });
    // No Free tier exists any more, under that or any other name.
    expect(within(auth).queryByText(/Free/)).not.toBeInTheDocument();
    expect(within(auth).getByText(/是否获得 Alpha 云端额度由服务端判定/)).toBeInTheDocument();
  });

  it('keeps platform quota and BYOK together in model services', async () => {
    mockShell({ accountState: 'ALPHA' });
    render(<App />);

    fireEvent.click(await screen.findByRole('button', { name: '模型服务' }));
    const models = screen.getByRole('dialog', { name: '模型服务' });
    expect(within(models).getByRole('heading', { name: 'LiteTavern Cloud' })).toBeInTheDocument();
    expect(within(models).getByRole('heading', { name: '自己的模型' })).toBeInTheDocument();
    // Nothing is connected yet, so the BYOK card states where a key would live.
    expect(within(models).getByText(/API Key 只保存在这台设备上/)).toBeInTheDocument();
    expect(within(models).getByRole('meter', { name: '今日额度剩余量' })).toBeInTheDocument();
    expect(within(models).getByRole('meter', { name: '本周期额度剩余量' })).toBeInTheDocument();
  });

  it('shows one accurate chat prompt only when no model is available', async () => {
    mockShell({
      accountState: 'ALPHA',
      withCharacter: true,
      blockReason: 'DAILY_QUOTA_EXHAUSTED',
      dailyRemaining: 0
    });
    render(<App />);

    // The daily wall names itself and says when it lifts. It is not the same
    // message as a spent period, a full batch, or a dead provider.
    const message = '今日云端额度已用完，UTC 2026-08-06 结束后重置。';
    expect(await screen.findAllByText(message)).toHaveLength(1);
    expect(screen.getByRole('button', { name: '连接自己的模型' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '查看 LiteTavern Cloud 额度' })).toBeInTheDocument();
    expect(screen.queryByText('查看 LiteTavern Cloud')).not.toBeInTheDocument();
    expect(screen.queryByText('自愿支持 LiteTavern')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /连接自己的模型继续聊天/ })).not.toBeInTheDocument();
  });
});
