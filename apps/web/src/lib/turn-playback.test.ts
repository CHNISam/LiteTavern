import { describe, expect, it, vi } from 'vitest';
import {
  TurnPlaybackController,
  calculateTypingDuration,
  normalizeMessages,
  parseTurnPlan,
  DEFAULT_TURN_PLAYBACK_CONFIG,
  type Clock,
  type TurnPlaybackHooks
} from './turn-playback';

// Deterministic clock: advance() fires due timers in time order, including timers a
// fired callback schedules, so a whole playback can be stepped through synchronously.
class FakeClock implements Clock {
  time = 0;
  private timers: { id: number; fn: () => void; due: number }[] = [];
  private seq = 0;

  now(): number {
    return this.time;
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = ++this.seq;
    this.timers.push({ id, fn, due: this.time + ms });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((timer) => timer.id !== handle);
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const next = this.timers
        .filter((timer) => timer.due <= target)
        .sort((a, b) => a.due - b.due)[0];
      if (!next) break;
      this.timers = this.timers.filter((timer) => timer !== next);
      this.time = next.due;
      next.fn();
    }
    this.time = target;
  }
}

interface Recorder {
  bubbles: {
    text: string;
    turnId: string;
    sequenceNo: number;
    actionId?: string;
    persisted?: boolean;
  }[];
  typing: boolean[];
  errors: unknown[];
  done: string[];
  hooks: TurnPlaybackHooks;
}

function recorder(): Recorder {
  const bubbles: Recorder['bubbles'] = [];
  const typing: boolean[] = [];
  const errors: unknown[] = [];
  const done: string[] = [];
  return {
    bubbles,
    typing,
    errors,
    done,
    hooks: {
      onBubble: (text, ctx) => bubbles.push({ text, ...ctx }),
      onTypingChange: (value) => typing.push(value),
      onError: (reason) => errors.push(reason),
      onDone: (turnId) => done.push(turnId)
    }
  };
}

let turnSeq = 0;
function make(rec: Recorder, clock: FakeClock) {
  turnSeq = 0;
  return new TurnPlaybackController(rec.hooks, {
    clock,
    createTurnId: () => `turn-${++turnSeq}`
  });
}

const cfg = DEFAULT_TURN_PLAYBACK_CONFIG;

describe('pure helpers', () => {
  it('degrades non-JSON output to a single bubble (acceptance 7)', () => {
    expect(parseTurnPlan('模型原始返回内容')).toEqual(['模型原始返回内容']);
    expect(parseTurnPlan('{"messages":["一","二"]}')).toEqual(['一', '二']);
  });

  it('folds overflow past the cap into the last bubble (acceptance 8)', () => {
    expect(normalizeMessages(['1', '2', '3', '4', '5'], 4)).toEqual(['1', '2', '3', '4\n5']);
    expect(normalizeMessages([' a ', '', '  ', 'b'], 4)).toEqual(['a', 'b']);
  });

  it('clamps typing duration to [min, max]', () => {
    expect(calculateTypingDuration('', cfg)).toBe(cfg.minTypingMs);
    expect(calculateTypingDuration('x'.repeat(200), cfg)).toBe(cfg.maxTypingMs);
    expect(calculateTypingDuration('x'.repeat(40), cfg)).toBe(40 * cfg.typingMsPerChar);
  });
});

