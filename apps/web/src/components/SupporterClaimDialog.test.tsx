import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupporterClaimDialog } from './SupporterClaimDialog';
import type { SupporterClaimResult } from '../lib/supporter-claim';

const accepted: SupporterClaimResult = {
  claim: {
    claim_id: 'claim-1',
    status: 'PENDING',
    nickname: '夜航星',
    created_at: '2026-07-29T00:00:00.000Z',
    reviewed_at: null
  },
  duplicate: false
};

function fill() {
  fireEvent.change(screen.getByLabelText('昵称'), { target: { value: '夜航星' } });
  fireEvent.change(screen.getByLabelText('联系方式'), {
    target: { value: 'litetavern_fan' }
  });
  fireEvent.change(screen.getByLabelText('大致支持金额'), { target: { value: '18' } });
  fireEvent.change(screen.getByLabelText('大致支付时间'), {
    target: { value: '2026-07-20' }
  });
}

afterEach(cleanup);

describe('founding supporter claim dialog', () => {
  it('renders nothing while closed', () => {
    const { container } = render(
      <SupporterClaimDialog open={false} onClose={vi.fn()} submit={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('requires the fields and the consent before submitting', async () => {
    const submit = vi.fn();
    render(<SupporterClaimDialog open onClose={vi.fn()} submit={submit} />);

    fireEvent.click(screen.getByRole('button', { name: '提交认领申请' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('请填写昵称。');
    expect(submit).not.toHaveBeenCalled();

    fill();
    fireEvent.click(screen.getByRole('button', { name: '提交认领申请' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '请先勾选联系方式的使用说明。'
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it('submits the claim and confirms it is awaiting verification', async () => {
    const submit = vi.fn().mockResolvedValue(accepted);
    const onSubmitted = vi.fn();
    render(
      <SupporterClaimDialog
        open
        onClose={vi.fn()}
        onSubmitted={onSubmitted}
        submit={submit}
      />
    );

    fill();
    fireEvent.change(screen.getByLabelText('留言（可选）'), {
      target: { value: '谢谢你们' }
    });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '提交认领申请' }));

    expect(
      await screen.findByText('申请已提交，核验后将授予 Founding Supporter 身份')
    ).toBeInTheDocument();
    expect(onSubmitted).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        nickname: '夜航星',
        contactType: 'WECHAT',
        contactValue: 'litetavern_fan',
        amount: '18',
        paidAt: '2026-07-20',
        message: '谢谢你们',
        consent: true
      })
    );
  });

  it('submits once even when the button is pressed repeatedly', async () => {
    let release: (value: SupporterClaimResult) => void = () => {};
    const submit = vi.fn(
      () => new Promise<SupporterClaimResult>((resolve) => (release = resolve))
    );
    render(<SupporterClaimDialog open onClose={vi.fn()} submit={submit} />);

    fill();
    fireEvent.click(screen.getByRole('checkbox'));
    const button = screen.getByRole('button', { name: '提交认领申请' });
    fireEvent.click(button);
    fireEvent.click(screen.getByRole('button', { name: /提交中/ }));
    fireEvent.click(screen.getByRole('button', { name: /提交中/ }));

    expect(submit).toHaveBeenCalledTimes(1);
    release(accepted);
    await waitFor(() =>
      expect(
        screen.getByText('申请已提交，核验后将授予 Founding Supporter 身份')
      ).toBeInTheDocument()
    );
  });

  it('keeps the form usable after a failed submission', async () => {
    const submit = vi.fn().mockRejectedValue(new Error('网络异常，请稍后重试。'));
    render(<SupporterClaimDialog open onClose={vi.fn()} submit={submit} />);

    fill();
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: '提交认领申请' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('网络异常，请稍后重试。');
    expect(screen.getByRole('button', { name: '提交认领申请' })).toBeEnabled();

    submit.mockResolvedValue(accepted);
    fireEvent.click(screen.getByRole('button', { name: '提交认领申请' }));
    expect(
      await screen.findByText('申请已提交，核验后将授予 Founding Supporter 身份')
    ).toBeInTheDocument();
    expect(submit).toHaveBeenCalledTimes(2);
  });
});
