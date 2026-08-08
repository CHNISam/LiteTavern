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
    avatar_seed: '流萤',
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

    rerender(<Avatar character={character({ character_id: 'silver-wolf', name: '银狼' })} />);

    expect(screen.getByRole('img')).toHaveAttribute(
      'src',
      '/v1/characters/silver-wolf/avatar?v=1'
    );
  });

  it('retries the same character once a new avatar version is published', () => {
    const { rerender } = render(<Avatar character={character()} />);
    fireEvent.error(screen.getByRole('img'));

    rerender(<Avatar character={character({ version: 2 })} />);

    expect(screen.getByRole('img')).toHaveAttribute('src', '/v1/characters/firefly/avatar?v=2');
  });
});
