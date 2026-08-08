/**
 * Measuring the soft keyboard.
 *
 * The bug this prevents is specific and was reported from a real device elsewhere in
 * this codebase's history: on iOS the layout viewport does not shrink when the
 * keyboard opens, so a composer pinned to the bottom of `100dvh` sits underneath it.
 * The reader taps the input and then cannot see what they are typing.
 */

import { describe, expect, it } from 'vitest';

import { KEYBOARD_INSET_PROPERTY, trackKeyboardInset } from './keyboard-inset';

function target() {
  const values: string[] = [];
  return {
    values,
    style: {
      setProperty(property: string, value: string) {
        expect(property).toBe(KEYBOARD_INSET_PROPERTY);
        values.push(value);
      }
    }
  };
}

function viewport(initial: { height: number; offsetTop?: number }) {
  const listeners = new Set<() => void>();
  return {
    height: initial.height,
    offsetTop: initial.offsetTop ?? 0,
    addEventListener(_type: string, listener: () => void) {
      listeners.add(listener);
    },
    removeEventListener(_type: string, listener: () => void) {
      listeners.delete(listener);
    },
    emit() {
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size
  };
}

describe('the keyboard inset', () => {
  it('is zero while no keyboard is open', () => {
    const element = target();
    trackKeyboardInset(element, viewport({ height: 800 }), () => 800);
    expect(element.values).toEqual(['0px']);
  });

  it('reports the height the keyboard covers once it opens', () => {
    const element = target();
    const view = viewport({ height: 800 });
    trackKeyboardInset(element, view, () => 800);

    view.height = 460;
    view.emit();
    expect(element.values.at(-1)).toBe('340px');
  });

  it('counts the scroll the keyboard pushed the page through', () => {
    const element = target();
    const view = viewport({ height: 800 });
    trackKeyboardInset(element, view, () => 800);

    // iOS scrolls the visual viewport as well as shrinking it. Ignoring `offsetTop`
    // reports an inset smaller than the keyboard actually is, and the composer ends up
    // partly behind it — which looks like a rounding bug rather than a missing term.
    view.height = 460;
    view.offsetTop = 40;
    view.emit();
    expect(element.values.at(-1)).toBe('300px');
  });

  it('ignores changes too small to be a keyboard', () => {
    const element = target();
    const view = viewport({ height: 800 });
    trackKeyboardInset(element, view, () => 800);

    // The URL bar collapsing, a pinch-zoom, a pixel of rounding. Reacting to these
    // would make the composer twitch during ordinary scrolling.
    view.height = 740;
    view.emit();
    expect(element.values.at(-1)).toBe('0px');
  });

  it('gives the space back when it stops watching', () => {
    const element = target();
    const view = viewport({ height: 800 });
    const stop = trackKeyboardInset(element, view, () => 800);

    view.height = 460;
    view.emit();
    stop();

    // A stale inset would reserve space for a keyboard that is no longer open.
    expect(element.values.at(-1)).toBe('0px');
    expect(view.listenerCount()).toBe(0);
  });

  it('does nothing harmful where visualViewport does not exist', () => {
    const element = target();
    const stop = trackKeyboardInset(element, undefined, () => 800);
    expect(element.values).toEqual(['0px']);
    expect(() => stop()).not.toThrow();
  });
});
