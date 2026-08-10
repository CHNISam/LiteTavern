import { useState } from 'react';
import type { Character } from '../lib/api';
import { useT } from '../lib/i18n';

export function avatarUrl(character: Character) {
  if (character.avatar_seed.startsWith('data:image/')) return character.avatar_seed;
  // Cloud-era cached characters may still carry only an id; they gracefully render
  // the initial until their asset has been migrated into the local repository.
  return null;
}

/**
 * The initial is always rendered underneath; the image covers it once it loads.
 *
 * A failed load is remembered in React state rather than by hiding the DOM node:
 * an `event.currentTarget.hidden = true` survives every later render, because
 * React never writes back an attribute the JSX does not declare. That turned one
 * dropped response — a phone on a weak connection loading a screenful of avatars
 * — into a permanently lettered avatar, and, worse, leaked across characters:
 * React reuses the same `<img>` element for the next character in that slot, so
 * a different portrait that loads perfectly well would stay hidden too.
 *
 * Keying the failure to `src` means a new image always gets its own attempt.
 */
export function Avatar({
  character,
  className = ''
}: {
  character: Character;
  className?: string;
}) {
  const t = useT();
  const src = avatarUrl(character);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  return (
    <span className={`hsr-avatar ${className}`} aria-hidden="false">
      <span className="avatar-fallback">{character.name.slice(0, 1)}</span>
      {src && failedSrc !== src && (
        <img src={src} alt={t.chat.avatarAlt(character.name)} onError={() => setFailedSrc(src)} />
      )}
    </span>
  );
}
