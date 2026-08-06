import { expandMacros, type MacroContext } from './macro-engine';
import {
  getAllLocalRecords,
  getLocalRecord,
  mutateLocalAssets,
  nowIso,
  putLocalRecord,
  type RegexPermissionRecord,
  type RegexScriptRecord
} from './lore-store';

export enum RegexPlacement {
  USER_INPUT = 1,
  AI_OUTPUT = 2,
  WORLD_INFO = 5
}

export interface RegexScript {
  id: string;
  scriptName: string;
  findRegex: string;
  replaceString: string;
  trimStrings: string[];
  placement: RegexPlacement[];
  disabled: boolean;
  markdownOnly: boolean;
  promptOnly: boolean;
  runOnEdit: boolean;
  substituteRegex: number;
  minDepth: number | null;
  maxDepth: number | null;
  source_fields?: Record<string, unknown>;
}

export interface RegexExecutionOptions {
  placement: RegexPlacement;
  macros: MacroContext;
  depth?: number;
  editing?: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeRegexScript(
  value: unknown,
  options: { trusted: boolean }
): RegexScript {
  const source = record(value);
  const placement = Array.isArray(source.placement)
    ? source.placement
        .filter((item): item is number => typeof item === 'number')
        .filter(
          (item): item is RegexPlacement =>
            item === RegexPlacement.USER_INPUT ||
            item === RegexPlacement.AI_OUTPUT ||
            item === RegexPlacement.WORLD_INFO
        )
    : [];
  return {
    id:
      typeof source.id === 'string' && source.id
        ? source.id
        : crypto.randomUUID(),
    scriptName:
      typeof source.scriptName === 'string'
        ? source.scriptName
        : typeof source.name === 'string'
          ? source.name
          : 'Regex script',
    findRegex: typeof source.findRegex === 'string' ? source.findRegex : '',
    replaceString:
      typeof source.replaceString === 'string' ? source.replaceString : '',
    trimStrings: Array.isArray(source.trimStrings)
      ? source.trimStrings.filter(
          (item): item is string => typeof item === 'string'
        )
      : [],
    placement,
    disabled: !options.trusted || source.disabled === true,
    markdownOnly: source.markdownOnly === true,
    promptOnly: source.promptOnly === true,
    runOnEdit: source.runOnEdit !== false,
    substituteRegex:
      typeof source.substituteRegex === 'number' ? source.substituteRegex : 0,
    minDepth: typeof source.minDepth === 'number' ? source.minDepth : null,
    maxDepth: typeof source.maxDepth === 'number' ? source.maxDepth : null,
    source_fields: Object.fromEntries(
      Object.entries(source).filter(
        ([key]) =>
          ![
            'id',
            'scriptName',
            'name',
            'findRegex',
            'replaceString',
            'trimStrings',
            'placement',
            'disabled',
            'markdownOnly',
            'promptOnly',
            'runOnEdit',
            'substituteRegex',
            'minDepth',
            'maxDepth'
          ].includes(key)
      )
    )
  };
}

export function isUnsafeRegexSource(source: string): boolean {
  if (source.length > 2_000) return true;
  // Reject common catastrophic nested repetitions. The Worker timeout is the final
  // boundary; this fast check avoids dispatching obviously hostile patterns.
  return /(?:\([^)]*[+*][^)]*\)|\[[^\]]+\][+*])[+*{]/.test(source);
}

