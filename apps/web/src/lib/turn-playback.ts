import { createId } from './id';
import {
  SEMANTIC_ACTION_POLICY_V1,
  parseSemanticTurnV1,
  type SemanticTurnV1
} from './semantic-actions';

// Fixed presentation-layer timing for an Agent turn. The model never supplies any
// of these — pacing is deterministic, matching the sr-message-maker / star-rail-msg-maker
// convention where the story/program owns time, not the model.
export interface TurnPlaybackConfig {
  turnStartDelayMs: number;
  messageIntervalMs: number;
  typingMsPerChar: number;
  minTypingMs: number;
  maxTypingMs: number;
  maxMessagesPerTurn: number;
}

export const DEFAULT_TURN_PLAYBACK_CONFIG: TurnPlaybackConfig = {
  turnStartDelayMs: 1000,
  messageIntervalMs: 1500,
  typingMsPerChar: 50,
  minTypingMs: 1000,
  maxTypingMs: 3000,
  maxMessagesPerTurn: 4
};

export function calculateTypingDuration(content: string, config: TurnPlaybackConfig): number {
  const raw = content.length * config.typingMsPerChar;
  return Math.min(Math.max(raw, config.minTypingMs), config.maxTypingMs);
}

// A model turn is delivered as a plain array of bubble texts. Anything that is not
// valid `{ "messages": [...] }` degrades to a single bubble carrying the raw text.
export function parseTurnPlan(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { messages?: unknown }).messages)) {
      return ((parsed as { messages: unknown[] }).messages).filter((item): item is string => typeof item === 'string');
    }
  } catch {
    /* not JSON — fall through to the single-bubble degrade */
  }
  return [raw];
}

// Trim, drop empties, and fold any overflow past the cap into the last bubble.
export function normalizeMessages(messages: string[], maxMessages: number): string[] {
  const cleaned = messages.map((text) => text.trim()).filter((text) => text.length > 0);
  if (cleaned.length <= maxMessages) return cleaned;
  const head = cleaned.slice(0, maxMessages - 1);
  const merged = cleaned.slice(maxMessages - 1).join('\n');
  return [...head, merged];
}

export type TurnPlaybackState =
  | 'IDLE'
  | 'GENERATING'
  | 'TYPING'
  | 'DISPLAYING'
  | 'WAITING_INTERVAL';

export interface BubbleContext {
  turnId: string;
  sequenceNo: number;
  /** Canonical message id when Cloud already persisted this action. */
  actionId?: string;
  persisted?: boolean;
}

export interface TurnPlaybackHooks {
  // Called the moment a bubble is displayed — this is the point at which the
  // bubble should be persisted ("show one, write one").
  onBubble(text: string, context: BubbleContext): void;
  onTypingChange(typing: boolean): void;
  onStateChange?(state: TurnPlaybackState): void;
  onError?(reason: unknown): void;
  onDone?(turnId: string): void;
}

export interface Clock {
  now(): number;
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

interface PendingStep {
  handle: unknown;
  fn: () => void;
  dueAt: number;
}

interface QueuedBubble {
  content: string;
  actionId?: string;
  persisted: boolean;
}

/**
 * Drives one interruptible Agent turn: one model call yields 1–4 bubbles, which the
 * controller reveals on a fixed cadence (typing indicator → bubble → interval → …).
 * Sending a new turn, or calling interrupt(), abandons any not-yet-shown bubbles while
 * keeping the ones already displayed. A monotonically increasing version isolates a
 * late-returning stale request from a newer turn.
 */
export class TurnPlaybackController {
  private readonly config: TurnPlaybackConfig;
  private readonly hooks: TurnPlaybackHooks;
  private readonly clock: Clock;
  private readonly createTurnId: () => string;

  private activeVersion = 0;
  private state: TurnPlaybackState = 'IDLE';
  private queue: QueuedBubble[] = [];
  private index = 0;
  private turnId = '';
  private typing = false;

  private pending: PendingStep | null = null;
  private paused = false;
  private pausedStep: { fn: () => void; remaining: number } | null = null;

  constructor(
    hooks: TurnPlaybackHooks,
    options: {
      config?: Partial<TurnPlaybackConfig>;
      clock?: Clock;
      createTurnId?: () => string;
    } = {}
  ) {
    this.config = { ...DEFAULT_TURN_PLAYBACK_CONFIG, ...options.config };
    this.hooks = hooks;
    this.clock = options.clock ?? systemClock;
    this.createTurnId = options.createTurnId ?? createId;
  }

  getState(): TurnPlaybackState {
    return this.state;
  }

  isTyping(): boolean {
    return this.typing;
  }

  /**
   * Begin a new turn. `generate` performs the single model call and resolves with the
   * raw bubble texts (already parsed/degraded by the caller via parseTurnPlan).
   */
  async startTurn(generate: (version: number) => Promise<string[]>): Promise<void> {
    const version = ++this.activeVersion;
    this.reset();
    this.turnId = this.createTurnId();
    this.setState('GENERATING');
    const startedAt = this.clock.now();

    let raw: string[];
    try {
      raw = await generate(version);
    } catch (reason) {
      if (version !== this.activeVersion) return;
      this.fail(reason);
      return;
    }
    // A stale request that resolves after a newer turn began must not emit anything.
    if (version !== this.activeVersion) return;

    const messages = normalizeMessages(raw, this.config.maxMessagesPerTurn);
    // An empty plan is a failed generation, not a blank bubble.
    if (messages.length === 0) {
      this.fail(new Error('EMPTY_TURN_PLAN'));
      return;
    }

    this.queue = messages.map((content) => ({ content, persisted: false }));
    this.index = 0;

    // Roll the model latency into the first bubble's lead time so we never stack a
    // full typing delay on top of an already-slow response.
    const apiElapsed = this.clock.now() - startedAt;
    const firstFloor = this.config.turnStartDelayMs + calculateTypingDuration(messages[0]!, this.config);
    const firstWait = Math.max(firstFloor - apiElapsed, 0);
    this.leadIntoBubble(version, firstWait);
  }

