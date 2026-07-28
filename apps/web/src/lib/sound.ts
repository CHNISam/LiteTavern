// Lightweight UI feedback sound, synthesized on the fly with the Web Audio API.
// We deliberately do NOT bundle any game audio — the in-game Star Rail sounds are
// miHoYo's copyrighted assets. This is an original, subtle "tick" that evokes a
// crisp UI confirmation without shipping anyone else's audio. If a licensed sound
// file is ever provided, swap `playClick` to play it instead.

let audioContext: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!audioContext) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    audioContext = new Ctor();
  }
  return audioContext;
}

const MUTE_KEY = 'litetavern:muted';

export function isMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setMuted(muted: boolean): void {
  try {
    localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    /* ignore storage failures */
  }
}

export function playClick(): void {
  if (isMuted()) return;
  const context = getContext();
  if (!context) return;
  if (context.state === 'suspended') void context.resume();

  const now = context.currentTime;
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = 'triangle';
  oscillator.frequency.setValueAtTime(1720, now);
  oscillator.frequency.exponentialRampToValueAtTime(880, now + 0.05);

  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.055, now + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);

  oscillator.connect(gain).connect(context.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.09);
}
