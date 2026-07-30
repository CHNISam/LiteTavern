import { seededRandom } from './macro-engine';
import { parseRegexLiteral } from './regex-engine';
import type {
  SelectiveLogic,
  WorldbookEntryAsset,
  WorldbookPosition
} from './lore-store';

export type { SelectiveLogic, WorldbookPosition };

export interface WorldbookLimits {
  maxEntries?: number;
  tokenBudget?: number;
  maxBytes?: number;
  recursive?: boolean;
  maxRecursionSteps?: number;
  activationSeed?: string;
  random?: () => number;
}

export interface ActivatedWorldbookEntry {
  entry: WorldbookEntryAsset;
  reason: 'CONSTANT' | 'KEY_MATCH';
  tokens: number;
  recursion_step: number;
}

export interface WorldbookActivation {
  activated: ActivatedWorldbookEntry[];
  droppedForBudget: number;
  tokensUsed: number;
  bytesUsed: number;
  recursionSteps: number;
  stoppedBy: 'NONE' | 'ENTRY_LIMIT' | 'TOKEN_BUDGET' | 'BYTE_BUDGET' | 'RECURSION_LIMIT';
}

export const DEFAULT_WORLDBOOK_LIMITS: Required<
  Pick<
    WorldbookLimits,
    'maxEntries' | 'tokenBudget' | 'maxBytes' | 'recursive' | 'maxRecursionSteps'
  >
> = {
  maxEntries: 24,
  tokenBudget: 800,
  maxBytes: 64 * 1024,
  recursive: true,
  maxRecursionSteps: 8
};
export const DEFAULT_WORLDBOOK_SCAN_DEPTH = 4;
export const MAX_WORLDBOOK_SCAN_DEPTH = 20;
export const MAX_WORLDBOOK_TOKENS = 8_000;
const encoder = new TextEncoder();

