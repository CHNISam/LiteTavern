export interface MacroMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface MacroContext {
  user?: string;
  char?: string;
  persona?: string;
  description?: string;
  personality?: string;
  scenario?: string;
  mesExamples?: string;
  original?: string;
  messages?: MacroMessage[];
  now?: Date;
  locale?: string;
  timeZone?: string;
  activationSeed?: string;
  dynamic?: Record<string, string>;
}

function hash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

export function seededRandom(seed: string): () => number {
  let state = hash(seed) || 0x9e3779b9;
  return () => {
    state += 0x6d2b79f5;
    let next = state;
    next = Math.imul(next ^ (next >>> 15), next | 1);
    next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
    return ((next ^ (next >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function recent(context: MacroContext, role?: 'user' | 'assistant'): string {
  const message = [...(context.messages ?? [])]
    .reverse()
    .find((item) => !role || item.role === role);
  return message?.content ?? '';
}

function utilityMacro(
  name: string,
  args: string[],
  context: MacroContext,
  random: () => number
): string | null {
  const now = context.now ?? new Date();
  const locale = context.locale ?? undefined;
  const timeZone = context.timeZone;
  const dateOptions = timeZone ? { timeZone } : {};
  switch (name) {
    case 'date':
      return new Intl.DateTimeFormat(locale, dateOptions).format(now);
    case 'time':
      return new Intl.DateTimeFormat(locale, {
        ...dateOptions,
        hour: '2-digit',
        minute: '2-digit'
      }).format(now);
    case 'weekday':
      return new Intl.DateTimeFormat(locale, {
        ...dateOptions,
        weekday: 'long'
      }).format(now);
    case 'isodate':
      return now.toLocaleDateString('sv-SE', dateOptions);
    case 'isotime':
      return new Intl.DateTimeFormat('en-GB', {
        ...dateOptions,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
      }).format(now);
    case 'newline':
      return '\n'.repeat(Math.min(20, Math.max(1, Number(args[0]) || 1)));
    case 'space':
      return ' '.repeat(Math.min(100, Math.max(1, Number(args[0]) || 1)));
    case 'trim':
      return args.join('::').trim();
    case 'noop':
      return '';
    case 'random':
    case 'pick': {
      if (!args.length) return '';
      return args[Math.floor(random() * args.length)] ?? '';
    }
    case 'roll': {
      const expression = args[0] ?? '100';
      const dice = expression.match(/^(\d{1,2})d(\d{1,6})$/i);
      if (dice) {
        const count = Math.min(20, Number(dice[1]));
        const sides = Math.max(1, Number(dice[2]));
        let total = 0;
        for (let index = 0; index < count; index += 1) {
          total += Math.floor(random() * sides) + 1;
        }
        return String(total);
      }
      const ceiling = Math.max(1, Number(expression) || 100);
      return String(Math.floor(random() * ceiling) + 1);
    }
    default:
      return null;
  }
}

/**
 * Core SillyTavern macro compatibility. Unsupported condition/variable/group/model
 * expressions remain verbatim so import/export never turns preservation into
 * accidental execution.
 */
export function expandMacros(
  input: string,
  context: MacroContext,
  maxPasses = 4
): string {
  const random = seededRandom(context.activationSeed ?? 'litetavern');
  const dynamic = Object.fromEntries(
    Object.entries(context.dynamic ?? {}).map(([key, value]) => [
      key.toLowerCase(),
      value
    ])
  );
  const values: Record<string, string> = {
    user: context.user ?? '',
    username: context.user ?? '',
    char: context.char ?? '',
    charname: context.char ?? '',
    persona: context.persona ?? '',
    description: context.description ?? '',
    personality: context.personality ?? '',
    scenario: context.scenario ?? '',
    mesexamples: context.mesExamples ?? '',
    mes_example: context.mesExamples ?? '',
    original: context.original ?? '',
    lastmessage: recent(context),
    lastmes: recent(context),
    lastusermessage: recent(context, 'user'),
    lastuser: recent(context, 'user'),
    lastcharmessage: recent(context, 'assistant'),
    lastchar: recent(context, 'assistant'),
    ...dynamic
  };

  let output = input;
  const passes = Math.min(8, Math.max(1, maxPasses));
  for (let pass = 0; pass < passes; pass += 1) {
    let changed = false;
    output = output.replace(/\{\{([^{}]+)\}\}/g, (whole, body: string) => {
      const [rawName, ...args] = body.split('::');
      const name = (rawName ?? '').trim().toLowerCase();
      const known = values[name];
      if (known !== undefined) {
        changed = changed || known !== whole;
        return known;
      }
      const utility = utilityMacro(name, args, context, random);
      if (utility !== null) {
        changed = true;
        return utility;
      }
      return whole;
    });
    if (!changed) break;
  }
  return output;
}
