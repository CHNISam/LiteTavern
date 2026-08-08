/**
 * How much of the screen the soft keyboard is covering.
 *
 * `interactive-widget=resizes-content` in the viewport meta handles Android Chrome by
 * shrinking the layout viewport when the keyboard opens. iOS Safari ignores it: the
 * layout viewport stays full height and the keyboard is simply drawn on top, so a
 * composer anchored to the bottom of `100dvh` ends up underneath it. The reader taps
 * the input, the keyboard opens, and what they are typing is behind it.
 *
 * `visualViewport` is what iOS does report. The gap between the visual viewport's
 * bottom edge and the layout viewport's is the keyboard, and publishing it as a CSS
 * variable lets the layout pay it back the same way it pays back the safe-area insets
 * — no measuring inside components, no scroll-into-view timers racing the animation.
 */

/** The variable the layout reads. `0px` whenever no keyboard is open. */
export const KEYBOARD_INSET_PROPERTY = '--keyboard-inset';

/**
 * Anything smaller than this is not a keyboard.
 *
 * The visual viewport also shrinks for the URL bar collapsing, for a pinch-zoom, and
 * by a pixel or two from rounding. Reacting to those would make the composer twitch
 * during ordinary scrolling.
 */
const KEYBOARD_THRESHOLD_PX = 120;

export interface KeyboardInsetTarget {
  style: { setProperty(property: string, value: string): void };
}

interface ViewportLike {
  height: number;
  offsetTop: number;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/**
 * Publish the keyboard inset onto an element's style, and keep it current.
 *
 * Returns a teardown. Safe to call where `visualViewport` does not exist — every
 * desktop browser that predates it, and every test environment — in which case the
 * variable is set to `0px` once and never changes, which is the truth there.
 */
export function trackKeyboardInset(
  target: KeyboardInsetTarget,
  viewport: ViewportLike | null | undefined,
  layoutHeight: () => number
): () => void {
  const publish = (pixels: number) => {
    target.style.setProperty(KEYBOARD_INSET_PROPERTY, `${Math.round(pixels)}px`);
  };

  if (!viewport) {
    publish(0);
    return () => {};
  }

  const update = () => {
    // `offsetTop` is included because iOS scrolls the visual viewport as well as
    // shrinking it; without it, a page scrolled up under the keyboard reports an inset
    // smaller than the keyboard actually is.
    const covered = layoutHeight() - viewport.height - viewport.offsetTop;
    publish(covered > KEYBOARD_THRESHOLD_PX ? covered : 0);
  };

  update();
  viewport.addEventListener('resize', update);
  viewport.addEventListener('scroll', update);
  return () => {
    viewport.removeEventListener('resize', update);
    viewport.removeEventListener('scroll', update);
    // Left at zero rather than at whatever it was when the component unmounted: a
    // stale inset would reserve space for a keyboard that is no longer open.
    publish(0);
  };
}
