import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProductFeedback } from './ProductFeedback';

afterEach(() => vi.unstubAllGlobals());

describe('ProductFeedback', () => {
  it('submits minimal diagnostics without adding chat content or credentials', async () => {
    const fetcher = vi.fn(
      async (...requestArguments: Parameters<typeof fetch>) => {
        void requestArguments;
        return (
        new Response(JSON.stringify({ feedback: { feedback_id: 'feedback-1' } }), {
          status: 201,
          headers: { 'content-type': 'application/json' }
        })
        );
      }
    );
    vi.stubGlobal('fetch', fetcher);
    render(<ProductFeedback provider="cloudflare" model="@cf/test" traceId="trace-1" />);

    fireEvent.click(screen.getByRole('button', { name: '提交反馈' }));
    fireEvent.change(screen.getByLabelText('反馈内容'), {
      target: { value: '生成结束后页面没有显示回复。' }
    });
    fireEvent.click(screen.getByRole('button', { name: '发送反馈' }));

    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    const [, request] = fetcher.mock.calls[0]!;
    const payload = JSON.parse(String(request?.body)) as Record<string, unknown>;
    expect(payload).toMatchObject({
      type: 'BUG',
      content: '生成结束后页面没有显示回复。',
      provider: 'cloudflare',
      model: '@cf/test',
      trace_id: 'trace-1'
    });
    expect(JSON.stringify(payload)).not.toContain('api_key');
  });
});