export function estimateWorldbookTokens(text: string): number {
  return Math.max(1, Math.ceil(encoder.encode(text).length / 2));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function literalMatch(
  haystack: string,
  key: string,
  wholeWords: boolean
): boolean {
  if (!wholeWords) return haystack.includes(key);
  try {
    return new RegExp(
      `(?<![\\p{L}\\p{N}_])${escapeRegExp(key)}(?![\\p{L}\\p{N}_])`,
      'u'
    ).test(haystack);
  } catch {
    return false;
  }
}

function keyMatches(
  haystack: string,
  rawKey: string,
  wholeWords: boolean,
  caseSensitive: boolean
): boolean {
  const key = rawKey.trim();
  if (!key) return false;
  if (key.startsWith('/')) {
    const expression = parseRegexLiteral(key);
    if (!expression) return false;
    expression.lastIndex = 0;
    return expression.test(haystack);
  }
  const source = caseSensitive ? haystack : haystack.toLocaleLowerCase();
  const needle = caseSensitive ? key : key.toLocaleLowerCase();
  return literalMatch(source, needle, wholeWords);
}

function matchesAny(
  haystack: string,
  keys: string[],
  entry: WorldbookEntryAsset
): boolean {
  return keys.some((key) =>
    keyMatches(
      haystack,
      key,
      entry.match_whole_words,
      entry.case_sensitive
    )
  );
}

function matchesAll(
  haystack: string,
  keys: string[],
  entry: WorldbookEntryAsset
): boolean {
  return keys.every((key) =>
    keyMatches(
      haystack,
      key,
      entry.match_whole_words,
      entry.case_sensitive
    )
  );
}

function secondaryPasses(entry: WorldbookEntryAsset, text: string): boolean {
  const keys = entry.secondary_keys.map((key) => key.trim()).filter(Boolean);
  if (!entry.selective || keys.length === 0) return true;
  switch (entry.selective_logic) {
    case 'AND_ALL':
      return matchesAll(text, keys, entry);
    case 'NOT_ANY':
      return !matchesAny(text, keys, entry);
    case 'NOT_ALL':
      return !matchesAll(text, keys, entry);
    default:
      return matchesAny(text, keys, entry);
  }
}

type ScanInput = string | readonly { content_text: string }[];

function scanText(input: ScanInput, depth: number): string {
  if (typeof input === 'string') return input;
  return buildWorldbookScanText(input, depth);
}

function activationReason(
  entry: WorldbookEntryAsset,
  input: ScanInput,
  recursionStep: number,
  random: () => number
): 'CONSTANT' | 'KEY_MATCH' | null {
  if (!entry.enabled || !entry.content.trim()) return null;
  if (recursionStep > 0 && entry.exclude_recursion) return null;
  if (recursionStep === 0 && entry.delay_until_recursion) return null;
  const text = scanText(
    input,
    entry.scan_depth ?? DEFAULT_WORLDBOOK_SCAN_DEPTH
  );
  let reason: 'CONSTANT' | 'KEY_MATCH' | null = null;
  if (entry.constant) reason = 'CONSTANT';
  else if (
    entry.keys.some((key) => key.trim()) &&
    matchesAny(text, entry.keys, entry) &&
    secondaryPasses(entry, text)
  ) {
    reason = 'KEY_MATCH';
  }
  if (!reason) return null;
  if (
    entry.use_probability &&
    random() * 100 >= Math.min(100, Math.max(0, entry.probability))
  ) {
    return null;
  }
  return reason;
}

function byBudgetPriority(
  left: WorldbookEntryAsset,
  right: WorldbookEntryAsset
): number {
  const leftPriority = left.priority ?? left.insertion_order;
  const rightPriority = right.priority ?? right.insertion_order;
  return (
    rightPriority - leftPriority ||
    left.insertion_order - right.insertion_order ||
    left.entry_id.localeCompare(right.entry_id)
  );
}

function byInsertionOrder(
  left: ActivatedWorldbookEntry,
  right: ActivatedWorldbookEntry
): number {
  return (
    left.entry.insertion_order - right.entry.insertion_order ||
    left.entry.entry_id.localeCompare(right.entry.entry_id)
  );
}

export function activateWorldbookEntries(
  entries: readonly WorldbookEntryAsset[],
  input: ScanInput,
  limits: WorldbookLimits = {}
): WorldbookActivation {
  const maxEntries = Math.min(
    24,
    Math.max(0, Math.trunc(limits.maxEntries ?? DEFAULT_WORLDBOOK_LIMITS.maxEntries))
  );
  const tokenBudget = Math.min(
    MAX_WORLDBOOK_TOKENS,
    Math.max(1, Math.trunc(limits.tokenBudget ?? DEFAULT_WORLDBOOK_LIMITS.tokenBudget))
  );
  const maxBytes = Math.min(
    64 * 1024,
    Math.max(1, Math.trunc(limits.maxBytes ?? DEFAULT_WORLDBOOK_LIMITS.maxBytes))
  );
  const maxRecursion = Math.min(
    8,
    Math.max(
      0,
      Math.trunc(
        limits.maxRecursionSteps ?? DEFAULT_WORLDBOOK_LIMITS.maxRecursionSteps
      )
    )
  );
  const recursive = limits.recursive ?? DEFAULT_WORLDBOOK_LIMITS.recursive;
  const seeded = seededRandom(limits.activationSeed ?? 'litetavern-worldbook');
  const random = limits.random ?? seeded;
  const selected: ActivatedWorldbookEntry[] = [];
  const seenIds = new Set<string>();
  const seenContent = new Set<string>();
  let droppedForBudget = 0;
  let tokensUsed = 0;
  let bytesUsed = 0;
  let stoppedBy: WorldbookActivation['stoppedBy'] = 'NONE';
  let recursionStep = 0;
  let recursiveText = typeof input === 'string' ? input : scanText(input, 20);

  while (true) {
    const candidates = entries.flatMap((entry) => {
      if (seenIds.has(entry.entry_id)) return [];
      const reason = activationReason(
        entry,
        recursionStep === 0 ? input : recursiveText,
        recursionStep,
        random
      );
      if (!reason) return [];
      const content = entry.content.trim();
      if (seenContent.has(content)) {
        seenIds.add(entry.entry_id);
        return [];
      }
      return [
        {
          entry,
          reason,
          tokens: estimateWorldbookTokens(content),
          recursion_step: recursionStep
        } satisfies ActivatedWorldbookEntry
      ];
    });
    if (!candidates.length) break;
    candidates.sort((left, right) => byBudgetPriority(left.entry, right.entry));
    const newlySelected: ActivatedWorldbookEntry[] = [];
    for (const candidate of candidates) {
      const content = candidate.entry.content.trim();
      const bytes = encoder.encode(content).length;
      // A rejected candidate cannot become cheaper in a later recursion step, so mark
      // it evaluated now instead of counting the same drop repeatedly.
      seenIds.add(candidate.entry.entry_id);
      if (selected.length >= maxEntries) {
        droppedForBudget += 1;
        stoppedBy = 'ENTRY_LIMIT';
        continue;
      }
      if (tokensUsed + candidate.tokens > tokenBudget) {
        droppedForBudget += 1;
        if (stoppedBy === 'NONE') stoppedBy = 'TOKEN_BUDGET';
        continue;
      }
      if (bytesUsed + bytes > maxBytes) {
        droppedForBudget += 1;
        if (stoppedBy === 'NONE') stoppedBy = 'BYTE_BUDGET';
        continue;
      }
      seenContent.add(content);
      selected.push(candidate);
      newlySelected.push(candidate);
      tokensUsed += candidate.tokens;
      bytesUsed += bytes;
    }
    if (!recursive || !newlySelected.length) break;
    const recursionContent = newlySelected
      .filter((item) => !item.entry.prevent_recursion)
      .map((item) => item.entry.content)
      .join('\n');
    if (!recursionContent) break;
    if (recursionStep >= maxRecursion) {
      stoppedBy = 'RECURSION_LIMIT';
      break;
    }
    recursiveText += `\n${recursionContent}`;
    recursionStep += 1;
  }

  selected.sort(byInsertionOrder);
  return {
    activated: selected,
    droppedForBudget,
    tokensUsed,
    bytesUsed,
    recursionSteps: recursionStep,
    stoppedBy
  };
}

export async function activateWorldbookEntriesBounded(
  entries: readonly WorldbookEntryAsset[],
  input: ScanInput,
  limits: WorldbookLimits = {},
  timeoutMs = 75
): Promise<WorldbookActivation & { timedOut: boolean }> {
  if (typeof Worker === 'undefined') {
    return { ...activateWorldbookEntries(entries, input, limits), timedOut: false };
  }
  const worker = new Worker(
    new URL('./worldbook-activation-worker.ts', import.meta.url),
    { type: 'module' }
  );
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      worker.terminate();
      resolve({
        activated: [],
        droppedForBudget: 0,
        tokensUsed: 0,
        bytesUsed: 0,
        recursionSteps: 0,
        stoppedBy: 'NONE',
        timedOut: true
      });
    }, timeoutMs);
    worker.onmessage = (event: MessageEvent<WorldbookActivation>) => {
      window.clearTimeout(timeout);
      worker.terminate();
      resolve({ ...event.data, timedOut: false });
    };
    worker.onerror = () => {
      window.clearTimeout(timeout);
      worker.terminate();
      resolve({
        ...activateWorldbookEntries(
          entries.filter((entry) => !entry.keys.some((key) => key.startsWith('/'))),
          input,
          limits
        ),
        timedOut: false
      });
    };
    worker.postMessage({ entries, input, limits });
  });
}

export function buildWorldbookScanText(
  messages: readonly { content_text: string }[],
  scanDepth = DEFAULT_WORLDBOOK_SCAN_DEPTH
): string {
  const depth = Math.min(
    MAX_WORLDBOOK_SCAN_DEPTH,
    Math.max(1, Math.trunc(scanDepth) || DEFAULT_WORLDBOOK_SCAN_DEPTH)
  );
  return messages
    .slice(-depth)
    .map((message) => message.content_text ?? '')
    .join('\n');
}
