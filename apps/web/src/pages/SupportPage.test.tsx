import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SupportConfig } from '../lib/support-config';
import { SupportPage, type SupportTracker } from './SupportPage';

const emptyConfig: SupportConfig = {
  wechatQrUrl: null,
  afdianUrl: null,
  bilibiliUrl: null,
  douyinUrl: null
};

function tracker(): SupportTracker {
  return {
    pageView: vi.fn(),
    methodClick: vi.fn(),
    qrView: vi.fn(),
    claimOpened: vi.fn(),
    claimSubmitted: vi.fn()
  };
}

afterEach(() => {
  cleanup();
  window.history.replaceState({}, '', '/');
});

describe('support page', () => {
  it.each([
    ['bilibili', '在 B 站看到 LiteTavern？'],
    ['douyin', '在抖音看到 LiteTavern？'],
    ['github', '感谢你关注 LiteTavern 的开源开发。'],
    ['website', '感谢你愿意了解 LiteTavern。'],
    ['other', '感谢你愿意了解 LiteTavern。']
  ])('shows the expected copy for source=%s', (source, copy) => {
    render(
      <SupportPage
        source={source}
        placement="direct"
        config={emptyConfig}
        tracker={tracker()}
        isAuthenticated={false}
      />
    );

    expect(screen.getByText(copy)).toBeInTheDocument();
  });

  it('normalizes an unknown source without rendering it', () => {
    const supportTracker = tracker();
    render(
      <SupportPage
        source={'<script>alert(1)</script>'}
        placement="direct"
        config={emptyConfig}
        tracker={supportTracker}
        isAuthenticated={false}
      />
    );

    expect(screen.getByText('感谢你愿意了解 LiteTavern。')).toBeInTheDocument();
    expect(screen.queryByText('<script>alert(1)</script>')).not.toBeInTheDocument();
    expect(supportTracker.pageView).toHaveBeenCalledWith({
      source: 'other',
      placement: 'direct',
      is_authenticated: false
    });
  });

  it('shows a friendly state instead of a broken image when WeChat is not configured', () => {
    render(
      <SupportPage
        source="website"
        placement="direct"
        config={emptyConfig}
        tracker={tracker()}
        isAuthenticated={false}
      />
    );

    expect(screen.getByText('微信支持入口暂未开放')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: '微信收款二维码' })).not.toBeInTheDocument();
  });

  it('shows the configured QR and falls back safely when it fails to load', () => {
    const supportTracker = tracker();
    render(
      <SupportPage
        source="website"
        placement="direct"
        config={{ ...emptyConfig, wechatQrUrl: 'https://static.example/wechat.png' }}
        tracker={supportTracker}
        isAuthenticated={true}
      />
    );

    const image = screen.getByRole('img', { name: '微信收款二维码' });
    expect(image).toHaveAttribute('src', 'https://static.example/wechat.png');
    fireEvent.load(image);
    expect(supportTracker.qrView).toHaveBeenCalledWith({
      source: 'website',
      method: 'wechat',
      placement: 'direct',
      is_authenticated: true
    });

    fireEvent.error(image);
    expect(screen.getByText('微信支持入口暂未开放')).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: '微信收款二维码' })).not.toBeInTheDocument();
  });

  it('does not render empty external links', () => {
    render(
      <SupportPage
        source="bilibili"
        placement="direct"
        config={emptyConfig}
        tracker={tracker()}
        isAuthenticated={false}
      />
    );

    expect(screen.queryByRole('link', { name: '通过爱发电持续支持' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '前往 B 站支持' })).not.toBeInTheDocument();
  });

  it('tracks configured method clicks with allowlisted fields only', () => {
    const supportTracker = tracker();
    render(
      <SupportPage
        source="bilibili"
        placement="about"
        config={{
          ...emptyConfig,
          wechatQrUrl: 'https://static.example/private-wechat-account.png',
          afdianUrl: 'https://afdian.com/a/litetavern',
          bilibiliUrl: 'https://space.bilibili.com/123'
        }}
        tracker={supportTracker}
        isAuthenticated={false}
      />
    );

    fireEvent.click(screen.getByRole('link', { name: '通过爱发电持续支持' }));
    fireEvent.click(screen.getByRole('link', { name: '前往 B 站支持' }));
    fireEvent.click(screen.getByRole('link', { name: '在新窗口打开微信二维码' }));

    expect(supportTracker.methodClick).toHaveBeenNthCalledWith(1, {
      source: 'bilibili',
      method: 'afdian',
      placement: 'about',
      is_authenticated: false
    });
    expect(supportTracker.methodClick).toHaveBeenNthCalledWith(2, {
      source: 'bilibili',
      method: 'bilibili',
      placement: 'about',
      is_authenticated: false
    });
    expect(supportTracker.methodClick).toHaveBeenNthCalledWith(3, {
      source: 'bilibili',
      method: 'wechat',
      placement: 'about',
      is_authenticated: false
    });

    const serialized = JSON.stringify(vi.mocked(supportTracker.methodClick).mock.calls);
    expect(serialized).not.toContain('private-wechat-account');
    expect(serialized).not.toContain('amount');
    expect(serialized).not.toContain('payment');
  });

  it('links to the project repository and explains where support goes', () => {
    render(
      <SupportPage
        source="website"
        placement="direct"
        config={emptyConfig}
        tracker={tracker()}
        isAuthenticated={false}
        githubUrl="https://github.com/CHNISam/LiteTavern"
      />
    );

    const repository = screen.getByRole('link', { name: 'GitHub' });
    expect(repository).toHaveAttribute('href', 'https://github.com/CHNISam/LiteTavern');
    expect(repository).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(screen.getByRole('heading', { name: '你的支持将用于' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '我们怎么感谢你' })).toBeInTheDocument();
    expect(screen.getByText('服务器与基础设施')).toBeInTheDocument();
  });

  it('keeps the voluntary disclaimers visible alongside the encouraging copy', () => {
    render(
      <SupportPage
        source="website"
        placement="direct"
        config={emptyConfig}
        tracker={tracker()}
        isAuthenticated={false}
      />
    );

    expect(screen.getByText('完全自愿')).toBeInTheDocument();
    expect(screen.getByText('不影响使用')).toBeInTheDocument();
    expect(
      screen.getByText(/一次性支持不等于购买 Pro 套餐，也不承诺投资、分红或任何收益。/)
    ).toBeInTheDocument();
  });

  it('switches and remembers the public theme', () => {
    window.localStorage.removeItem('litetavern.public-theme');
    const { container } = render(
      <SupportPage
        source="website"
        placement="direct"
        config={emptyConfig}
        tracker={tracker()}
        isAuthenticated={false}
      />
    );

    const page = container.querySelector('.public-page')!;
    fireEvent.click(screen.getByRole('button', { name: '浅色模式' }));
    expect(page).toHaveAttribute('data-public-theme', 'light');
    expect(window.localStorage.getItem('litetavern.public-theme')).toBe('light');

    fireEvent.click(screen.getByRole('button', { name: '深色模式' }));
    expect(page).toHaveAttribute('data-public-theme', 'dark');
    expect(window.localStorage.getItem('litetavern.public-theme')).toBe('dark');
  });

  it('offers a low-key Founding Supporter claim entry and tracks opening it', () => {
    const supportTracker = tracker();
    render(
      <SupportPage
        source="website"
        placement="direct"
        config={emptyConfig}
        tracker={supportTracker}
        isAuthenticated={false}
      />
    );

    const entry = screen.getByRole('button', {
      name: '已经支持？认领 Founding Supporter 身份'
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(entry);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(supportTracker.claimOpened).toHaveBeenCalledWith({
      source: 'website',
      placement: 'direct',
      is_authenticated: false
    });
    expect(
      JSON.stringify(vi.mocked(supportTracker.claimOpened).mock.calls)
    ).not.toContain('contact');
  });

  it('keeps amount input local and accepts a custom amount', () => {
    const supportTracker = tracker();
    render(
      <SupportPage
        source="other"
        placement="direct"
        config={emptyConfig}
        tracker={supportTracker}
        isAuthenticated={false}
      />
    );

    const amount = screen.getByLabelText('自定义支持金额');
    fireEvent.change(amount, { target: { value: '88' } });
    expect(amount).toHaveValue(88);
    expect(supportTracker.methodClick).not.toHaveBeenCalled();
  });
});