export function parseRegexLiteral(value: string): RegExp | null {
  if (!value) return null;
  const match = value.match(/^\/([\s\S]*)\/([dgimsuvy]*)$/);
  const source = match ? match[1] ?? '' : value;
  const flags = match ? match[2] ?? '' : 'g';
  if (isUnsafeRegexSource(source)) return null;
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

function trimCapture(value: string, trimStrings: string[]): string {
  return trimStrings.reduce(
    (current, item) => (item ? current.split(item).join('') : current),
    value
  );
}

function replaceOne(
  input: string,
  script: RegexScript,
  macros: MacroContext
): string {
  const expression = parseRegexLiteral(script.findRegex);
  if (!expression) return input;
  try {
    return input.replace(
      expression,
      (
        match: string,
        ...args: Array<string | number | Record<string, string> | undefined>
      ) => {
        const offsetIndex = args.findIndex((item) => typeof item === 'number');
        const captures = args
          .slice(0, offsetIndex)
          .map((item) => (typeof item === 'string' ? item : ''));
        const groups =
          args.find(
            (item): item is Record<string, string> =>
              Boolean(item) && typeof item === 'object'
          ) ?? {};
        let replacement = script.replaceString
          .replace(/\$<([^>]+)>/g, (_whole, name: string) =>
            trimCapture(groups[name] ?? '', script.trimStrings)
          )
          .replace(/\$(\d+)/g, (_whole, rawIndex: string) =>
            trimCapture(captures[Number(rawIndex) - 1] ?? '', script.trimStrings)
          )
          .replaceAll('{{match}}', match);
        replacement = expandMacros(replacement, macros);
        return replacement;
      }
    );
  } catch {
    return input;
  }
}

export function applyRegexScripts(
  input: string,
  scripts: readonly RegexScript[],
  options: RegexExecutionOptions
): string {
  return scripts.reduce((current, script) => {
    const depth = options.depth ?? 0;
    if (script.disabled || !script.placement.includes(options.placement)) return current;
    if (options.editing && !script.runOnEdit) return current;
    if (script.minDepth !== null && depth < script.minDepth) return current;
    if (script.maxDepth !== null && depth > script.maxDepth) return current;
    return replaceOne(current, script, options.macros);
  }, input);
}

export interface RegexExecutionResult {
  text: string;
  timedOut: boolean;
}

/** Run untrusted patterns in an interruptible Worker, with a pure fallback for tests. */
export async function applyRegexScriptsBounded(
  input: string,
  scripts: readonly RegexScript[],
  options: RegexExecutionOptions,
  timeoutMs = 75
): Promise<RegexExecutionResult> {
  const depth = options.depth ?? 0;
  const hasRunnableScript = scripts.some((script) =>
    !script.disabled &&
    script.placement.includes(options.placement) &&
    (!options.editing || script.runOnEdit) &&
    (script.minDepth === null || depth >= script.minDepth) &&
    (script.maxDepth === null || depth <= script.maxDepth)
  );
  if (!hasRunnableScript) return { text: input, timedOut: false };
  if (typeof Worker === 'undefined') {
    return { text: applyRegexScripts(input, scripts, options), timedOut: false };
  }
  const worker = new Worker(new URL('./regex-worker.ts', import.meta.url), {
    type: 'module'
  });
  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => {
      worker.terminate();
      resolve({ text: input, timedOut: true });
    }, timeoutMs);
    worker.onmessage = (event: MessageEvent<{ text: string }>) => {
      window.clearTimeout(timeout);
      worker.terminate();
      resolve({ text: event.data.text, timedOut: false });
    };
    worker.onerror = () => {
      window.clearTimeout(timeout);
      worker.terminate();
      resolve({ text: input, timedOut: false });
    };
    worker.postMessage({ input, scripts, options });
  });
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export async function regexBundleHash(scripts: unknown[]): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(scripts));
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }
  let hash = 2166136261;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export async function saveCharacterRegexBundle(
  characterId: string,
  rawScripts: unknown[],
  authorize: boolean
): Promise<{ hash: string; scripts: RegexScript[] }> {
  const hash = await regexBundleHash(rawScripts);
  const timestamp = nowIso();
  const scripts = rawScripts.map((value) =>
    normalizeRegexScript(value, { trusted: authorize })
  );
  const existing = (
    await getAllLocalRecords<RegexScriptRecord>('regex_scripts')
  ).filter((item) => item.character_id === characterId);
  await mutateLocalAssets(
    ['regex_scripts', 'permissions'],
    (transaction) => {
      for (const item of existing) {
        transaction.objectStore('regex_scripts').delete(item.script_id);
      }
      for (const script of scripts) {
        transaction.objectStore('regex_scripts').put({
          script_id: `character:${characterId}:${script.id}`,
          scope: 'CHARACTER',
          character_id: characterId,
          bundle_hash: hash,
          payload: script as unknown as Record<string, unknown>,
          created_at: timestamp,
          updated_at: timestamp
        } satisfies RegexScriptRecord);
      }
      if (authorize) {
        transaction.objectStore('permissions').put({
          permission_id: `regex:${characterId}`,
          character_id: characterId,
          regex_bundle_hash: hash,
          granted_at: timestamp
        } satisfies RegexPermissionRecord);
      } else {
        transaction.objectStore('permissions').delete(`regex:${characterId}`);
      }
    }
  );
  return { hash, scripts };
}

export async function characterRegexAuthorized(
  characterId: string,
  hash: string
): Promise<boolean> {
  const permission = await getLocalRecord<RegexPermissionRecord>(
    'permissions',
    `regex:${characterId}`
  );
  return permission?.regex_bundle_hash === hash;
}

export async function regexScriptsForCharacter(
  characterId: string
): Promise<RegexScript[]> {
  const records = await getAllLocalRecords<RegexScriptRecord>('regex_scripts');
  const permission = await getLocalRecord<RegexPermissionRecord>(
    'permissions',
    `regex:${characterId}`
  );
  return records.flatMap((item) => {
    if (item.scope === 'GLOBAL') {
      return [normalizeRegexScript(item.payload, { trusted: true })];
    }
    if (
      item.character_id === characterId &&
      item.bundle_hash &&
      permission?.regex_bundle_hash === item.bundle_hash
    ) {
      return [normalizeRegexScript(item.payload, { trusted: true })];
    }
    return [];
  });
}

export async function regexScriptsForExport(
  characterId: string
): Promise<Record<string, unknown>[]> {
  const records = await getAllLocalRecords<RegexScriptRecord>('regex_scripts');
  return records
    .filter(
      (item) =>
        item.scope === 'CHARACTER' && item.character_id === characterId
    )
    .map((item) => structuredClone(item.payload));
}

export async function authorizeCharacterRegex(
  characterId: string,
  hash: string
): Promise<void> {
  await putLocalRecord<RegexPermissionRecord>('permissions', {
    permission_id: `regex:${characterId}`,
    character_id: characterId,
    regex_bundle_hash: hash,
    granted_at: nowIso()
  });
}