describe('TurnPlaybackController', () => {
  it.each([1, 2, 4])('plays %s canonical actions with their ids and no persistence rewrite', (count) => {
    const rec = recorder();
    const clock = new FakeClock();
    const controller = make(rec, clock);
    controller.playSemanticTurn({
      protocol_version: 1,
      turn_id: 'canonical-turn',
      actions: Array.from({ length: count }, (_, index) => ({
        action_id: `canonical-${index + 1}`,
        type: 'text' as const,
        content: `bubble ${index + 1}`
      }))
    });
    clock.advance(60_000);

    expect(rec.bubbles).toEqual(Array.from({ length: count }, (_, index) => ({
      text: `bubble ${index + 1}`,
      turnId: 'canonical-turn',
      sequenceNo: index + 1,
      actionId: `canonical-${index + 1}`,
      persisted: true
    })));
  });

  it('rejects canonical overflow instead of merging it into a successful turn', () => {
    const rec = recorder();
    const clock = new FakeClock();
    const controller = make(rec, clock);
    controller.playSemanticTurn({
      protocol_version: 1,
      turn_id: 'overflow',
      actions: Array.from({ length: 5 }, (_, index) => ({
        action_id: `canonical-${index}`,
        type: 'text' as const,
        content: `bubble ${index}`
      }))
    });
    clock.advance(60_000);

    expect(rec.bubbles).toHaveLength(0);
    expect(rec.errors).toHaveLength(1);
  });

  it('fast-forwards persisted actions before a new user turn without resaving them', () => {
    const rec = recorder();
    const clock = new FakeClock();
    const controller = make(rec, clock);
    controller.playSemanticTurn({
      protocol_version: 1,
      turn_id: 'canonical-turn',
      actions: [
        { action_id: 'a', type: 'text', content: 'A' },
        { action_id: 'b', type: 'text', content: 'B' },
        { action_id: 'c', type: 'text', content: 'C' }
      ]
    });
    clock.advance(cfg.turnStartDelayMs + cfg.minTypingMs);
    controller.finishCanonicalPlayback();

    expect(rec.bubbles.map((bubble) => bubble.text)).toEqual(['A', 'B', 'C']);
    expect(rec.bubbles.every((bubble) => bubble.persisted === true)).toBe(true);
    expect(controller.getState()).toBe('IDLE');
  });

  it('shows a single bubble when the model returns one message (acceptance 1)', async () => {
    const rec = recorder();
    const clock = new FakeClock();
    const controller = make(rec, clock);

    await controller.startTurn(async () => ['好，我明白了。']);
    clock.advance(10_000);

    expect(rec.bubbles).toEqual([{ text: '好，我明白了。', turnId: 'turn-1', sequenceNo: 1 }]);
    expect(rec.done).toEqual(['turn-1']);
  });

  it('reveals three bubbles on the fixed cadence, each after a typing state (acceptance 2, 3)', async () => {
    const rec = recorder();
    const clock = new FakeClock();
    const controller = make(rec, clock);

    // Short texts → every typing window is the 1000ms floor.
    await controller.startTurn(async () => ['等等。', '真的吗？', '算了。']);

    // First bubble floors at turnStartDelay + minTyping = 2000ms.
    expect(rec.bubbles).toHaveLength(0);
    expect(controller.isTyping()).toBe(true);
    clock.advance(cfg.turnStartDelayMs + cfg.minTypingMs);
    expect(rec.bubbles.map((b) => b.text)).toEqual(['等等。']);

    // Second: interval (1500) then typing (1000).
    clock.advance(cfg.messageIntervalMs);
    expect(controller.isTyping()).toBe(true);
    clock.advance(cfg.minTypingMs);
    expect(rec.bubbles.map((b) => b.text)).toEqual(['等等。', '真的吗？']);

    // Third, same rhythm.
    clock.advance(cfg.messageIntervalMs + cfg.minTypingMs);
    expect(rec.bubbles.map((b) => b.text)).toEqual(['等等。', '真的吗？', '算了。']);
    expect(rec.bubbles.map((b) => b.sequenceNo)).toEqual([1, 2, 3]);
    // Each bubble was preceded by a typing=true, and typing is false once settled.
    expect(rec.typing.filter(Boolean)).toHaveLength(3);
    expect(controller.isTyping()).toBe(false);
  });

  it('drops later bubbles when the user sends a new message mid-turn (acceptance 4, 5)', async () => {
    const rec = recorder();
    const clock = new FakeClock();
    const controller = make(rec, clock);

    await controller.startTurn(async () => ['第一条', '第二条', '第三条']);
    clock.advance(cfg.turnStartDelayMs + cfg.minTypingMs);
    expect(rec.bubbles.map((b) => b.text)).toEqual(['第一条']);

    // User sends again before bubble 2/3 appear → new turn supersedes the old plan.
    await controller.startTurn(async () => ['新回合']);
    clock.advance(10_000);

    // Only the already-shown '第一条' and the new turn's bubble were ever persisted;
    // the discarded '第二条'/'第三条' never reached onBubble.
    expect(rec.bubbles.map((b) => b.text)).toEqual(['第一条', '新回合']);
    expect(rec.bubbles.map((b) => b.turnId)).toEqual(['turn-1', 'turn-2']);
  });

  it('interrupt() keeps shown bubbles and abandons the rest (acceptance 5)', async () => {
    const rec = recorder();
    const clock = new FakeClock();
    const controller = make(rec, clock);

    await controller.startTurn(async () => ['A', 'B', 'C']);
    clock.advance(cfg.turnStartDelayMs + cfg.minTypingMs);
    controller.interrupt();
    clock.advance(10_000);

    expect(rec.bubbles.map((b) => b.text)).toEqual(['A']);
    expect(controller.getState()).toBe('IDLE');
    expect(controller.isTyping()).toBe(false);
  });

  it('a stale request resolving late does not overwrite the newer turn (acceptance 6)', async () => {
    const rec = recorder();
    const clock = new FakeClock();
    const controller = make(rec, clock);

    let resolveStale: (value: string[]) => void = () => {};
    const stalePromise = controller.startTurn(
      () => new Promise<string[]>((resolve) => { resolveStale = resolve; })
    );

    // A newer turn starts and completes before the stale one resolves.
    await controller.startTurn(async () => ['新的一轮']);
    clock.advance(10_000);

    resolveStale(['过期的内容', '不该出现']);
    await stalePromise;
    clock.advance(10_000);

    expect(rec.bubbles.map((b) => b.text)).toEqual(['新的一轮']);
  });

  it('degrades and merges through the controller path (acceptance 7, 8)', async () => {
    const rec = recorder();
    const clock = new FakeClock();
    const controller = make(rec, clock);

    await controller.startTurn(async () => parseTurnPlan('总之就这样吧'));
    clock.advance(10_000);
    expect(rec.bubbles.map((b) => b.text)).toEqual(['总之就这样吧']);

    const rec2 = recorder();
    const clock2 = new FakeClock();
    const controller2 = make(rec2, clock2);
    await controller2.startTurn(async () => ['1', '2', '3', '4', '5']);
    clock2.advance(60_000);
    expect(rec2.bubbles.map((b) => b.text)).toEqual(['1', '2', '3', '4\n5']);
  });

  it('does not dump the backlog while paused, and resumes on cadence (acceptance 9)', async () => {
    const rec = recorder();
    const clock = new FakeClock();
    const controller = make(rec, clock);

    await controller.startTurn(async () => ['一', '二', '三']);
    clock.advance(cfg.turnStartDelayMs + cfg.minTypingMs);
    expect(rec.bubbles.map((b) => b.text)).toEqual(['一']);

    controller.pause();
    clock.advance(60_000); // time passes in the background…
    expect(rec.bubbles.map((b) => b.text)).toEqual(['一']); // …nothing is dumped

    controller.resume();
    clock.advance(cfg.messageIntervalMs + cfg.minTypingMs);
    expect(rec.bubbles.map((b) => b.text)).toEqual(['一', '二']);
    clock.advance(cfg.messageIntervalMs + cfg.minTypingMs);
    expect(rec.bubbles.map((b) => b.text)).toEqual(['一', '二', '三']);
  });

  it('an empty plan is a failed generation, not a blank bubble', async () => {
    const rec = recorder();
    const clock = new FakeClock();
    const controller = make(rec, clock);

    await controller.startTurn(async () => ['   ', '']);
    clock.advance(10_000);

    expect(rec.bubbles).toHaveLength(0);
    expect(rec.errors).toHaveLength(1);
    expect(controller.getState()).toBe('IDLE');
  });

  it('calls the model exactly once per turn (acceptance 10)', async () => {
    const rec = recorder();
    const clock = new FakeClock();
    const controller = make(rec, clock);
    const generate = vi.fn(async () => ['甲', '乙', '丙']);

    await controller.startTurn(generate);
    clock.advance(60_000);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(rec.bubbles).toHaveLength(3);
  });

  it('rolls model latency into the first bubble lead time', async () => {
    const rec = recorder();
    const clock = new FakeClock();
    const controller = make(rec, clock);

    // Model takes longer than the whole first-bubble floor → show it immediately,
    // with no stacked typing wait.
    await controller.startTurn(async () => {
      clock.time += 5000;
      return ['来晚了但立刻显示'];
    });

    expect(rec.bubbles.map((b) => b.text)).toEqual(['来晚了但立刻显示']);
    expect(rec.typing.filter(Boolean)).toHaveLength(0);
  });
});