  /**
   * Play a complete, validated Cloud turn. Canonical actions are never merged or
   * persisted again: their ids already name ordinary chat_message rows.
   */
  playSemanticTurn(
    turn: SemanticTurnV1,
    apiElapsedMs = 0,
    maxActions = SEMANTIC_ACTION_POLICY_V1.maxActions
  ): void {
    const version = ++this.activeVersion;
    this.reset();
    let parsed: SemanticTurnV1;
    try {
      parsed = parseSemanticTurnV1(turn, maxActions);
    } catch (reason) {
      this.fail(reason);
      return;
    }
    this.turnId = parsed.turn_id;
    this.queue = parsed.actions.map((action) => ({
      content: action.content,
      actionId: action.action_id,
      persisted: true
    }));
    this.index = 0;
    this.setState('GENERATING');
    const first = this.queue[0]!;
    const firstFloor = this.config.turnStartDelayMs + calculateTypingDuration(first.content, this.config);
    this.leadIntoBubble(version, Math.max(firstFloor - apiElapsedMs, 0));
  }

  /** Finish only an already-persisted queue before a newer user turn is appended. */
  finishCanonicalPlayback(): void {
    const remaining = this.queue.slice(this.index);
    if (remaining.length === 0) return;
    if (remaining.some((bubble) => !bubble.persisted)) {
      this.interrupt();
      return;
    }
    this.activeVersion += 1;
    this.clearPending();
    this.pausedStep = null;
    this.setTyping(false);
    while (this.index < this.queue.length) {
      const bubble = this.queue[this.index]!;
      this.hooks.onBubble(bubble.content, {
        turnId: this.turnId,
        sequenceNo: this.index + 1,
        actionId: bubble.actionId!,
        persisted: true
      });
      this.index += 1;
    }
    this.setState('IDLE');
    this.hooks.onDone?.(this.turnId);
  }

  /** Abandon the current turn. Already-displayed bubbles are kept by the caller. */
  interrupt(): void {
    this.activeVersion++;
    this.reset();
    this.setState('IDLE');
  }

  /** Freeze the countdown (e.g. tab hidden) without dumping the backlog. */
  pause(): void {
    if (this.paused) return;
    this.paused = true;
    if (this.pending) {
      const remaining = Math.max(this.pending.dueAt - this.clock.now(), 0);
      this.pausedStep = { fn: this.pending.fn, remaining };
      this.clock.clearTimeout(this.pending.handle);
      this.pending = null;
    }
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.pausedStep) {
      const { fn, remaining } = this.pausedStep;
      this.pausedStep = null;
      this.schedule(remaining, fn);
    }
  }

  private leadIntoBubble(version: number, waitMs: number): void {
    // Model already took longer than the first-bubble floor → show it now, with no
    // stacked typing wait, rather than deferring on a zero-length timer.
    if (waitMs <= 0) {
      this.displayCurrent(version);
      return;
    }
    this.setTyping(true);
    this.setState('TYPING');
    this.schedule(waitMs, () => this.displayCurrent(version));
  }

  private displayCurrent(version: number): void {
    if (version !== this.activeVersion) return;
    this.setTyping(false);
    const bubble = this.queue[this.index]!;
    this.setState('DISPLAYING');
    this.hooks.onBubble(
      bubble.content,
      bubble.persisted
        ? {
            turnId: this.turnId,
            sequenceNo: this.index + 1,
            actionId: bubble.actionId!,
            persisted: true
          }
        : { turnId: this.turnId, sequenceNo: this.index + 1 }
    );
    this.index += 1;

    if (this.index >= this.queue.length) {
      this.setState('IDLE');
      this.hooks.onDone?.(this.turnId);
      return;
    }

    this.setState('WAITING_INTERVAL');
    this.schedule(this.config.messageIntervalMs, () => {
      if (version !== this.activeVersion) return;
      const typingMs = calculateTypingDuration(this.queue[this.index]!.content, this.config);
      this.setTyping(true);
      this.setState('TYPING');
      this.schedule(typingMs, () => this.displayCurrent(version));
    });
  }

  private schedule(delayMs: number, fn: () => void): void {
    this.clearPending();
    if (this.paused) {
      // Hold the step until resume() rather than firing while backgrounded.
      this.pausedStep = { fn, remaining: delayMs };
      return;
    }
    const dueAt = this.clock.now() + delayMs;
    const handle = this.clock.setTimeout(() => {
      this.pending = null;
      fn();
    }, delayMs);
    this.pending = { handle, fn, dueAt };
  }

  private clearPending(): void {
    if (this.pending) {
      this.clock.clearTimeout(this.pending.handle);
      this.pending = null;
    }
  }

  private reset(): void {
    this.clearPending();
    this.pausedStep = null;
    this.setTyping(false);
    this.queue = [];
    this.index = 0;
  }

  private fail(reason: unknown): void {
    this.reset();
    this.setState('IDLE');
    this.hooks.onError?.(reason);
  }

  private setTyping(typing: boolean): void {
    if (this.typing === typing) return;
    this.typing = typing;
    this.hooks.onTypingChange(typing);
  }

  private setState(state: TurnPlaybackState): void {
    if (this.state === state) return;
    this.state = state;
    this.hooks.onStateChange?.(state);
  }
}
