import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Avatar } from './Avatar';
import type { Character } from '../lib/api';

afterEach(cleanup);

function character(overrides: Partial<Character> = {}): Character {
  return {
    character_id: 'firefly',
    name: '流萤',
    profile_summary: '',
    personality_summary: '',
    first_message: '',
    avatar_seed: 'data:image/png;base64,firefly-v1',
    version: 1,
    ...overrides
  };
}

describe('Avatar', () => {
  it('falls back to the initial when the portrait fails to load', () => {
    render(<Avatar character={character()} />);

    fireEvent.error(screen.getByRole('img'));

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('流')).toBeInTheDocument();
  });

  it('gives the next character its own attempt after a failure', () => {
    // The phone drops one response mid-stream, then the reader opens someone
    // else. Their portrait is fine and must not inherit the earlier failure —
    // the previous implementation hid the reused <img> element forever.
    const { rerender } = render(<Avatar character={character()} />);
    fireEvent.error(screen.getByRole('img'));
    expect(screen.queryByRole('img')).not.toBeInTheDocument();

    rerender(<Avatar character={character({
      character_id: 'silver-wolf',
      name: '银狼',
      avatar_seed: 'data:image/png;base64,silver-wolf-v1'
    })} />);

    expect(screen.getByRole('img')).toHaveAttribute(
      'src',
      'data:image/png;base64,silver-wolf-v1'
    );
  });

  it('retries the same character once a new avatar version is published', () => {
    const { rerender } = render(<Avatar character={character()} />);
    fireEvent.error(screen.getByRole('img'));

    rerender(<Avatar character={character({
      version: 2,
      avatar_seed: 'data:image/png;base64,firefly-v2'
    })} />);

    expect(screen.getByRole('img')).toHaveAttribute('src', 'data:image/png;base64,firefly-v2');
  });

  it('does not request a retired Cloud avatar route for legacy metadata', () => {
    render(<Avatar character={character({ avatar_seed: 'legacy-seed' })} />);

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(screen.getByText('流')).toBeInTheDocument();
  });
});
