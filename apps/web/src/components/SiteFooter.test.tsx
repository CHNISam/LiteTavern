import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { SiteFooter } from './SiteFooter';

describe('site footer', () => {
  it('links to the support page with footer attribution', () => {
    render(<SiteFooter />);

    expect(screen.getByRole('link', { name: '支持 LiteTavern' })).toHaveAttribute(
      'href',
      expect.stringContaining('/support?source=website&placement=footer')
    );
  });
});
