import { expandMacros, type MacroContext } from './macro-engine';
import { resolveConversationPersona, type Persona } from './persona';
import {
  applyRegexScriptsBounded,
  RegexPlacement,
  regexScriptsForCharacter
} from './regex-engine';
import {
  activateWorldbookEntriesBounded,
  DEFAULT_WORLDBOOK_LIMITS,
  type ActivatedWorldbookEntry
} from './worldbook-activation';
import {
  sourcedWorldbookContextForTurn,
  type SourcedWorldbookEntry
} from './worldbook';
import type { PromptRole, WorldbookSource } from './lore-store';

export interface ScanMessage {
  role?: 'USER' | 'ASSISTANT' | 'user' | 'assistant';
  content_text: string;
}

export interface ClientContextPayload {
  version: 1;
  turn_time: string;
  activation_seed: string;
  persona?: {
    persona_id: string;
    name: string;
    content: string;
    position: 'IN_PROMPT' | 'AT_DEPTH' | 'NONE';
    depth?: number;
    role?: PromptRole;
  };
  worldbook_entries: Array<{
    entry_id: string;
    worldbook_id: string;
    source: WorldbookSource;
    content: string;
    position: 'BEFORE_CHAR' | 'AFTER_CHAR' | 'AT_DEPTH';
    depth?: number;
    role?: PromptRole;
    order: number;
  }>;
}

export interface ClientContextResult {
  payload: ClientContextPayload;
  persona: Persona | null;
  activated: ActivatedWorldbookEntry[];
  droppedForBudget: number;
  warnings: Array<'REGEX_TIMEOUT' | 'WORLDBOOK_TIMEOUT'>;
}

export const WORLDBOOK_DIAGNOSTIC_EVENT = 'litetavern:worldbook-activation';

function publishWorldbookDiagnostics(result: ClientContextResult): void {
  if (!import.meta.env.DEV || typeof globalThis.dispatchEvent !== 'function') return;
  const detail = {
    activation_seed: result.payload.activation_seed,
    entry_ids: result.activated.map(({ entry }) => entry.entry_id),
    worldbook_ids: [...new Set(
      result.activated.map(({ entry }) => entry.worldbook_id)
    )],
    dropped_for_budget: result.droppedForBudget,
    warnings: result.warnings
  };
  (globalThis as typeof globalThis & {
    __LITETAVERN_DEBUG__?: { lastWorldbookActivation: typeof detail };
  }).__LITETAVERN_DEBUG__ = { lastWorldbookActivation: detail };
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.litetavernWorldbookEntries = JSON.stringify(
      detail.entry_ids
    );
  }
  globalThis.dispatchEvent(new CustomEvent(WORLDBOOK_DIAGNOSTIC_EVENT, { detail }));
}

function macroMessages(messages: readonly ScanMessage[]) {
  return messages.flatMap((message) => {
    const role = message.role?.toLowerCase();
    return role === 'user' || role === 'assistant'
      ? [{ role: role as 'user' | 'assistant', content: message.content_text }]
      : [];
  });
}

export async function resolveClientContext(
  characterId: string,
  conversationId: string,
  messages: readonly ScanMessage[],
  pendingText: string,
  options: {
    activationSeed: string;
    turnTime?: string;
    macroContext?: MacroContext;
  }
): Promise<ClientContextResult> {
  const persona = await resolveConversationPersona(conversationId, characterId);
  const scripts = await regexScriptsForCharacter(characterId);
  const scanMessages = pendingText.trim()
    ? [...messages, { role: 'USER' as const, content_text: pendingText }]
    : [...messages];
  const macroUser = persona?.name || options.macroContext?.user;
  const macroPersona = persona?.description || options.macroContext?.persona;
  const macroContext: MacroContext = {
    ...(options.macroContext ?? {}),
    ...(macroUser ? { user: macroUser } : {}),
    ...(macroPersona ? { persona: macroPersona } : {}),
    messages: macroMessages(scanMessages),
    activationSeed: options.activationSeed
  };
  const sourcedContext = await sourcedWorldbookContextForTurn(
    characterId,
    conversationId,
    persona
  );
  let regexTimedOut = false;
  const processed: SourcedWorldbookEntry[] = [];
  for (const entry of sourcedContext.entries) {
    const result = await applyRegexScriptsBounded(entry.content, scripts, {
      placement: RegexPlacement.WORLD_INFO,
      macros: macroContext
    });
    regexTimedOut ||= result.timedOut;
    processed.push({
      ...entry,
      content: expandMacros(result.text, macroContext)
    });
  }
  const activation = await activateWorldbookEntriesBounded(
    processed,
    scanMessages,
    {
      maxEntries: DEFAULT_WORLDBOOK_LIMITS.maxEntries,
      tokenBudget:
        sourcedContext.tokenBudget ?? DEFAULT_WORLDBOOK_LIMITS.tokenBudget,
      maxBytes: DEFAULT_WORLDBOOK_LIMITS.maxBytes,
      maxRecursionSteps: DEFAULT_WORLDBOOK_LIMITS.maxRecursionSteps,
      recursive: true,
      activationSeed: options.activationSeed
    }
  );
  const payload: ClientContextPayload = {
    version: 1,
    turn_time: options.turnTime ?? new Date().toISOString(),
    activation_seed: options.activationSeed,
    ...(persona
      ? {
          persona: {
            persona_id: persona.persona_id,
            name: persona.name,
            content: expandMacros(persona.description, macroContext),
            position: persona.position,
            ...(persona.position === 'AT_DEPTH'
              ? { depth: persona.depth ?? 2, role: persona.role }
              : persona.position === 'IN_PROMPT'
                ? { role: persona.role }
                : {})
          }
        }
      : {}),
    worldbook_entries: activation.activated.map(({ entry }) => {
      const sourcedEntry = entry as SourcedWorldbookEntry;
      return {
        entry_id: entry.entry_id,
        worldbook_id: entry.worldbook_id,
        source: sourcedEntry.source,
        content: entry.content,
        position: entry.position,
        ...(entry.position === 'AT_DEPTH'
          ? { depth: entry.depth, role: entry.role }
          : {}),
        order: entry.insertion_order
      };
    })
  };
  const result: ClientContextResult = {
    payload,
    persona,
    activated: activation.activated,
    droppedForBudget: activation.droppedForBudget,
    warnings: [
      ...(regexTimedOut ? (['REGEX_TIMEOUT'] as const) : []),
      ...(activation.timedOut ? (['WORLDBOOK_TIMEOUT'] as const) : [])
    ]
  };
  publishWorldbookDiagnostics(result);
  return result;
}

export async function clientContextField(
  characterId: string | null | undefined,
  conversationId: string | null | undefined,
  messages: readonly ScanMessage[],
  pendingText: string,
  options: {
    activationSeed: string;
    turnTime?: string;
    macroContext?: MacroContext;
  }
): Promise<{ client_context: ClientContextPayload } | Record<string, never>> {
  if (!characterId || !conversationId) return {};
  const result = await resolveClientContext(
    characterId,
    conversationId,
    messages,
    pendingText,
    options
  );
  return { client_context: result.payload };
}
