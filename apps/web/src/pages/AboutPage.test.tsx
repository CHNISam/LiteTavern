import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AboutPage } from './AboutPage';

describe('about page', () => {
  it('offers a low-pressure support entry', () => {
    render(<AboutPage />);

    const supportLinks = screen.getAllByRole('link', { name: '支持 LiteTavern' });
    expect(supportLinks).toHaveLength(3);
    expect(
      supportLinks.find((link) => link.getAttribute('href')?.includes('placement=about'))
    ).toHaveAttribute(
      'href',
      expect.stringContaining('/support?source=website&placement=about')
    );
  });
});
