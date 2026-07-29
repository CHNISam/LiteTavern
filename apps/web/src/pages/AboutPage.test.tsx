import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AboutPage } from './AboutPage';

afterEach(cleanup);

describe('about page', () => {
  /**
   * The page used to offer the same call to action three times — top-right,
   * in-content and bottom-right — so clicking it repeatedly just piled identical
   * entries onto the history stack. One entry, in the content, is the rule.
   */
  it('offers exactly one support entry', () => {
    render(<AboutPage />);

    const supportLinks = screen.getAllByRole('link', { name: '支持 LiteTavern' });
    expect(supportLinks).toHaveLength(1);
    expect(supportLinks[0]).toHaveAttribute(
      'href',
      expect.stringContaining('/support?source=website&placement=about')
    );
  });

  it('does not link to itself from the header or the footer', () => {
    render(<AboutPage />);

    expect(screen.queryByRole('link', { name: '关于 LiteTavern' })).not.toBeInTheDocument();
    // The one way back out is the brand control, on the left.
    expect(screen.getByRole('link', { name: '返回 LiteTavern' })).toBeInTheDocument();
  });
});
