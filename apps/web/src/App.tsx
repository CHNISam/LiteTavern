import {
  lazy,
  Suspense,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode
} from 'react';
import {
  ArrowLeft, BookOpen, Brain, Check, ChevronDown, ChevronLeft, ChevronRight, CircleAlert, Copy,
  Download, KeyRound, LoaderCircle, MessageCircle, MoreHorizontal, Pencil, Plus, Send,
  RotateCcw, Settings, Sparkles, Square,
  Trash2, Upload, UserRound, Volume2, VolumeX
} from 'lucide-react';
import { Avatar } from './components/Avatar';
import { AccountSyncPanel } from './components/CloudPanel';
import { ProviderSettings } from './components/ProviderSettings';
import { AppSettingsPanel } from './components/AppSettingsPanel';
import { ProductFeedback } from './components/ProductFeedback';
import { GenerationDiagnostics } from './components/GenerationDiagnostics';
import { ConversationPersonaPanel, PersonaPanel } from './components/PersonaPanel';
import { CharacterWorldbookPanel, WorldbookPanel } from './components/WorldbookPanel';
import { CharacterImport } from './components/CharacterImport';
import { CharacterEditor } from './components/CharacterEditor';
import { RelationshipImport } from './components/RelationshipImport';
import { LoginSync } from './components/LoginSync';
import { AboutPage } from './pages/AboutPage';
import { SupportPage } from './pages/SupportPage';
import {
  ApiError, api, fetchReplySuggestions,
  streamGeneration,
  activateMessageVariant,
  fetchMessageVariants,
  type AnonymousIdentity, type Character, type Message, type ModelConfiguration
} from './lib/api';
import {
  fetchCharacterCard,
  patchCharacterCard,
  saveLocalCharacter,
  type CardDetail,
  type CharacterModel
} from './lib/character-card';
import { t as translate, useLocale, useT } from './lib/i18n';
import { trackKeyboardInset } from './lib/keyboard-inset';
import { analytics, type AnalyticsPageName } from './lib/analytics';
import {
  fetchCloudStatus,
  quotaLabel,
  readCachedStatus,
  reportSyncCheckpoint,
  resolveCloudModelServiceState,
  resolveCloudNotice,
  type CloudBlockReason,
  type CloudNotice,
  type CloudModelServiceState,
  type CloudStatus
} from './lib/cloud';
import { useCloudAccount } from './lib/cloud-auth';
import {
  cachedCharacters,
  cachedConversationId,
  cachedMessages
} from './lib/local-cache';
import { cloudBaseUrl, cloudUrl } from './lib/runtime-config';
import { credentialStore } from './lib/credential-store';
import { modelConfigurationStore } from './lib/model-configuration-store';
import { streamByokGeneration } from './lib/byok-client';
import { flushClientTurnOutbox } from './lib/client-turn-sync';
import { copyText } from './lib/clipboard';
import { createId } from './lib/id';
import { getOrCreateDeviceId } from './lib/device-identity';
import {
  chatRepository,
  repositoryPartition,
  type RepositoryPrincipal
} from './lib/chat-repository';
import { TurnPlaybackController } from './lib/turn-playback';
import { playClick, isMuted, setMuted } from './lib/sound';
import { publicRouteForPath } from './public-routing';
import { clientContextField } from './lib/lore-runtime';
import {
  applyRegexScriptsBounded,
  RegexPlacement,
  regexScriptsForCharacter
} from './lib/regex-engine';
import { resolveConversationPersona } from './lib/persona';
import {
  buildLocalCharacterExport,
  downloadLocalCharacterExport
} from './lib/local-card-assets';
import { migrateLegacyCloudAssets } from './lib/legacy-lore-migration';
import {
  readModelPreference,
  writeModelPreference
} from './lib/model-preference';
import {
  readQuickReplySettings,
  writeQuickReplySettings,
  type QuickReplySettings
} from './lib/quick-replies';
import {
  readReplySuggestionsSettings,
  suggestionKeyFor,
  writeReplySuggestionsSettings,
  type ReplySuggestionsSettings,
  type ReplySuggestionsTrigger
} from './lib/reply-suggestions';
import {
  generationDiagnosticsEnabled,
  withRuntimeTraceLayers,
  type GenerationDiagnosticTraceV1
} from './lib/generation-diagnostics';

// 'settings' is gone: the character settings page repeated the profile and hid
// the editor at the bottom of it. Editing lives on the profile now.
type View = 'chat' | 'profile' | 'memories';

const AdminApp = lazy(() => import('./admin/AdminApp'));

/**
 * Every reason the Cloud can refuse a platform generation. The error code and the
 * status field share one vocabulary, so a refusal mid-generation lands the client
 * in exactly the state a fresh `/v1/cloud/status` would have described.
 */
const BLOCK_REASONS: readonly CloudBlockReason[] = [
  'GUEST',
  'EMAIL_UNVERIFIED',
  'ALPHA_CAPACITY_FULL',
  'WAITLISTED',
  'ACCOUNT_SUSPENDED',
  'DAILY_QUOTA_EXHAUSTED',
  'PERIOD_QUOTA_EXHAUSTED',
  'CONCURRENT_GENERATION',
  'PROVIDER_UNAVAILABLE',
  'PLATFORM_MODELS_NOT_CONFIGURED',
  'CLOUD_CONTRACT_BLOCKED'
];

/**
 * Block reasons the deployment cannot recover from on its own. Retrying one of
 * these can only ever fail again, so no retry affordance and no `retryable`
 * analytics flag may be attached to them.
 */
function isSelfHealing(reason: CloudBlockReason | null): boolean {
  return reason === 'PROVIDER_UNAVAILABLE';
}

function blockReasonFor(code: string | undefined): CloudBlockReason | null {
  const match = BLOCK_REASONS.find((reason) => reason === code);
  return match ?? null;
}

function analyticsErrorCode(code: string): string {
  if (code === 'DAILY_QUOTA_EXHAUSTED' || code === 'PERIOD_QUOTA_EXHAUSTED') {
    return 'quota_exhausted';
  }
  if (code === 'PROVIDER_TIMEOUT') return 'generation_timeout';
  // Its own event, deliberately: folding it into `provider_unavailable` is what
  // hid "this deployment was never configured" inside "the upstream blipped".
  if (code === 'PLATFORM_MODELS_NOT_CONFIGURED') {
    return 'platform_models_not_configured';
  }
  if (code === 'PROVIDER_UNAVAILABLE' || code === 'PROVIDER_RATE_LIMITED') {
    return 'provider_unavailable';
  }
  if (code === 'TURN_FORMAT_INVALID') return 'turn_format_invalid';
  if (code === 'TURN_DEGENERATED') return 'turn_degenerated';
  if (code === 'STREAM_PROTOCOL_CORRUPTED') return 'stream_protocol_corrupted';
  if (code === 'MODEL_CAPABILITY_MISCONFIGURED') {
    return 'model_capability_misconfigured';
  }
  // The upstream rejected the request itself. Retrying it unchanged can only be
  // rejected again, so it must not sink into the generic failure bucket where a
  // permanent break would read as ordinary noise.
  if (code === 'PROVIDER_REQUEST_INVALID') return 'provider_request_invalid';
  if (code === 'PROVIDER_TEMPORARY_FAILURE') return 'provider_temporary_failure';
  if (blockReasonFor(code)) return 'cloud_blocked';
  return 'generation_failed';
}

export function App() {
  const publicRoute = publicRouteForPath(window.location.pathname);
  if (publicRoute === 'support') {
    const query = new URLSearchParams(window.location.search);
    return (
      <SupportPage
        source={query.get('source')}
        placement={query.get('placement')}
      />
    );
  }
  if (publicRoute === 'about') return <AboutPage />;
  if (publicRoute === 'admin') {
    return (
      <Suspense fallback={<main className="admin-loading">{translate().admin.loading}</main>}>
        <AdminApp />
      </Suspense>
    );
  }
  return <ProductApp />;
}

function ProductApp() {
  const initialModelPreference = useRef(readModelPreference()).current;
  const initialQuickReplies = useRef(readQuickReplySettings()).current;
  const initialReplySuggestions = useRef(readReplySuggestionsSettings()).current;
  const t = useT();
  // Reply suggestions are written in the interface language, so this is a request
  // input, not only a rendering concern.
  const { locale } = useLocale();
  const diagnosticsEnabled = generationDiagnosticsEnabled();
  const [characters, setCharacters] = useState<Character[]>([]);
  const [active, setActive] = useState<Character | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [view, setView] = useState<View>('chat');
  const [providerOpen, setProviderOpen] = useState(false);
  const [providerInitialSection, setProviderInitialSection] =
    useState<'overview' | 'platform' | 'byok'>('overview');
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [generationTrace, setGenerationTrace] =
    useState<GenerationDiagnosticTraceV1 | null>(null);
  const [personaPanelOpen, setPersonaPanelOpen] = useState(false);
  const [worldbookPanelOpen, setWorldbookPanelOpen] = useState(false);
  const [conversationPersonaOpen, setConversationPersonaOpen] = useState(false);
  const [characterWorldbookOpen, setCharacterWorldbookOpen] = useState(false);
  // Which browser-local identity the open conversation speaks as. Resolution is
  // persisted once per conversation so a later default change cannot silently
  // recast an established chat.
  const [conversationPersonaId, setConversationPersonaId] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [importCharacterId, setImportCharacterId] = useState<string | undefined>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorCharacterId, setEditorCharacterId] = useState<string | undefined>();
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [migrationCharacterId, setMigrationCharacterId] = useState<string | undefined>();
  const [configurations, setConfigurations] = useState<ModelConfiguration[]>([]);
  const [usageMode, setUsageMode] = useState<'PLATFORM' | 'BYOK'>(
    initialModelPreference.usageMode
  );
  const [selectedConfigurationId, setSelectedConfigurationId] = useState(
    initialModelPreference.configurationId
  );
  const [error, setError] = useState<string | null>(null);
  const [, setErrorCode] = useState<string | null>(null);
  const {
    state: accountState,
    account,
    acceptAuthenticated,
    signOut
  } = useCloudAccount();
  const [loginOpen, setLoginOpen] = useState(false);
  const [cloud, setCloud] = useState<CloudStatus | null>(() => readCachedStatus());
  const [cloudChecking, setCloudChecking] = useState(true);
  // Why a generation was just refused at the service level, kept because a
  // cached or lagging `/v1/cloud/status` may still claim the models are
  // available. It stores the reason rather than a flag so a deployment that was
  // never configured is not re-told as a passing provider outage.
  const [cloudRuntimeBlock, setCloudRuntimeBlock] =
    useState<CloudBlockReason | null>(null);
  const [cloudOffline, setCloudOffline] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [analyticsReady, setAnalyticsReady] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [quickReplies, setQuickReplies] = useState<QuickReplySettings>(initialQuickReplies);
  const [replySuggestionsSettings, setReplySuggestionsSettings] =
    useState<ReplySuggestionsSettings>(initialReplySuggestions);
  const [impersonating, setImpersonating] = useState(false);
  const [typing, setTyping] = useState(false);
  const [muted, setMutedState] = useState(isMuted());
  // Relationship summary and memory count belong to the character, not the
  // conversation, so they are fetched when the profile is opened.
  const [relationship, setRelationship] = useState<string | null>(null);
  const [memoryCount, setMemoryCount] = useState<number | null>(null);
  const started = useRef(false);
  const [deviceId] = useState(() => getOrCreateDeviceId());
  const repositoryEnvironment = cloudBaseUrl() || window.location.origin;
  const repositoryPartitionRef = useRef(repositoryPartition({
    environment: repositoryEnvironment,
    principal: `guest:${deviceId}`
  }));
  const legacyCharacterMigrationAttempted = useRef(false);
  const repositoryPrincipalRef = useRef<RepositoryPrincipal>(`guest:${deviceId}`);

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
    if (!next) playClick();
  }
  const conversationIdRef = useRef<string | null>(null);
  /** The last message the server said this conversation ends at. */
  const headIdRef = useRef<string | null>(null);
  /** A send refused on a stale head, waiting for this turn to finish unwinding. */
  const resendAfterHeadRefreshRef = useRef<
    { text: string; editOfMessageId?: string } | null
  >(null);
  const activeRef = useRef<Character | null>(null);
  /**
   * Which conversation state the candidates on screen describe.
   *
   * Holding the key rather than a boolean is what lets the manual button reuse what the
   * automatic trigger already fetched, and what makes candidates for a superseded head
   * fall out of reuse on their own.
   */
  const suggestionKeyRef = useRef<string | null>(null);
  /**
   * How many attempts at the current head have already failed.
   *
   * Cloud remembers a failed request under its idempotency key and answers a replay
   * with a 409. Retrying therefore has to ask under a *new* key, or one transient
   * upstream error would disable 代写 at this point in the conversation until the
   * reader sent another message.
   */
  const suggestionAttemptRef = useRef<{ head: string; attempt: number }>({
    head: '',
    attempt: 0
  });
  /** The transcript a just-settled turn produced, when the reader wants suggestions. */
  const autoSuggestRef = useRef<Message[] | null>(null);
  const usageModeRef = useRef<'PLATFORM' | 'BYOK'>(usageMode);
  // Monotonic token for character opens: only the newest open may write state, so a
  // slow earlier request can never resurrect a contact the reader has left.
  const openTokenRef = useRef(0);
  // Multi-bubble turn playback. The controller is a stable singleton so a new turn
  // (or a tab-visibility change) can interrupt/pause the one in flight.
  const playbackRef = useRef<TurnPlaybackController | null>(null);
  const semanticPlaybackDoneRef = useRef<(() => void) | null>(null);
  const canonicalTurnFinalByActionRef = useRef(new Map<string, string>());
  const turnIdRef = useRef<string>('');
  const generationAbortRef = useRef<AbortController | null>(null);
  const streamingRef = useRef(false);

  // The latest known Cloud status, readable from callbacks that run outside render.
  const cloudRef = useRef<CloudStatus | null>(cloud);
  useEffect(() => { cloudRef.current = cloud; }, [cloud]);

  useEffect(() => { conversationIdRef.current = conversationId; }, [conversationId]);
  // Cleared whenever the conversation changes: a head id from a different
  // conversation would be refused by the server as stale, which is the right answer
  // to the wrong question.
  useEffect(() => { headIdRef.current = null; }, [conversationId]);
  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => { usageModeRef.current = usageMode; }, [usageMode]);
  useEffect(() => {
    writeModelPreference({ usageMode, configurationId: selectedConfigurationId });
  }, [selectedConfigurationId, usageMode]);

  async function adoptRepositoryPrincipal(principal: RepositoryPrincipal) {
    if (repositoryPrincipalRef.current === principal) return;
    repositoryPrincipalRef.current = principal;
    const partition = repositoryPartition({
      environment: repositoryEnvironment,
      principal
    });
    repositoryPartitionRef.current = partition;
    generationAbortRef.current?.abort();
    playbackRef.current?.interrupt();
    conversationIdRef.current = null;
    setConversationId(null);
    setMessages([]);
    setActive(null);
    const localCharacters = await chatRepository.listCharacters(partition);
    setCharacters(localCharacters);
    // The account-state effect below owns the single open for this principal. Doing
    // an offline open here and a Cloud open immediately afterwards briefly exposes a
    // stale composer, then clears it while a reader is interacting with it.
  }

  function persistMessages(conversationId: string, nextMessages: Message[]): void {
    const partition = repositoryPartitionRef.current;
    void chatRepository.replaceMessages(partition, conversationId, nextMessages);
  }

  // Published on the document root, not on a component, because the composer is not
  // the only thing that has to move out from under the keyboard — panels and sheets
  // read the same variable.
  useEffect(
    () =>
      trackKeyboardInset(
        document.documentElement,
        window.visualViewport,
        () => window.innerHeight
      ),
    []
  );

  const cloudService = resolveCloudModelServiceState(cloud, {
    checking: cloudChecking,
    offline: cloudOffline,
    runtimeBlockReason: cloudRuntimeBlock,
    selected: usageMode === 'PLATFORM'
  });
  // The one explanation of what the Cloud is doing for this account. Every
  // surface reads it, so no two block reasons can drift apart.
  const cloudNotice = resolveCloudNotice(cloud);

  function reportGenerationFailure(reason: unknown) {
    setTyping(false);
    const apiError = reason instanceof ApiError ? reason : null;
    const platformRequest = usageModeRef.current === 'PLATFORM';
    const blockReason = platformRequest ? blockReasonFor(apiError?.code) : null;
    // The refusal is recorded as server state, so every surface explains it the
    // same way a fresh status would — and no reason collapses into a generic one.
    const blockedStatus: CloudStatus | null =
      blockReason && cloudRef.current
        ? {
            ...cloudRef.current,
            platform_models_available: false,
            block_reason: blockReason
          }
        : null;
    if (blockedStatus) {
      // Concurrency is scoped to the request that raced. Publishing it as the
      // account's Cloud status would disable every later input until a manual
      // refresh, even after the request that owned the slot had already ended.
      if (blockReason !== 'CONCURRENT_GENERATION') setCloud(blockedStatus);
      // Both service-level refusals outlive the response that carried them: the
      // status endpoint may still say the models are available, and the reader
      // would otherwise be handed back a working-looking Cloud.
      if (
        blockReason === 'PROVIDER_UNAVAILABLE' ||
        blockReason === 'PLATFORM_MODELS_NOT_CONFIGURED'
      ) {
        setCloudRuntimeBlock(blockReason);
      }
    }
    const blockedNotice = resolveCloudNotice(blockedStatus);
    const message = blockedNotice
      ? blockedNotice.body
      : reason instanceof Error
        ? reason.message
        : translate().chat.sendFailed;
    setError(message);
    setErrorCode(apiError?.code ?? 'GENERATION_FAILED');
    const directCode = reason && typeof reason === 'object' && 'code' in reason
      ? String((reason as { code?: unknown }).code)
      : null;
    if (directCode === 'BYOK_DIRECT_CORS_BLOCKED') {
      analytics.track('byok_direct_cors_blocked', {
        pageName: 'chat',
        ...(activeRef.current ? { characterId: activeRef.current.character_id } : {}),
        ...(conversationIdRef.current ? { conversationId: conversationIdRef.current } : {})
      });
    }
    analytics.blockingError(
      analyticsErrorCode(apiError?.code ?? 'GENERATION_FAILED'),
      'chat',
      {
        errorStage: 'generation',
        retryable: apiError?.retryable ?? false,
        ...(apiError?.requestId ? { requestId: apiError.requestId } : {}),
        ...(activeRef.current ? { characterId: activeRef.current.character_id } : {}),
        ...(conversationIdRef.current ? { conversationId: conversationIdRef.current } : {})
      }
    );
  }

  useEffect(() => {
    const controller = new TurnPlaybackController({
      onBubble: (text, ctx) => {
        const messageId = ctx.persisted && ctx.actionId ? ctx.actionId : createId();
        setMessages((current) => [
          ...current,
          { message_id: messageId, role: 'ASSISTANT', content_text: text, status: 'COMPLETED' }
        ]);
        playClick();
      },
      onTypingChange: setTyping,
      onStateChange: (state) => setSending(state === 'GENERATING'),
      onDone: () => {
        const done = semanticPlaybackDoneRef.current;
        semanticPlaybackDoneRef.current = null;
        done?.();
      },
      onError: reportGenerationFailure
    });
    playbackRef.current = controller;
    const onVisibility = () => {
      if (document.hidden) controller.pause();
      else controller.resume();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      controller.interrupt();
    };
  }, []);

  async function openCharacter(
    character: Character,
    nextView: View = 'chat',
    trackSelection = false
  ) {
    // Abandon any in-flight turn so its bubbles never land in the new conversation.
    generationAbortRef.current?.abort();
    playbackRef.current?.interrupt();
    const token = ++openTokenRef.current;
    setTyping(false);
    // The contact header updates before the network round-trip. Clear every piece
    // of conversation-scoped state at the same boundary so the new character can
    // neither display nor accidentally submit into the previous conversation.
    conversationIdRef.current = null;
    canonicalTurnFinalByActionRef.current.clear();
    setConversationId(null);
    setMessages([]);
    // Do not publish a sendable character until its conversation belongs to the
    // current repository partition. Rendering the composer before this await chain
    // completes creates a real race: a quick reply (or a fast reader) can submit
    // while `conversationId` is still null, and the turn is silently discarded.
    // Clearing the previous character also prevents its composer from targeting the
    // conversation that is currently being rebound.
    setActive(null);
    setView(nextView);
    setError(null);
    setErrorCode(null);
    clearSuggestions();
    // The card travels with the open. LiteTavern Cloud holds no character store —
    // characters are a local asset — so without this it would have to prompt from a
    // name alone, and `scenario`, `example_messages`, `system_prompt` and
    // `post_history_instructions` would keep being fields the app parses, stores and
    // never actually uses. Cloud dedupes on the card's content hash, so re-opening
    // the same character costs a comparison rather than a write.
    let card = await fetchCharacterCard(
      repositoryPartitionRef.current,
      character.character_id
    ).catch(() => null);
    if (!card) {
      // One-time migration for a card cached by a pre-local-first deployment.
      // The 404 is intentionally ignored; new deployments never implement this route.
      card = await api<CardDetail>(`/v1/characters/${character.character_id}/card`)
        .catch(() => null);
      if (card) {
        await chatRepository.putCharacter(repositoryPartitionRef.current, {
          ...character, local_card: card
        });
      }
    }
    let created: { conversation_id: string; persona_id?: string | null };
    try {
      created = await api<{ conversation_id: string; persona_id?: string | null }>(
        '/v1/conversations',
        {
          method: 'POST',
          body: JSON.stringify({
            character_id: character.character_id,
            card: card?.normalized_data ?? {
              name: character.name,
              description: character.profile_summary,
              personality: character.personality_summary,
              first_message: character.first_message
            }
          })
        }
      );
    } catch (reason) {
      // A signed-out reader has no cloud transcript, because a transcript belongs to
      // an account. That is not an outage and must not be reported as one: they can
      // still browse their characters and read the opening line, and the sign-in
      // prompt is already the answer the shell offers. Failing the whole bootstrap
      // here would drop the app into the offline banner over a state that is simply
      // "not signed in yet".
      if (reason instanceof ApiError && reason.code === 'GUEST') {
        if (token !== openTokenRef.current) return;
        setActive(character);
        setMessages(
          character.first_message
            ? [
                {
                  message_id: `greeting-${character.character_id}`,
                  role: 'ASSISTANT',
                  content_text: character.first_message,
                  status: 'COMPLETED'
                }
              ]
            : []
        );
        return;
      }
      throw reason;
    }
    // The reader has already moved on; writing this state back would drag them
    // to a contact they left, so the response is recorded and otherwise dropped.
    const partition = repositoryPartitionRef.current;
    void chatRepository.openConversation(partition, {
      conversationId: created.conversation_id,
      characterId: character.character_id,
      source: 'CLOUD'
    });
    if (token !== openTokenRef.current) return;
    setActive(character);
    conversationIdRef.current = created.conversation_id;
    setConversationId(created.conversation_id);
    const resolvedPersona = await resolveConversationPersona(
      created.conversation_id,
      character.character_id
    );
    setConversationPersonaId(resolvedPersona?.persona_id ?? null);
    if (trackSelection) {
      analytics.criticalAction('character_selected', 'home', {
        characterId: character.character_id,
        conversationId: created.conversation_id,
        result: 'success'
      });
    }
    const loaded = await fetchMessages(created.conversation_id);
    await chatRepository.replaceMessages(
      partition,
      created.conversation_id,
      loaded
    );
    if (token !== openTokenRef.current) return;
    setMessages(loaded);
  }

  /**
   * Degraded open: LiteTavern Cloud is unreachable, so the last conversation this
   * browser read for the character is replayed from cache. Nothing is written and
   * the banner tells the user the state is stale, not lost.
   */
  async function openCharacterOffline(character: Character) {
    generationAbortRef.current?.abort();
    playbackRef.current?.interrupt();
    openTokenRef.current += 1;
    setTyping(false);
    setActive(character);
    setView('chat');
    clearSuggestions();
    setConversationPersonaId(null);
    const localConversation = await chatRepository.findConversation(
      repositoryPartitionRef.current,
      character.character_id,
      'LOCAL'
    );
    const cloudConversation = localConversation
      ? null
      : await chatRepository.findConversation(
          repositoryPartitionRef.current,
          character.character_id,
          'CLOUD'
        );
    let cachedId = localConversation?.conversationId ?? cloudConversation?.conversationId ?? null;
    let restored = cachedId
      ? await chatRepository.listMessages(repositoryPartitionRef.current, cachedId)
      : [];
    // One-time guest migration from the unpartitioned v1 cache. Account partitions
    // never read it, which prevents a signed-in reader from inheriting another
    // principal's conversation id.
    if (!cachedId && repositoryPrincipalRef.current.startsWith('guest:')) {
      cachedId = cachedConversationId(character.character_id);
      restored = cachedId ? cachedMessages(cachedId) : [];
      if (cachedId) {
        await chatRepository.openConversation(repositoryPartitionRef.current, {
          conversationId: cachedId,
          characterId: character.character_id,
          source: 'LOCAL'
        });
        await chatRepository.replaceMessages(
          repositoryPartitionRef.current,
          cachedId,
          restored
        );
      }
    }
    conversationIdRef.current = cachedId;
    setConversationId(cachedId);
    setMessages(
      restored.length > 0 || !character.first_message
        ? restored
        : [{
            message_id: `greeting-${character.character_id}`,
            role: 'ASSISTANT',
            content_text: character.first_message,
            status: 'COMPLETED'
          }]
    );
  }

  /**
   * Pulls the character-scoped state the profile shows. Failures are silent by
   * design: the profile still renders from the list data, and an outage must not
   * replace a readable page with an error.
   */
  async function loadProfileState(characterId: string) {
    try {
      const legacy = await api<{ character?: { relationship_summary?: string | null } }>(
        `/v1/characters/${characterId}`
      );
      setRelationship(legacy.character?.relationship_summary?.trim() || null);
    } catch {
      setRelationship(null);
    }
    try {
      const result = await api<{ memories: unknown[] }>(`/v1/characters/${characterId}/memories`);
      setMemoryCount(result.memories.length);
    } catch {
      setMemoryCount(null);
    }
  }

  // After an inline profile edit, re-read the character so the page shows what
  // was actually stored rather than the text that was typed.
  async function refreshActiveCharacter() {
    const local = await chatRepository.listCharacters(repositoryPartitionRef.current);
    setCharacters(local);
    const current = activeRef.current;
    if (!current) return;
    const updated = local.find((item) => item.character_id === current.character_id);
    if (updated) setActive(updated);
  }

  async function refreshCloudStatus() {
    setCloudChecking(true);
    try {
      const result = await fetchCloudStatus();
      if (result.status) setCloud(result.status);
      setCloudOffline(result.offline);
      if (result.offline) {
        analytics.track('cloud_transient_unreachable', {
          pageName: analyticsPage,
          properties: { retryable: true }
        });
      } else if (result.status?.block_reason === 'CLOUD_CONTRACT_BLOCKED') {
        analytics.track('cloud_contract_blocked', {
          pageName: analyticsPage,
          properties: { retryable: false }
        });
      }
      if (!result.offline && result.status?.platform_models_available) {
        setCloudRuntimeBlock(null);
      }
      return result.status;
    } catch {
      setCloudOffline(true);
      return null;
    } finally {
      setCloudChecking(false);
    }
  }

  // Empty-bodied messages (a failed mid-stream reply, or a character with no opening
  // line) would otherwise render as an endless "typing" bubble, so they are dropped.
  async function fetchMessages(targetConversationId: string): Promise<Message[]> {
    const response = await api<{
      messages: Message[];
      conversation?: { current_head_id?: string | null };
    }>(`/v1/conversations/${targetConversationId}/messages`);
    // Where the server says the story currently ends. Sent back on the next turn as
    // `expected_head_id`, which is what lets the server refuse a send written against
    // a conversation this tab has not seen — the second device answering a question
    // nobody asked. Recorded from the read rather than guessed from the local list,
    // because the local list is exactly the thing that might be stale.
    if (targetConversationId === conversationIdRef.current) {
      headIdRef.current = response.conversation?.current_head_id ?? null;
    }
    return response.messages.filter((message) => message.content_text.trim() !== '');
  }

  async function refreshCharacters(openCharacterId?: string) {
    const local = await chatRepository.listCharacters(repositoryPartitionRef.current);
    setCharacters(local);
    if (openCharacterId) {
      // After an import or an edit, land back on the profile that was just
      // changed so the result is visible.
      const next = local.find(
        (item) => item.character_id === openCharacterId
      );
      if (next) await openCharacter(next, active ? 'profile' : 'chat');
    }
  }

  async function deleteActiveCharacter() {
    if (!active) return;
    await chatRepository.deleteCharacter(repositoryPartitionRef.current, active.character_id);
    const local = await chatRepository.listCharacters(repositoryPartitionRef.current);
    setCharacters(local);
    const next = local[0];
    if (next) {
      await openCharacter(next);
    } else {
      setActive(null);
      setConversationId(null);
      setMessages([]);
      setView('chat');
    }
  }

  async function bootstrap() {
    void analytics.initialize({
      userId: `guest:${deviceId}`,
      anonymousId: deviceId,
      url: window.location.href,
      referrer: document.referrer,
      appVersion: '0.1.0'
    }).then(() => setAnalyticsReady(true));
    await refreshCloudStatus();
    const localConfigurations = await modelConfigurationStore.list();
    setConfigurations(localConfigurations);
    const selectedStillExists = localConfigurations.some(
      (item) => item.model_configuration_id === initialModelPreference.configurationId
    );
    if (!selectedStillExists && localConfigurations[0]) {
      setSelectedConfigurationId(localConfigurations[0].model_configuration_id);
    }
    if (initialModelPreference.usageMode === 'BYOK' && !localConfigurations.length) {
      setUsageMode('PLATFORM');
    }
  }

  /** Open the partitioned local repository without making any claim about Cloud. */
  async function bootstrapLocal() {
    let cached = await chatRepository.listCharacters(repositoryPartitionRef.current);
    if (cached.length === 0 && repositoryPrincipalRef.current.startsWith('guest:')) {
      cached = cachedCharacters();
      if (cached.length > 0) {
        await chatRepository.replaceCharacters(repositoryPartitionRef.current, cached);
      }
    }
    setCharacters(cached);
    if (cached[0]) await openCharacterOffline(cached[0]);
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // Local rendering and optional Cloud discovery are independent. A blocked or
    // slow IndexedDB operation must not prevent auth/status discovery, and a Cloud
    // failure must not prevent the local repository from opening.
    void bootstrapLocal().catch(() => undefined);
    void bootstrap().catch(() => {
      setCloudChecking(false);
      setCloudOffline(true);
    });
  }, []);

  useEffect(() => {
    if (accountState === 'restoring') return;
    if (accountState === 'authenticated' && cloudChecking) return;
    const principal: RepositoryPrincipal = accountState === 'authenticated' && account
      ? `account:${account.user_id}`
      : `guest:${deviceId}`;
    const legacyHttpMigration = accountState === 'authenticated' && !cloudOffline &&
      cloud?.capabilities.legacy_http_migration !== false;
    let cancelled = false;
    void adoptRepositoryPrincipal(principal).then(async () => {
      if (cancelled) return;
      if (accountState === 'authenticated') {
        // These compatibility reads can only belong to a signed-in Cloud account.
        // A guest has no legacy Cloud partition and must launch without probing
        // retired HTTP endpoints.
        if (legacyHttpMigration) {
          await migrateLegacyCloudAssets((input, init) =>
            fetch(cloudUrl(String(input)), init)
          ).catch(() => undefined);
          await modelConfigurationStore.migrateLegacyOnce((input, init) =>
            fetch(cloudUrl(String(input)), init)
          ).catch(() => undefined);
        }
        if (cancelled) return;
        setConfigurations(await modelConfigurationStore.list());
        const partition = repositoryPartitionRef.current;
        const replay = await flushClientTurnOutbox(
          chatRepository,
          partition,
          (conversation, body) => api(`/v1/conversations/${conversation}/client-turns`, {
            method: 'POST',
            body: JSON.stringify(body)
          })
        );
        if (replay.conflicts > 0) {
          analytics.track('sync_conflict', {
            pageName: 'chat',
            properties: { count: replay.conflicts }
          });
        }
        void reportSyncCheckpoint({
          status: replay.pending > 0 || replay.conflicts > 0 ? 'FAILED' : 'SYNCED',
          pendingCount: replay.pending + replay.conflicts,
          ...(replay.conflicts > 0 ? { errorCode: 'SYNC_CONFLICT' } : {})
        });
      }
      const local = await chatRepository.listCharacters(repositoryPartitionRef.current);
      if (cancelled) return;
      if (local.length > 0) {
        setCharacters(local);
        if (accountState === 'authenticated') await openCharacter(local[0]!);
        else if (activeRef.current?.character_id !== local[0]!.character_id) {
          await openCharacterOffline(local[0]!);
        }
      } else {
        if (accountState !== 'authenticated' || !legacyHttpMigration) return;
        // One-time compatibility read for accounts that predate sync/pull. It never
        // backs local CRUD and a missing route is ignored; new deployments hydrate
        // these entities through the versioned sync contract.
        if (legacyCharacterMigrationAttempted.current) return;
        legacyCharacterMigrationAttempted.current = true;
        try {
          const legacy = await api<{ characters: Character[] }>('/v1/characters');
          if (cancelled) return;
          await chatRepository.replaceCharacters(repositoryPartitionRef.current, legacy.characters);
          setCharacters(legacy.characters);
          if (legacy.characters[0]) {
            if (accountState === 'authenticated') await openCharacter(legacy.characters[0]);
            else if (activeRef.current?.character_id !== legacy.characters[0].character_id) {
              await openCharacterOffline(legacy.characters[0]);
            }
          }
        } catch {
          // The local partition remains a usable empty repository.
        }
      }
    }).catch(() => {
      // Auth/status restoration is optional bootstrap work. A late completion after
      // unmount (or after a principal transition) must not escape as an unhandled
      // rejection or overwrite the repository that replaced it.
    });
    return () => { cancelled = true; };
  }, [
    account?.user_id,
    accountState,
    cloud?.capabilities.legacy_http_migration,
    cloudChecking,
    cloudOffline,
    deviceId
  ]);

  // After registration / login / merge the session cookie has rotated. Adopt the new
  // account state and pull the (possibly merged) character list without disturbing the
  // conversation the user is currently reading.
  async function onAuthenticated(user: AnonymousIdentity) {
    acceptAuthenticated(user);
    setLoginOpen(false);
    await refreshCloudStatus();
  }

  // Sign out revokes only the Cloud account session. Browser-local characters,
  // cached conversations and the analytics identity have independent lifecycles.
  async function onLogout() {
    await signOut();
    await refreshCloudStatus();
  }

  useEffect(() => {
    if (view !== 'profile' || !active) return;
    void loadProfileState(active.character_id);
  }, [active?.character_id, view]);

  const analyticsPage: AnalyticsPageName = providerOpen
    ? 'model_config'
    : migrationOpen
      ? 'relationship_import'
      : importOpen
      ? 'character_import'
      : editorOpen
        ? editorCharacterId
          ? 'character_settings'
          : 'character_create'
        : !active
          ? 'home'
          : view === 'chat'
            ? 'chat'
            : view === 'profile'
              ? 'character_detail'
              : 'character_memories';

  useEffect(() => {
    if (!analyticsReady) return;
    analytics.pageView(analyticsPage, `/${analyticsPage}`, {
      entryMethod: 'navigation',
      ...(active ? { characterId: active.character_id } : {}),
      ...(conversationId ? { conversationId } : {})
    });
  }, [active, analyticsPage, analyticsReady, conversationId]);

  async function resolveByokConnection() {
    const configuration = configurations.find(
      (item) => item.model_configuration_id === selectedConfigurationId
    ) ?? configurations[0];
    if (!configuration) throw new Error(t.chat.byokMissingConfiguration);
    const key = await credentialStore.readSecret(configuration.credential_id);
    if (!key) throw new Error(t.chat.byokMissingKey);
    return { configuration, key };
  }

  function updateQuickReplies(next: QuickReplySettings) {
    setQuickReplies(next);
    writeQuickReplySettings(next);
  }

  /**
   * Drop the candidates and the state they described.
   *
   * The key has to go with them. Left behind, it would let the reuse check match a
   * head id from another conversation and skip a request that should have happened.
   */
  function clearSuggestions() {
    suggestionKeyRef.current = null;
    setSuggestions([]);
  }

  function updateReplySuggestions(next: ReplySuggestionsSettings) {
    setReplySuggestionsSettings(next);
    writeReplySuggestionsSettings(next);
  }

  /**
   * Candidates are written in the interface language, so a language change makes the
   * ones on screen wrong — chips the reader can no longer send in one tap. Dropped
   * rather than re-requested: this costs an allowance unit, and switching a setting
   * is not the reader asking for one.
   */
  useEffect(() => { clearSuggestions(); }, [locale]);

  /**
   * Ask Cloud what the *user* could say next, and show the candidates.
   *
   * One implementation behind both triggers. The manual button and the automatic
   * post-reply request differ only in who decided to call it and in how a failure is
   * reported — the request, the prompt and the candidates are identical.
   *
   * `AUTOMATIC` swallows every failure on purpose. It runs after a reply the reader has
   * already been given, and an optional helper must never be able to turn a delivered
   * turn into a visible error.
   *
   * The transcript is passed in rather than read from state: the automatic trigger runs
   * immediately after a turn lands, when the closure's `messages` is still the array
   * from before that turn.
   */
  async function requestReplySuggestions(options: {
    trigger: ReplySuggestionsTrigger;
    conversationId: string;
    transcript: Message[];
  }): Promise<void> {
    const { trigger, conversationId: targetConversationId, transcript } = options;
    const character = activeRef.current;
    if (!character || impersonating) return;
    const head = transcript.at(-1);
    if (!head) return;

    if (usageMode === 'PLATFORM' && cloudService.availability !== 'available') {
      if (trigger === 'MANUAL') setError(cloudNotice?.body ?? t.chat.cloudUnavailable);
      return;
    }

    // Cloud replays a settled key without charging again, so this is also what makes
    // pressing 代写 after the automatic trigger already ran cost nothing. Skipping the
    // round trip when the answer is already on screen is the local half of the same
    // idea.
    if (suggestionAttemptRef.current.head !== head.message_id) {
      suggestionAttemptRef.current = { head: head.message_id, attempt: 0 };
    }
    const keyFor = (attempt: number) =>
      suggestionKeyFor(targetConversationId, head.message_id, attempt, locale);
    const key = keyFor(suggestionAttemptRef.current.attempt);
    if (suggestionKeyRef.current === key && suggestions.length > 0) return;

    setImpersonating(true);
    if (trigger === 'MANUAL') setError(null);
    try {
      const scanMessages = transcript.flatMap((message) =>
        message.role === 'USER' || message.role === 'ASSISTANT'
          ? [
              {
                role:
                  message.role === 'USER'
                    ? ('USER' as const)
                    : ('ASSISTANT' as const),
                content_text: message.content_text
              }
            ]
          : []
      );
      // The reader's persona and their worldbook entries, assembled exactly as a turn
      // assembles them. Suggestions that ignored the persona would be suggestions for
      // somebody else. There is no pending text: nothing is being sent.
      const localContext = await clientContextField(
        character.character_id,
        targetConversationId,
        scanMessages,
        '',
        { activationSeed: key }
      );
      const clientContext =
        'client_context' in localContext
          ? { clientContext: localContext.client_context }
          : {};
      /**
       * Ask, and step past a key Cloud has already closed.
       *
       * Cloud stores the outcome of a key — including a failure — and answers a
       * replay of a failed one with 409. The key is derived from the conversation
       * head so a repeat press replays a *success* for free, which means a stored
       * failure would otherwise be permanent for this point in the story: the
       * in-memory attempt counter resets on reload, so the next visit rebuilds the
       * same rejected key. Spending an attempt and asking again makes it heal on its
       * own. `GENERATION_IN_PROGRESS` is excluded — that one is genuinely still
       * running, and a new key would race it rather than retry it.
       */
      const ask = async (): Promise<Awaited<ReturnType<typeof fetchReplySuggestions>>> => {
        if (usageMode === 'BYOK') {
          const connection = await resolveByokConnection();
          const answer = await streamByokGeneration({
            configuration: connection.configuration,
            apiKey: connection.key,
            character,
            transcript,
            input: `Suggest up to four short messages the user could send next. Write one per line in ${locale}.`,
            ...('clientContext' in clientContext
              ? { clientContext: clientContext.clientContext }
              : {})
          });
          return {
            suggestions: answer.split(/\r?\n/)
              .map((line) => line.replace(/^[-*\d.)\s]+/, '').trim())
              .filter(Boolean)
              .slice(0, 4)
          };
        }
        const selector = { usage_mode: 'PLATFORM' };
        try {
          return await fetchReplySuggestions(targetConversationId, selector, {
            idempotencyKey: keyFor(suggestionAttemptRef.current.attempt),
            locale,
            ...clientContext
          });
        } catch (reason) {
          const spent =
            reason instanceof ApiError &&
            reason.status === 409 &&
            reason.code !== 'GENERATION_IN_PROGRESS';
          if (!spent) throw reason;
          suggestionAttemptRef.current.attempt += 1;
          return fetchReplySuggestions(targetConversationId, selector, {
            idempotencyKey: keyFor(suggestionAttemptRef.current.attempt),
            locale,
            ...clientContext
          });
        }
      };
      const result = await ask();
      // The conversation may have moved on while this was in flight; candidates for a
      // story that has already continued are worse than none.
      if (conversationIdRef.current !== targetConversationId) return;
      if (result.quota !== undefined) {
        const quota = result.quota;
        setCloud((current) => (current ? { ...current, quota } : current));
      }
      suggestionKeyRef.current = keyFor(suggestionAttemptRef.current.attempt);
      setSuggestions(result.suggestions);
      if (trigger === 'MANUAL' && result.suggestions.length === 0) {
        setError(t.chat.impersonateEmpty);
      }
    } catch (reason) {
      // Spend this attempt so the next press asks under a fresh key. The one
      // exception is a request that is genuinely still running: a new key there
      // would race the account's own in-flight generation rather than retry it.
      if (!(reason instanceof ApiError) || reason.code !== 'GENERATION_IN_PROGRESS') {
        suggestionAttemptRef.current.attempt += 1;
      }
      if (trigger === 'MANUAL') {
        setError(reason instanceof Error ? reason.message : t.chat.impersonateFailed);
      }
    } finally {
      setImpersonating(false);
    }
  }

  function impersonate() {
    if (!conversationId || sending) return;
    void requestReplySuggestions({
      trigger: 'MANUAL',
      conversationId,
      transcript: messages
    });
  }

  async function ensureLocalConversation(character: Character): Promise<string> {
    const partition = repositoryPartitionRef.current;
    const existing = await chatRepository.findConversation(
      partition,
      character.character_id,
      'LOCAL'
    );
    const localId = existing?.conversationId ?? `local-${createId()}`;
    if (!existing) {
      await chatRepository.openConversation(partition, {
        conversationId: localId,
        characterId: character.character_id,
        source: 'LOCAL'
      });
      await chatRepository.replaceMessages(partition, localId, messages);
    }
    conversationIdRef.current = localId;
    setConversationId(localId);
    return localId;
  }

  async function queueClientTurnSync(
    targetConversationId: string,
    mutationId: string,
    baseHeadId: string | null,
    user: Message,
    assistants: Message[]
  ): Promise<void> {
    if (accountState !== 'authenticated' || targetConversationId.startsWith('local-')) return;
    const partition = repositoryPartitionRef.current;
    const record = {
      mutationId,
      conversationId: targetConversationId,
      baseHeadId,
      user: { messageId: user.message_id, contentText: user.content_text },
      assistants: assistants.map((message) => ({
        messageId: message.message_id,
        contentText: message.content_text,
        status: message.status === 'INCOMPLETE' ? ('INCOMPLETE' as const) : ('COMPLETED' as const)
      })),
      status: 'PENDING' as const,
      createdAt: new Date().toISOString()
    };
    await chatRepository.enqueueClientTurn(partition, record);
    const result = await flushClientTurnOutbox(
      chatRepository,
      partition,
      (conversation, body) => api(`/v1/conversations/${conversation}/client-turns`, {
        method: 'POST',
        body: JSON.stringify(body)
      })
    );
    if (conversationIdRef.current === targetConversationId && result.latestHeadId) {
      headIdRef.current = result.latestHeadId;
    }
    if (result.conflicts > 0) {
      analytics.track('sync_conflict', {
        pageName: 'chat',
        conversationId: targetConversationId
      });
    }
  }

  /**
   * One turn, in any of the three shapes it can take.
   *
   * - a plain send;
   * - `editOfMessageId`: re-sends an earlier user message, so that message and
   *   everything after it leaves the active branch and this turn continues from the
   *   new text;
   * - `regenerateOfMessageId`: answers the *same* user message again. No new user
   *   message is written; the server files the reply as another variant beside the
   *   one already there, which is what the swipe control then moves between.
   *
   * The turn is generated once and then played out as 1–4 bubbles by the controller;
   * sending again interrupts any bubbles not yet shown.
   */
  async function submit(
    rawText: string,
    editOfMessageId?: string,
    regenerateOfMessageId?: string,
    /** Set only by the one automatic re-send below, so it cannot re-send itself. */
    isHeadRetry = false
  ) {
    const requestedText = rawText.trim();
    const controller = playbackRef.current;
    if (!requestedText || !active || !controller) return;
    const resolvedConversationId = conversationId ?? (
      usageMode === 'BYOK' ? await ensureLocalConversation(active) : null
    );
    if (!resolvedConversationId) return;
    // Ignore repeat sends only while awaiting the model; during playback a new send
    // is allowed and interrupts the remaining bubbles.
    if (streamingRef.current || controller.getState() === 'GENERATING') return;
    // Selection, allowance and live service readiness are separate facts. A cached
    // selection never authorizes a send before the Cloud status check completes.
    if (
      usageMode === 'PLATFORM' &&
      cloudService.availability !== 'available'
    ) {
      const blocked = cloudService.availability === 'blocked';
      const code = cloudService.blockReason ?? 'CLOUD_UNAVAILABLE';
      setErrorCode(code);
      setError(
        blocked && cloudNotice ? cloudNotice.body : t.chat.cloudUnavailable
      );
      analytics.blockingError(analyticsErrorCode(code), 'chat', {
        errorStage:
          cloudService.availability === 'checking'
            ? 'service_check'
            : blocked
              ? 'block_reason'
              : 'service_availability',
        // A block is retryable only when the deployment can recover from it by
        // itself. `PLATFORM_MODELS_NOT_CONFIGURED` never can, so it must not be
        // counted alongside a passing provider outage.
        retryable: !blocked || isSelfHealing(cloudService.blockReason),
        ...(active ? { characterId: active.character_id } : {}),
        ...(conversationId ? { conversationId } : {})
      });
      return;
    }
    const turnRequestId = createId();
    // A regenerate re-answers a message that is already in the transcript, so the
    // local context is built as if that message were being sent now: history stops
    // before it, and `rawText` — its own text — plays the part the composer's text
    // plays on a send. Leaving the reply being replaced in the history would also let
    // a worldbook entry activate on words the model is about to write again.
    const regenerateIndex = regenerateOfMessageId
      ? messages.findIndex(
          (message) => message.message_id === regenerateOfMessageId
        )
      : -1;
    const anchorIndex =
      regenerateIndex >= 0
        ? messages
            .slice(0, regenerateIndex)
            .map((message) => message.role)
            .lastIndexOf('USER')
        : -1;
    const historyMessages =
      regenerateIndex >= 0 ? messages.slice(0, Math.max(anchorIndex, 0)) : messages;
    const scanMessages = historyMessages.flatMap((message) =>
      message.role === 'USER' || message.role === 'ASSISTANT'
        ? [
            {
              role:
                message.role === 'USER'
                  ? ('USER' as const)
                  : ('ASSISTANT' as const),
              content_text: message.content_text
            }
          ]
        : []
    );
    const macroMessages = scanMessages.map((message) => ({
      role:
        message.role === 'USER'
          ? ('user' as const)
          : ('assistant' as const),
      content: message.content_text
    }));
    let text = requestedText;
    let localContext: Record<string, unknown>;
    let runtimeWarning: string | null = null;
    try {
      const scripts = await regexScriptsForCharacter(active.character_id);
      const macroContext = {
        char: active.name,
        description: active.profile_summary,
        personality: active.personality_summary,
        messages: macroMessages,
        activationSeed: turnRequestId
      };
      // Not on a regenerate: that text was already processed when it was sent, and
      // it is the server's copy that will be re-answered. Running the scripts over it
      // a second time would build the context from a string that exists nowhere.
      if (!regenerateOfMessageId) {
        const inputResult = await applyRegexScriptsBounded(text, scripts, {
          placement: RegexPlacement.USER_INPUT,
          macros: macroContext,
          editing: Boolean(editOfMessageId)
        });
        text = inputResult.text.trim();
        if (!text) {
          setError(t.chat.regexRemovedInput);
          return;
        }
        if (inputResult.timedOut) {
          runtimeWarning = t.chat.regexInputTimeout;
        }
      }
      localContext = await clientContextField(
        active.character_id,
        resolvedConversationId,
        scanMessages,
        text,
        {
          activationSeed: turnRequestId,
          macroContext
        }
      );
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t.chat.localContextFailed
      );
      return;
    }
    playClick();
    const targetConversationId = resolvedConversationId;
    const baseHeadId = headIdRef.current;
    if (!editOfMessageId && !regenerateOfMessageId) setDraft('');
    clearSuggestions();
    setError(runtimeWarning);
    setErrorCode(null);
    if (
      !editOfMessageId &&
      !regenerateOfMessageId &&
      !messages.some((message) => message.role === 'USER')
    ) {
      analytics.criticalAction('first_message_submit_attempted', 'chat', {
        ...(active ? { characterId: active.character_id } : {}),
        conversationId: resolvedConversationId,
        result: 'attempted'
      });
      // The named program event: the user actually sent their first message in this
      // conversation. Counted separately from the attempt so the funnel is honest.
      analytics.track('first_message_sent', {
        pageName: 'chat',
        ...(active ? { characterId: active.character_id } : {}),
        conversationId: resolvedConversationId
      });
    }
    let byokConnection: Awaited<ReturnType<typeof resolveByokConnection>> | null = null;
    try {
      if (usageMode === 'BYOK') byokConnection = await resolveByokConnection();
    } catch (reason) {
      reportGenerationFailure(reason);
      return;
    }
    const selector: Record<string, unknown> = { usage_mode: 'PLATFORM' };
    // Canonical actions already exist in Cloud. Once every send preflight passed,
    // reveal a pending remainder before appending the new user message so the visible
    // transcript agrees with the canonical head this request answers.
    semanticPlaybackDoneRef.current = null;
    controller.finishCanonicalPlayback();
    const userMessage: Message = { message_id: createId(), role: 'USER', content_text: text, status: 'COMPLETED' };
    const optimisticMessages = (() => {
      // A regenerate writes no user message. It replaces the reply in place: the old
      // variant is dropped from the view for the duration of the turn, because two
      // answers to one message stacked on top of each other would read as the
      // character having said both.
      if (regenerateOfMessageId) {
        const target = messages.find(
          (message) => message.message_id === regenerateOfMessageId
        );
        const finalId = canonicalTurnFinalByActionRef.current.get(
          regenerateOfMessageId
        );
        return messages.filter((message) => {
          if (message.role !== 'ASSISTANT') return true;
          if (target?.turn_no !== undefined) return message.turn_no !== target.turn_no;
          return finalId
            ? canonicalTurnFinalByActionRef.current.get(message.message_id) !== finalId
            : message.message_id !== regenerateOfMessageId;
        });
      }
      const index = editOfMessageId ? messages.findIndex((message) => message.message_id === editOfMessageId) : -1;
      const kept = index >= 0 ? messages.slice(0, index) : messages;
      return [...kept, userMessage];
    })();
    setMessages(optimisticMessages);
    const payload = {
      ...selector,
      response_protocol: 'semantic_actions_v1' as const,
      // A regenerate carries no input: the message it answers is already in the
      // transcript, and sending the text again would invite the server to treat it as
      // a second send of something typed once.
      ...(regenerateOfMessageId ? {} : { input: { type: 'text', text } }),
      // The optimistic row's id travels with the send, so "one message per tap" is
      // enforced by a unique index rather than by this component's guards. A retry
      // whose first response was lost carries the same id and is refused, instead of
      // adding a second copy of something the reader typed once.
      ...(regenerateOfMessageId ? {} : { client_message_id: userMessage.message_id }),
      // Only when this tab has actually read the conversation. Sending a guess would
      // be worse than sending nothing: the server treats an absent field as "not
      // claiming to know", and a wrong claim is refused.
      ...(headIdRef.current ? { expected_head_id: headIdRef.current } : {}),
      ...localContext,
      ...(editOfMessageId ? { edit_of_message_id: editOfMessageId } : {}),
      // Whether this is a *retry* of a reply that failed or a *regenerate* of one that
      // arrived is the message's state to decide, so only the target is named here.
      ...(regenerateOfMessageId
        ? { regenerate_of_message_id: regenerateOfMessageId }
        : {}),
      ...(diagnosticsEnabled
        ? { diagnostics: { generation_trace: true } }
        : {})
    };

    // Generation has one authoritative path. A deployment without this SSE route is
    // contract-incompatible; retrying the same turn through a retired endpoint can
    // duplicate the user message and bind it to a different transcript.
    const abortController = new AbortController();
    const streamingMessageId = `stream-${turnRequestId}`;
    let streamedText = '';
    let semanticPlaybackStarted = false;
    const generationStartedAt = performance.now();
    generationAbortRef.current = abortController;
    streamingRef.current = true;
    setSending(true);
    setTyping(true);
    try {
      if (byokConnection) {
        try {
          const replyText = await streamByokGeneration({
            configuration: byokConnection.configuration,
            apiKey: byokConnection.key,
            character: active,
            transcript: historyMessages,
            input: text,
            ...('client_context' in localContext
              ? { clientContext: localContext.client_context }
              : {})
          }, {
            signal: abortController.signal,
            onDelta: (delta) => {
              streamedText += delta;
              setTyping(false);
              const streamed: Message = {
                message_id: streamingMessageId,
                role: 'ASSISTANT',
                content_text: streamedText,
                status: 'STREAMING'
              };
              setMessages([...optimisticMessages, streamed]);
            }
          });
          const assistant: Message = {
            message_id: createId(),
            role: 'ASSISTANT',
            content_text: replyText,
            status: 'COMPLETED'
          };
          const completed = [...optimisticMessages, assistant];
          setMessages(completed);
          persistMessages(targetConversationId, completed);
          if (!regenerateOfMessageId) {
            void queueClientTurnSync(
              targetConversationId, turnRequestId, baseHeadId, userMessage, [assistant]
            );
          }
          if (replySuggestionsSettings.trigger === 'AUTOMATIC') {
            void requestReplySuggestions({
              trigger: 'AUTOMATIC',
              conversationId: targetConversationId,
              transcript: completed
            });
          }
          return;
        } catch (reason) {
          const partial: Message[] = streamedText.trim()
            ? [{
                message_id: createId(), role: 'ASSISTANT',
                content_text: streamedText, status: 'INCOMPLETE'
              }]
            : [];
          const retained = [...optimisticMessages, ...partial];
          setMessages(retained);
          persistMessages(targetConversationId, retained);
          if (!regenerateOfMessageId) {
            void queueClientTurnSync(
              targetConversationId, turnRequestId, baseHeadId, userMessage, partial
            );
          }
          reportGenerationFailure(reason);
          return;
        }
      }
      const result = await streamGeneration(targetConversationId, payload, {
        signal: abortController.signal,
        idempotencyKey: turnRequestId,
        captureTrace: diagnosticsEnabled,
        onDelta: (delta) => {
          streamedText += delta;
          setTyping(false);
          setMessages((current) => {
            const existing = current.findIndex(
              (message) => message.message_id === streamingMessageId
            );
            const streamed: Message = {
              message_id: streamingMessageId,
              role: 'ASSISTANT',
              content_text: streamedText,
              status: 'STREAMING'
            };
            return existing < 0
              ? [...current, streamed]
              : current.map((message, index) =>
                  index === existing ? streamed : message
                );
          });
        }
      });
      if (result.diagnosticTrace) {
        const traceText = result.turn
          ? result.turn.actions.map((action) => action.content).join('\n')
          : streamedText;
        void withRuntimeTraceLayers(result.diagnosticTrace, traceText)
          .then(setGenerationTrace)
          .catch(() => undefined);
      }
      turnIdRef.current = result.generationRequestId ?? turnRequestId;
      // The stream reports the post-deduction allowance; whether that allowance
      // still permits another turn is the server's call, not this client's.
      if (result.quota !== undefined) {
        const quota = result.quota;
        setCloud((current) => (current ? { ...current, quota } : current));
      }
      if (result.turn) {
        semanticPlaybackStarted = true;
        turnIdRef.current = result.turn.turn_id;
        const outputScripts = await regexScriptsForCharacter(active.character_id);
        const displayActions = await Promise.all(result.turn.actions.map(async (action, index) => {
          const transformed = await applyRegexScriptsBounded(action.content, outputScripts, {
            placement: RegexPlacement.AI_OUTPUT,
            depth: index,
            macros: {
              char: active.name,
              description: active.profile_summary,
              personality: active.personality_summary,
              messages: macroMessages,
              activationSeed: turnRequestId
            }
          });
          return { ...action, content: transformed.text };
        }));
        const displayTurn = { ...result.turn, actions: displayActions };
        const displayContentById = new Map(
          displayActions.map((action) => [action.action_id, action.content])
        );
        const finalAction = displayActions.at(-1)!;
        for (const action of displayActions) {
          canonicalTurnFinalByActionRef.current.set(
            action.action_id,
            finalAction.action_id
          );
        }
        headIdRef.current = finalAction.action_id;
        // A compliant semantic response has no transient row. Removing it also
        // handles an older intermediary that emitted legacy deltas before `turn`.
        setMessages((current) => current.filter(
          (message) => message.message_id !== streamingMessageId
        ));
        semanticPlaybackDoneRef.current = () => {
          void fetchMessages(targetConversationId).then((loaded) => {
            // The same stale-branch rule as the delta protocol: a read that lacks the
            // turn just acknowledged by the stream cannot replace what the reader
            // watched arrive. Preserve local AI_OUTPUT transformations by action id
            // without running Regex a second time.
            if (!loaded.some((message) => message.message_id === finalAction.action_id)) return;
            const displayed = loaded.map((message) => {
              const content = displayContentById.get(message.message_id);
              return content === undefined ? message : { ...message, content_text: content };
            });
            persistMessages(targetConversationId, displayed);
            if (conversationIdRef.current === targetConversationId) setMessages(displayed);
            if (replySuggestionsSettings.trigger === 'AUTOMATIC') {
              void requestReplySuggestions({
                trigger: 'AUTOMATIC',
                conversationId: targetConversationId,
                transcript: displayed
              });
            }
          }).catch(() => undefined);
        };
        // The request-level typing indicator is owned by this component, while the
        // action cadence below is owned by the playback controller. Hand the state
        // over explicitly: a slow, single-action turn is displayed immediately, so
        // the controller never enters its own typing state and cannot clear ours.
        setTyping(false);
        controller.playSemanticTurn(
          displayTurn,
          performance.now() - generationStartedAt
        );
        return;
      }
      // Replace optimistic ids and the transient STREAMING row with the canonical
      // persisted branch. If this read fails, keep the complete text visible and let
      // the next open recover it from Cloud.
      try {
        const loaded = await fetchMessages(targetConversationId);
        // A server branch that does not contain this turn is not a newer view of the
        // conversation — it is a view from before it. Adopting it would erase the
        // reply the reader just watched arrive, which is exactly what the dev
        // deployment did while the transcript lived in a database nobody wrote to.
        const persisted =
          result.messageId !== undefined &&
          loaded.some((message) => message.message_id === result.messageId);
        if (conversationIdRef.current === targetConversationId && persisted) {
          persistMessages(targetConversationId, loaded);
          setMessages(loaded);
          // The reply has landed and been persisted. Only now — and only if the reader
          // asked for it — is a second, separate call made for what they could say
          // back. Deferred to the `finally` below so it starts after this turn has
          // finished unwinding rather than inside it.
          autoSuggestRef.current = loaded;
        } else {
          throw new Error('turn missing from server branch');
        }
      } catch {
        setMessages((current) => current.map((message) =>
          message.message_id === streamingMessageId
            ? {
                ...message,
                message_id: result.messageId ?? streamingMessageId,
                status: 'COMPLETED'
              }
            : message
        ));
      }
      return;
    } catch (reason) {
      const aborted = reason instanceof DOMException && reason.name === 'AbortError';
      if (aborted) {
        setMessages((current) => current.filter(
          (message) => message.message_id !== streamingMessageId
        ));
        void fetchMessages(targetConversationId).then((loaded) => {
          persistMessages(targetConversationId, loaded);
          if (conversationIdRef.current === targetConversationId) setMessages(loaded);
        }).catch(() => undefined);
        return;
      }
      const apiError = reason instanceof ApiError ? reason : null;
      if (apiError?.diagnosticTrace) {
        void withRuntimeTraceLayers(apiError.diagnosticTrace, streamedText)
          .then(setGenerationTrace)
          .catch(() => undefined);
      }

      if (apiError?.code === 'CONVERSATION_NOT_FOUND' && active) {
        try {
          await openCharacter(active, 'chat');
          setDraft(requestedText);
          setError(t.chat.conversationRebound);
          setErrorCode('CONVERSATION_REBOUND');
          analytics.track('conversation_rebound', {
            pageName: 'chat',
            characterId: active.character_id,
            conversationId: targetConversationId
          });
        } catch (rebindReason) {
          reportGenerationFailure(rebindReason);
        }
        return;
      }

      // The conversation moved while this tab was looking at an older version of it,
      // or this exact send already landed. Both are resolved by reading the server's
      // branch, which is also what refreshes the head this tab sends next.
      //
      // What happens *after* that read is where the two part company, and treating
      // them alike is what made a message disappear. `DUPLICATE_MESSAGE` means the
      // text reached Cloud, so re-sending would be the reader asking for one message
      // and getting two. `HEAD_MISMATCH` is refused *before* any write — the store
      // compares the head and returns without touching the conversation — so the
      // text reached nobody. Dropping the optimistic row then left the reader
      // looking at a composer they had already emptied, no error, and no message.
      //
      // A stale head is not rare enough to leave unhandled either: this tab only
      // learns the head from a *successful* read, so any failed turn that moved the
      // server's head guarantees the next send is refused. One upstream hiccup
      // therefore costs two messages — the one that failed and the one silently
      // swallowed behind it.
      if (apiError?.code === 'HEAD_MISMATCH' || apiError?.code === 'DUPLICATE_MESSAGE') {
        setMessages((current) => current.filter(
          (message) =>
            message.message_id !== streamingMessageId &&
            message.message_id !== userMessage.message_id
        ));
        try {
          const loaded = await fetchMessages(targetConversationId);
          persistMessages(targetConversationId, loaded);
          if (conversationIdRef.current === targetConversationId) setMessages(loaded);
          // That read is what taught this tab the current head, so the send it was
          // refused for can now be written against the story as it actually stands.
          // Queued rather than called: the guards at the top of `submit` still see
          // this turn as in flight until the `finally` below has run.
          //
          // Once only. If the head moves again between that read and the retry, the
          // reader is told rather than put in a loop that re-sends forever.
          if (
            apiError.code === 'HEAD_MISMATCH' &&
            !isHeadRetry &&
            !regenerateOfMessageId
          ) {
            resendAfterHeadRefreshRef.current = {
              text: requestedText,
              ...(editOfMessageId ? { editOfMessageId } : {})
            };
          }
        } catch {
          reportGenerationFailure(reason);
        }
        return;
      }

      reportGenerationFailure(reason);
      setMessages((current) => current.filter(
        (message) => message.message_id !== streamingMessageId
      ));
      // The reply this turn was going to replace was taken out of the view when the
      // turn started. It is still the server's answer, so put the transcript back
      // rather than leaving the reader looking at a conversation with a hole in it.
      if (regenerateOfMessageId) {
        void fetchMessages(targetConversationId).then((loaded) => {
          persistMessages(targetConversationId, loaded);
          if (conversationIdRef.current === targetConversationId) setMessages(loaded);
        }).catch(() => undefined);
      }
      return;
    } finally {
      if (generationAbortRef.current === abortController) {
        generationAbortRef.current = null;
      }
      streamingRef.current = false;
      setSending(false);
      if (!semanticPlaybackStarted) setTyping(false);

      // A send Cloud refused on a stale head, now that the head is current and the
      // guards above are clear. Taken before the automatic suggestions below and
      // made to exclude them: a turn that never happened has nothing to suggest a
      // reply to, and the resend will reach this block again when it settles.
      const resend = resendAfterHeadRefreshRef.current;
      resendAfterHeadRefreshRef.current = null;
      if (resend) {
        autoSuggestRef.current = null;
        void submit(resend.text, resend.editOfMessageId, undefined, true);
      }

      // The automatic trigger, and the only place it fires. It reads the transcript
      // captured above rather than state, which this closure still remembers from
      // before the turn. Never awaited: the reply is already on screen, and how long
      // suggestions take is not the reader's problem.
      const settled = autoSuggestRef.current;
      autoSuggestRef.current = null;
      if (settled && replySuggestionsSettings.trigger === 'AUTOMATIC') {
        void requestReplySuggestions({
          trigger: 'AUTOMATIC',
          conversationId: targetConversationId,
          transcript: settled
        });
      }
    }

  }

  /**
   * Answer the same message again, keeping the reply that is already there.
   *
   * Not an edit-and-resend of the user's message, which is what this button used to
   * do: that wrote a new user message, dropped the old exchange off the branch and
   * left nothing to swipe back to. Here the user's message stays exactly where it is
   * and the new reply is filed beside the old one as another variant.
   */
  function regenerate(assistantMessageId: string) {
    const index = messages.findIndex(
      (message) => message.message_id === assistantMessageId
    );
    if (index < 0) return;
    // The opening line answers nothing, so there is no message to re-answer. The
    // button is not offered on it; this is the guard behind that.
    const anchor = [...messages.slice(0, index)]
      .reverse()
      .find((message) => message.role === 'USER');
    if (!anchor) return;
    void submit(
      anchor.content_text,
      undefined,
      canonicalTurnFinalByActionRef.current.get(assistantMessageId) ?? assistantMessageId
    );
  }

  /**
   * Move between the replies given to the same message.
   *
   * The variant list is read at the moment of the swipe rather than cached: another
   * device may have added a reply since this transcript was loaded, and a stale list
   * would silently activate the wrong one. `direction` does not wrap — the position
   * indicator states where the ends are, and wrapping past them would make a long
   * press feel like it had lost the reader's place.
   */
  async function swipeVariant(messageId: string, direction: -1 | 1) {
    const targetConversationId = conversationIdRef.current;
    if (!targetConversationId || sending || streamingRef.current) return;
    setError(null);
    try {
      const variants = await fetchMessageVariants(targetConversationId, messageId);
      const current = variants.findIndex((variant) => variant.is_active);
      const next = current < 0 ? undefined : variants[current + direction];
      if (!next) return;
      await activateMessageVariant(targetConversationId, next.message_id);
      const loaded = await fetchMessages(targetConversationId);
          persistMessages(targetConversationId, loaded);
      if (conversationIdRef.current === targetConversationId) setMessages(loaded);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t.chat.swipeFailed);
    }
  }

  async function exportActiveCharacter() {
    if (!active) return;
    setError(null);
    try {
      const result = await buildLocalCharacterExport(
        repositoryPartitionRef.current,
        active.character_id
      );
      downloadLocalCharacterExport(result);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t.profile.exportFailed
      );
    }
  }

  function send(event: FormEvent) {
    event.preventDefault();
    void submit(draft);
  }

  function stopGeneration() {
    generationAbortRef.current?.abort();
    playbackRef.current?.interrupt();
    setSending(false);
    setTyping(false);
  }

  async function deleteUserMessage(messageId: string) {
    const targetConversationId = conversationIdRef.current;
    if (!targetConversationId || sending || !window.confirm(t.chat.deleteMessageConfirm)) return;
    setError(null);
    try {
      await api(
        `/v1/conversations/${targetConversationId}/messages/${messageId}`,
        { method: 'DELETE' }
      );
      const loaded = await fetchMessages(targetConversationId);
          persistMessages(targetConversationId, loaded);
      if (conversationIdRef.current === targetConversationId) setMessages(loaded);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t.chat.deleteMessageFailed);
    }
  }

  function openProviderSettings(
    initialSection: 'overview' | 'platform' | 'byok' = 'overview'
  ) {
    analytics.criticalAction('provider_config_started', analyticsPage, {
      ...(active ? { characterId: active.character_id } : {}),
      ...(conversationId ? { conversationId } : {}),
      result: 'attempted'
    });
    setProviderInitialSection(initialSection);
    setProviderOpen(true);
  }

  function openCharacterImport(characterId?: string) {
    analytics.criticalAction('character_import_started', analyticsPage, {
      ...(active ? { characterId: active.character_id } : {}),
      ...(conversationId ? { conversationId } : {}),
      result: 'attempted'
    });
    setImportCharacterId(characterId);
    setImportOpen(true);
  }

  function openRelationshipImport(characterId?: string) {
    analytics.criticalAction('relationship_import_started', analyticsPage, {
      ...(characterId ? { characterId } : {}),
      result: 'attempted'
    });
    setMigrationCharacterId(characterId);
    setMigrationOpen(true);
  }

  // After a migration the imported character and the freshly created conversation
  // become the active ones, so the user lands straight in the new chat.
  async function onRelationshipImported(
    result: { character_id: string; conversation_id: string },
    localCharacter?: CharacterModel
  ) {
    const partition = repositoryPartitionRef.current;
    if (localCharacter) {
      await saveLocalCharacter({
        partition,
        characterId: result.character_id,
        model: localCharacter
      });
    }
    await chatRepository.openConversation(partition, {
      conversationId: result.conversation_id,
      characterId: result.character_id,
      source: 'CLOUD'
    });
    const local = await chatRepository.listCharacters(partition);
    setCharacters(local);
    const imported = local.find((item) => item.character_id === result.character_id);
    if (!imported) return;
    playbackRef.current?.interrupt();
    setTyping(false);
    setActive(imported);
    setView('chat');
    setError(null);
    setErrorCode(null);
    clearSuggestions();
    setConversationId(result.conversation_id);
    setMessages(await fetchMessages(result.conversation_id));
  }

  function openCharacterCreate() {
    analytics.criticalAction('character_create_started', analyticsPage, {
      result: 'attempted'
    });
    setEditorCharacterId(undefined);
    setEditorOpen(true);
  }

  function openLogin() {
    analytics.criticalAction('login_started', analyticsPage, {
      ...(active ? { characterId: active.character_id } : {}),
      ...(conversationId ? { conversationId } : {}),
      result: 'attempted'
    });
    setLoginOpen(true);
  }

  const contactRail = (
    <ContactRail
      characters={characters}
      active={active}
      tone={view === 'chat' ? 'dark' : 'light'}
      onSelect={(character) => {
        // Re-selecting the open contact is a view change, not a reload: the old
        // behaviour re-created the conversation and re-bought reply suggestions
        // on every click.
        if (character.character_id === active?.character_id && conversationId) {
          setView('chat');
          return;
        }
        void openCharacter(character, 'chat', true);
      }}
      onCreate={openCharacterCreate}
    />
  );

  return (
    <main className={`hsr-app view-${view}`}>
      <div className="scene-glow scene-glow-one" />
      <div className="scene-glow scene-glow-two" />
      <TopChrome
        muted={muted}
        onToggleMute={toggleMute}
        account={account}
        syncError={cloudOffline || accountState === 'unavailable'}
        onAccount={() => setAccountOpen(true)}
        onProvider={() => openProviderSettings('overview')}
        onSettings={() => setAppSettingsOpen(true)}
        {...(view === 'memories' && active ? { title: t.chrome.memoriesTitle(active.name) } : {})}
      />

      <section className="hsr-stage">
        {cloudOffline && (
          <p className="cloud-offline-banner" role="status">
            {t.chat.offlineBanner}
          </p>
        )}
        {view === 'chat' && contactRail}
        {!active ? (
          <EmptyCharacter />
        ) : view === 'chat' ? (
          <ChatPage
            character={active} messages={messages} draft={draft} sending={sending} error={error}
            cloud={cloud} cloudService={cloudService} cloudNotice={cloudNotice}
            usageMode={usageMode} configurations={configurations} selectedConfigurationId={selectedConfigurationId}
            conversationReady={usageMode === 'BYOK' || conversationId !== null}
            suggestions={suggestions} quickReplies={quickReplies}
            typing={typing} impersonating={impersonating}
            onProfile={() => setView('profile')}
            onDraft={(value) => {
              setDraft(value);
              if (value.trim()) clearSuggestions();
            }}
            onSend={send}
            onStop={stopGeneration}
            // A 代写 candidate is a finished message, not a starting point: the
            // reader asked for something to say and picked the one they meant.
            // Parking it in the composer made them press send a second time to
            // confirm a choice they had already made. A draft they typed
            // themselves still wins — picking would silently discard it.
            onPick={(text) => {
              if (draft.trim()) return;
              void submit(text);
            }}
            onQuickReply={(text) => {
              if (draft.trim()) return;
              if (quickReplies.behavior === 'SEND') void submit(text);
              else setDraft(text);
            }}
            onImpersonate={() => void impersonate()}
            onEditSubmit={(messageId, text) => void submit(text, messageId)}
            onDeleteMessage={(messageId) => void deleteUserMessage(messageId)}
            onRegenerate={regenerate}
            onSwipe={(messageId, direction) => void swipeVariant(messageId, direction)}
            onUsageMode={(mode) => {
              setUsageMode(mode);
              if (mode === 'BYOK') {
                analytics.criticalAction('byok_selected', 'chat', { result: 'success' });
              }
            }}
            onConfiguration={setSelectedConfigurationId}
            onProvider={() => openProviderSettings('byok')}
            onPlatformQuota={() => openProviderSettings('platform')}
            onRetryCloud={() => void refreshCloudStatus()}
          />
        ) : view === 'profile' ? (
          <ProfilePage
            character={active}
            partition={repositoryPartitionRef.current}
            relationship={relationship}
            memoryCount={memoryCount}
            onChat={() => {
              analytics.criticalAction('chat_start_clicked', 'character_detail', {
                characterId: active.character_id,
                ...(conversationId ? { conversationId } : {}),
                result: 'attempted'
              });
              setView('chat');
            }}
            onMemories={() => setView('memories')}
            onPersona={() => setConversationPersonaOpen(true)}
            onWorldbooks={() => setCharacterWorldbookOpen(true)}
            onEdit={() => {
              setEditorCharacterId(active.character_id);
              setEditorOpen(true);
            }}
            onImport={() => openCharacterImport(active.character_id)}
            onExport={exportActiveCharacter}
            onDelete={deleteActiveCharacter}
            onFieldSaved={refreshActiveCharacter}
          />
        ) : (
          <MemoryPage
            character={active}
            onBack={() => setView('profile')}
            onChat={() => setView('chat')}
            onCountChange={setMemoryCount}
          />
        )}
      </section>

      <ProviderSettings
        open={providerOpen}
        onClose={() => setProviderOpen(false)}
        cloud={cloud}
        cloudService={cloudService}
        offline={cloudOffline}
        usageMode={usageMode}
        initialSection={providerInitialSection}
        onUsageMode={setUsageMode}
        onRetryCloud={() => void refreshCloudStatus()}
        onConfigurationsChanged={(next) => {
          setConfigurations(next);
          if (!selectedConfigurationId && next[0]) setSelectedConfigurationId(next[0].model_configuration_id);
        }}
      />
      <CharacterImport
        open={importOpen}
        partition={repositoryPartitionRef.current}
        {...(importCharacterId ? { replaceCharacterId: importCharacterId } : {})}
        onClose={() => {
          setImportOpen(false);
          setImportCharacterId(undefined);
        }}
        onImported={refreshCharacters}
      />
      <CharacterEditor
        open={editorOpen}
        partition={repositoryPartitionRef.current}
        {...(editorCharacterId ? { characterId: editorCharacterId } : {})}
        onClose={() => setEditorOpen(false)}
        onSaved={refreshCharacters}
      />
      <RelationshipImport
        open={migrationOpen}
        characters={characters}
        {...(migrationCharacterId ? { defaultCharacterId: migrationCharacterId } : {})}
        onClose={() => setMigrationOpen(false)}
        onImported={onRelationshipImported}
      />
      <LoginSync
        open={loginOpen}
        onClose={() => setLoginOpen(false)}
        onAuthenticated={(user) => void onAuthenticated(user)}
        turnstileSiteKey={cloud?.turnstile_site_key ?? null}
      />
      <AppSettingsPanel
        open={appSettingsOpen}
        onClose={() => setAppSettingsOpen(false)}
        onImport={() => openCharacterImport()}
        onMigrate={() => openRelationshipImport(active?.character_id)}
        onPersonas={() => {
          setAppSettingsOpen(false);
          setPersonaPanelOpen(true);
        }}
        onWorldbooks={() => {
          setAppSettingsOpen(false);
          setWorldbookPanelOpen(true);
        }}
        onFeedback={() => {
          setAppSettingsOpen(false);
          setFeedbackOpen(true);
        }}
        quickReplies={quickReplies}
        onQuickRepliesChange={updateQuickReplies}
        replySuggestions={replySuggestionsSettings}
        onReplySuggestionsChange={updateReplySuggestions}
      />
      <PersonaPanel open={personaPanelOpen} onClose={() => setPersonaPanelOpen(false)} />
      <WorldbookPanel open={worldbookPanelOpen} onClose={() => setWorldbookPanelOpen(false)} />
      <ConversationPersonaPanel
        open={conversationPersonaOpen}
        conversationId={conversationId}
        personaId={conversationPersonaId}
        onClose={() => setConversationPersonaOpen(false)}
        onBound={setConversationPersonaId}
      />
      <CharacterWorldbookPanel
        open={characterWorldbookOpen}
        characterId={active?.character_id ?? null}
        characterName={active?.name ?? t.chat.fallbackName}
        onClose={() => setCharacterWorldbookOpen(false)}
      />
      <AccountSyncPanel
        open={accountOpen}
        status={cloud}
        offline={cloudOffline}
        account={account}
        onClose={() => setAccountOpen(false)}
        onLogin={() => {
          setAccountOpen(false);
          openLogin();
        }}
        onLogout={() => {
          setAccountOpen(false);
          void onLogout();
        }}
        onConnectModel={() => {
          setAccountOpen(false);
          openProviderSettings('byok');
        }}
      />
      <ProductFeedback
        provider={
          usageMode === 'PLATFORM'
            ? 'platform'
            : configurations.find(
                (configuration) =>
                  configuration.model_configuration_id === selectedConfigurationId
              )?.provider
        }
        model={
          usageMode === 'BYOK'
            ? configurations.find(
                (configuration) =>
                  configuration.model_configuration_id === selectedConfigurationId
              )?.model_name
            : undefined
        }
        traceId={turnIdRef.current || undefined}
        open={feedbackOpen}
        onOpenChange={setFeedbackOpen}
      />
      <GenerationDiagnostics trace={generationTrace} />
    </main>
  );
}

function SmsIcon({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 28 28" fill="none" aria-hidden="true">
      <path
        d="M6 4h16a4 4 0 0 1 4 4v7a4 4 0 0 1-4 4H10.4l-4.5 3.9A.8.8 0 0 1 4.6 22.2V19H6a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4Z"
        fill="currentColor"
      />
      <g fill="#211d13">
        <circle cx="9.4" cy="11.4" r="1.55" />
        <circle cx="14" cy="11.4" r="1.55" />
        <circle cx="18.6" cy="11.4" r="1.55" />
      </g>
    </svg>
  );
}

function TopChrome({
  title,
  muted,
  onToggleMute,
  account,
  syncError,
  onAccount,
  onProvider,
  onSettings
}: {
  title?: string; muted?: boolean; onToggleMute?: () => void;
  account?: AnonymousIdentity | null; syncError?: boolean;
  onAccount: () => void; onProvider: () => void; onSettings: () => void;
}) {
  const t = useT();
  const registered = account?.registered ?? account?.identity_type === 'EMAIL';
  return (
    <header className="top-chrome">
      <div className="sms-title"><SmsIcon size={30} /><span><strong>{t.chrome.appName}</strong>{title && <small>{title}</small>}</span></div>
      <div className="chrome-actions">
        <button type="button" className="chrome-nav" onClick={onProvider} aria-label={t.chrome.modelService}>
          <KeyRound size={16} /><span className="chrome-action-label">{t.chrome.modelService}</span>
        </button>
        <button type="button" className="chrome-nav" onClick={onSettings} aria-label={t.chrome.settings}>
          <Settings size={16} /><span className="chrome-action-label">{t.chrome.settings}</span>
        </button>
        <button
          type="button"
          className={registered ? 'account-chip account-entry' : 'chrome-login account-entry'}
          onClick={onAccount}
          aria-label={registered ? t.chrome.manageAccount : t.chrome.signIn}
          title={registered ? account?.email ?? undefined : undefined}
        >
          <UserRound size={16} />
          <span className="account-email">{registered ? account?.email || t.chrome.account : t.chrome.signIn}</span>
          {syncError && <span className="sync-warning">{t.chrome.syncWarning}</span>}
        </button>
        {onToggleMute && (
          <button className="chrome-mute" onClick={onToggleMute} aria-label={muted ? t.chrome.soundOn : t.chrome.soundOff} aria-pressed={muted}>
            {muted ? <VolumeX size={22} /> : <Volume2 size={22} />}
          </button>
        )}
      </div>
    </header>
  );
}

function ContactRail({ characters, active, tone, onSelect, onCreate }: {
  characters: Character[]; active: Character | null; tone: 'dark' | 'light';
  onSelect: (character: Character) => void; onCreate: () => void;
}) {
  const t = useT();
  return (
    // `data-has-selection` states the fact the narrow layout needs instead of making
    // CSS infer it from a descendant's class name. `:has(.contact-item.selected)` read
    // the same thing, and broke silently the moment that class moved.
    <aside className={`contact-rail rail-${tone}`} data-has-selection={active ? 'true' : 'false'}>
      <div className="contact-scroll">
        {characters.map((character) => (
          <button key={character.character_id} className={`contact-item ${active?.character_id === character.character_id ? 'selected' : ''}`} onClick={() => onSelect(character)}>
            <Avatar character={character} />
            <span className="contact-copy"><strong>{character.name}</strong><small>{character.last_message || character.first_message || character.profile_summary || t.contacts.waitingMessage}</small></span>
            <ChevronRight size={24} />
          </button>
        ))}
        {!characters.length && <div className="empty-contacts"><MessageCircle size={28} /><strong>{t.contacts.emptyTitle}</strong><span>{t.contacts.emptyBody}</span></div>}
      </div>
      <div className="rail-actions">
        <button className="rail-action" onClick={onCreate}><Plus size={21} /> {t.contacts.newCharacter}</button>
      </div>
    </aside>
  );
}

function EmptyCharacter() {
  const t = useT();
  return (
    <section className="main-paper empty-paper">
      <MessageCircle size={42} />
      <h1>{t.contacts.emptyStateTitle}</h1>
      <p>{t.contacts.emptyStateBody}</p>
    </section>
  );
}

function autoGrow(element: HTMLTextAreaElement) {
  element.style.height = 'auto';
  element.style.height = `${element.scrollHeight}px`;
}

// Copy is always available; editing is held back while a reply streams so an edit
// can never race the generation it would invalidate.
function MessageActions({ text, editable = false, deletable = false, regeneratable = false, onEdit, onDelete, onRegenerate }: {
  text: string;
  editable?: boolean;
  deletable?: boolean;
  regeneratable?: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
  onRegenerate?: () => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const revert = useRef<number>(0);
  useEffect(() => () => window.clearTimeout(revert.current), []);

  async function copy() {
    if (!(await copyText(text))) return;
    setCopied(true);
    window.clearTimeout(revert.current);
    revert.current = window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="message-actions">
      <button type="button" onClick={() => void copy()} title={copied ? t.chat.copied : t.chat.copy} aria-label={copied ? t.chat.copiedMessage : t.chat.copyMessage}>
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </button>
      {editable && onEdit && (
        <button type="button" onClick={onEdit} title={t.chat.editMessage} aria-label={t.chat.editMessage}>
          <Pencil size={16} />
        </button>
      )}
      {deletable && onDelete && (
        <button type="button" onClick={onDelete} title={t.chat.deleteMessage} aria-label={t.chat.deleteMessage}>
          <Trash2 size={16} />
        </button>
      )}
      {regeneratable && onRegenerate && (
        <button type="button" onClick={onRegenerate} title={t.chat.regenerate} aria-label={t.chat.regenerate}>
          <RotateCcw size={16} />
        </button>
      )}
    </div>
  );
}

function MessageEditor({ initial, onCancel, onSubmit }: {
  initial: string; onCancel: () => void; onSubmit: (text: string) => void;
}) {
  const t = useT();
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    autoGrow(element);
    element.focus();
    element.setSelectionRange(element.value.length, element.value.length);
  }, []);

  const dirty = value.trim().length > 0;
  return (
    <div className="message-editor">
      <textarea
        ref={ref} value={value} rows={1} aria-label={t.chat.editMessageContent}
        onChange={(event) => { setValue(event.target.value); autoGrow(event.target); }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') { event.preventDefault(); onCancel(); }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            if (dirty) onSubmit(value);
          }
        }}
      />
      <div className="editor-actions">
        <button type="button" className="editor-cancel" onClick={onCancel}>{t.common.cancel}</button>
        <button type="button" className="editor-save" disabled={!dirty} onClick={() => onSubmit(value)}>{t.common.send}</button>
      </div>
    </div>
  );
}

function ChatPage({ character, messages, draft, sending, error, cloud, cloudService, cloudNotice, usageMode, configurations, selectedConfigurationId, conversationReady, suggestions, quickReplies, typing, impersonating, onProfile, onDraft, onSend, onStop, onPick, onQuickReply, onImpersonate, onEditSubmit, onDeleteMessage, onRegenerate, onSwipe, onUsageMode, onConfiguration, onProvider, onPlatformQuota, onRetryCloud }: {
  character: Character; messages: Message[]; draft: string; sending: boolean; error: string | null;
  cloud: CloudStatus | null;
  cloudService: CloudModelServiceState;
  cloudNotice: CloudNotice | null;
  usageMode: 'PLATFORM' | 'BYOK'; configurations: ModelConfiguration[]; selectedConfigurationId: string;
  conversationReady: boolean;
  suggestions: string[]; quickReplies: QuickReplySettings; typing: boolean; impersonating: boolean;
  onProfile: () => void; onDraft: (value: string) => void; onSend: (event: FormEvent) => void; onStop: () => void; onPick: (text: string) => void;
  onQuickReply: (text: string) => void; onImpersonate: () => void;
  onEditSubmit: (messageId: string, text: string) => void;
  onDeleteMessage: (messageId: string) => void;
  onRegenerate: (messageId: string) => void;
  onSwipe: (messageId: string, direction: -1 | 1) => void;
  onUsageMode: (mode: 'PLATFORM' | 'BYOK') => void; onConfiguration: (id: string) => void; onProvider: () => void;
  onPlatformQuota: () => void;
  onRetryCloud: () => void;
}) {
  const t = useT();
  const lastLine = [...messages].reverse().find((message) => message.role === 'ASSISTANT' && message.content_text.trim())?.content_text
    || character.first_message || character.profile_summary || t.chat.characterProfile;

  /**
   * The one reply that can be re-answered or swiped, if there is one.
   *
   * Both actions are offered at the end of the conversation only. Cloud refuses a
   * swipe anywhere else — choosing a variant further back would discard everything
   * after it, which is an edit wearing the costume of a navigation. Regenerating an
   * older reply is technically allowed but has the same effect, and a button that
   * silently drops the rest of the conversation is not a button worth having. The
   * opening line is excluded too: it answers nothing, so there is nothing to answer
   * again.
   */
  const lastMessage = messages[messages.length - 1];
  const answerable =
    lastMessage?.role === 'ASSISTANT' &&
    messages.some((message) => message.role === 'USER')
      ? lastMessage
      : undefined;

  const platformBlocked =
    cloudService.selected && cloudService.availability !== 'available';
  // Each block reason keeps its own words here: the mode switch is the shortest
  // surface, so it borrows the notice's title rather than a generic status.
  const platformLabel =
    cloudService.availability === 'checking'
      ? t.chat.cloudChecking
      : cloudService.availability === 'offline'
        ? t.chat.cloudUnavailableStatus
        : cloudService.availability === 'blocked'
          ? cloudNotice?.title ?? t.chat.cloudUnavailableStatus
          : 'LiteTavern Cloud';
  const serviceNoticeOwnsError =
    platformBlocked &&
    (error === t.chat.cloudUnavailable || error === cloudNotice?.body);

  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [pinned, setPinned] = useState(true);
  const pinnedRef = useRef(true);
  const lastScrollTopRef = useRef(0);
  useEffect(() => { pinnedRef.current = pinned; }, [pinned]);

  function scrollToBottom(behavior: ScrollBehavior = 'auto') {
    const el = scrollRef.current;
    if (!el) return;
    if (typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior });
    else el.scrollTop = el.scrollHeight;
  }
  // Follow new/streaming content only while the reader is at the bottom. The typing
  // placeholder counts too, so the "正在输入" bubble stays visible above the fold.
  useEffect(() => { if (pinnedRef.current) scrollToBottom('auto'); }, [messages, typing]);
  // The in-game reply options are a full-height block above the composer. When they
  // appear (or their height changes) they shrink the scroll area, so — following
  // star-rail-msg-maker's auto-follow — keep the newest message pinned to the bottom
  // whenever the reader is already there, instead of letting the options cover it.
  useEffect(() => { if (pinnedRef.current) scrollToBottom('smooth'); }, [suggestions.length]);
  // Jump to the latest when switching conversations.
  useEffect(() => {
    setPinned(true);
    setEditingId(null);
    const raf = requestAnimationFrame(() => scrollToBottom('auto'));
    return () => cancelAnimationFrame(raf);
  }, [character.character_id]);

  // Star-rail-msg-maker's rule: only an upward scroll (scrollTop shrinking) means
  // the reader deliberately left the bottom. Judging by distance-to-bottom alone
  // would mis-fire during a smooth auto-scroll or when the reply block grows and
  // briefly pushes the last message past the threshold.
  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop;
    if (top < lastScrollTopRef.current - 2) setPinned(false);
    else if (el.scrollHeight - top - el.clientHeight < 80) setPinned(true);
    lastScrollTopRef.current = top;
  }

  return (
    <section className="main-paper chat-paper">
      <button className="chat-heading" onClick={onProfile} aria-label={t.chat.openProfile(character.name)}>
        <strong>{character.name}</strong><small>{lastLine}</small>
      </button>
      <div className="chat-scroll-wrap">
        <div className="chat-messages" ref={scrollRef} onScroll={handleScroll}>
          {messages.map((message) => (message.role === 'EVENT' ? (
            <p key={message.message_id} className="chat-event" role="note">{message.content_text}</p>
          ) : (
            <div key={message.message_id} className={`hsr-message ${message.role === 'USER' ? 'from-user' : 'from-character'} ${editingId === message.message_id ? 'is-editing' : ''}`}>
              {message.role === 'ASSISTANT' && <Avatar character={character} />}
              <div className="message-body">
                {message.role === 'ASSISTANT' && <span className="message-name">{character.name}</span>}
                {editingId === message.message_id ? (
                  <MessageEditor
                    initial={message.content_text}
                    onCancel={() => setEditingId(null)}
                    onSubmit={(text) => { setEditingId(null); onEditSubmit(message.message_id, text); }}
                  />
                ) : (
                  <>
                    <div className="message-bubble">{message.content_text}</div>
                    {message.variant &&
                      message.variant.total > 1 &&
                      message.message_id === answerable?.message_id && (
                        <div className="message-swipe" role="group" aria-label={t.chat.swipeGroup}>
                          <button
                            type="button"
                            disabled={sending || message.variant.index <= 0}
                            onClick={() => onSwipe(message.message_id, -1)}
                            title={t.chat.swipePrevious}
                            aria-label={t.chat.swipePrevious}
                          >
                            <ChevronLeft size={16} />
                          </button>
                          <span aria-live="polite">
                            {t.chat.swipePosition(
                              message.variant.index + 1,
                              message.variant.total
                            )}
                          </span>
                          <button
                            type="button"
                            disabled={
                              sending ||
                              message.variant.index >= message.variant.total - 1
                            }
                            onClick={() => onSwipe(message.message_id, 1)}
                            title={t.chat.swipeNext}
                            aria-label={t.chat.swipeNext}
                          >
                            <ChevronRight size={16} />
                          </button>
                        </div>
                      )}
                    {message.content_text && (
                      <MessageActions
                        text={message.content_text}
                        editable={message.role === 'USER' && !sending}
                        deletable={message.role === 'USER' && !sending}
                        regeneratable={message.message_id === answerable?.message_id && !sending}
                        {...(message.role === 'USER' ? { onEdit: () => setEditingId(message.message_id) } : {})}
                        {...(message.role === 'USER' ? { onDelete: () => onDeleteMessage(message.message_id) } : {})}
                        {...(message.role === 'ASSISTANT' ? { onRegenerate: () => onRegenerate(message.message_id) } : {})}
                      />
                    )}
                  </>
                )}
              </div>
              {message.role === 'USER' && <span className="user-avatar"><UserRound size={26} /></span>}
            </div>
          )))}
          {typing && (
            <div className="hsr-message from-character">
              <Avatar character={character} />
              <div className="message-body">
                <span className="message-name">{character.name}</span>
                <div className="message-bubble"><span className="typing"><i /><i /><i /></span></div>
              </div>
            </div>
          )}
          {!messages.length && !typing && <div className="chat-placeholder">{t.chat.firstConversation}</div>}
          {error && !serviceNoticeOwnsError && (
            <p className="inline-error"><CircleAlert size={17} />{error}</p>
          )}
        </div>
        {!pinned && (
          <button className="scroll-bottom" aria-label={t.chat.scrollToBottom} onClick={() => scrollToBottom('smooth')}>
            <ChevronDown size={20} />
          </button>
        )}
      </div>
      <footer className="reply-area">
        {platformBlocked && (
          <div className="quota-notice" role="status">
            <span>
              {cloudService.availability === 'checking'
                ? <LoaderCircle className="spin" size={16} />
                : <CircleAlert size={16} />}
              {cloudService.availability === 'checking'
                ? t.chat.cloudChecking
                : cloudService.availability === 'blocked' && cloudNotice
                  ? cloudNotice.body
                  : t.chat.cloudUnavailable}
            </span>
            {cloudService.availability === 'blocked' && cloudNotice?.byokHint && (
              <span className="quota-notice-byok">{cloudNotice.byokHint}</span>
            )}
            {cloudService.availability !== 'checking' && (
              <div className="quota-notice-actions">
                {/* Offline is worth another look, and so are the blocks that
                    clear on their own. A deployment with no model service
                    configured gets no retry button: pressing it would only
                    reproduce the same wall. */}
                {(cloudService.availability === 'offline' ||
                  isSelfHealing(cloudService.blockReason) ||
                  cloudService.blockReason === 'CONCURRENT_GENERATION') && (
                  <button type="button" onClick={onRetryCloud}>{t.chat.retryCloud}</button>
                )}
                <button type="button" onClick={onProvider}>{t.chat.connectOwnModelAction}</button>
                {(cloudService.blockReason === 'DAILY_QUOTA_EXHAUSTED' ||
                  cloudService.blockReason === 'PERIOD_QUOTA_EXHAUSTED') && (
                  <button type="button" onClick={onPlatformQuota}>{t.chat.viewCloudQuota}</button>
                )}
              </div>
            )}
          </div>
        )}
        {suggestions.length > 0 && (
          <div className="reply-suggestions" role="group" aria-label={t.chat.quickReplies}>
            {suggestions.map((text) => (
              <button
                key={text}
                className="suggestion-chip"
                disabled={sending}
                onClick={() => {
                  if (draft.trim()) return;
                  onPick(text);
                  composerRef.current?.focus();
                }}
              >
                {text}
              </button>
            ))}
          </div>
        )}
        {quickReplies.enabled && quickReplies.replies.some((reply) => reply.enabled && reply.message.trim()) && (
          <div className="quick-reply-tray" role="group" aria-label={t.chat.configuredQuickReplies}>
            {quickReplies.replies
              .filter((reply) => reply.enabled && reply.message.trim())
              .map((reply) => (
                <button
                  type="button"
                  key={reply.id}
                  disabled={
                    sending || Boolean(draft.trim()) ||
                    (quickReplies.behavior === 'SEND' && (platformBlocked || !conversationReady))
                  }
                  title={reply.message}
                  onClick={() => {
                    onQuickReply(reply.message);
                    if (quickReplies.behavior === 'FILL') composerRef.current?.focus();
                  }}
                >
                  {reply.label || reply.message}
                </button>
              ))}
          </div>
        )}
        <div className="model-bar">
          <button
            type="button"
            className="impersonate-button"
            aria-label={t.chat.impersonate}
            title={t.chat.impersonateHint}
            disabled={
              sending || impersonating || Boolean(draft.trim()) ||
              messages.length === 0 || platformBlocked || !conversationReady
            }
            onClick={onImpersonate}
          >
            {impersonating
              ? <LoaderCircle className="spin" size={14} />
              : <Sparkles size={14} />}
            {impersonating ? t.chat.impersonating : t.chat.impersonate}
          </button>
          {/* A mode switch, not a meter — the remaining allowance lives in the
              status chip so the two never disagree. */}
          <button
            className={
              cloudService.selected && cloudService.availability === 'available'
                ? 'active'
                : ''
            }
            onClick={() => onUsageMode('PLATFORM')}
            disabled={cloudService.availability !== 'available'}
            title={
              cloudService.availability === 'available'
                ? quotaLabel(cloud)
                : platformLabel
            }
          >
            {platformLabel}
          </button>
          <button className={usageMode === 'BYOK' ? 'active' : ''} onClick={() => configurations.length ? onUsageMode('BYOK') : onProvider()}>{t.chat.ownModel}</button>
          {usageMode === 'BYOK' && configurations.length > 0 && (
            <select value={selectedConfigurationId} onChange={(event) => onConfiguration(event.target.value)}>
              {configurations.map((item) => <option value={item.model_configuration_id} key={item.model_configuration_id}>{item.display_name} · {item.model_name}</option>)}
            </select>
          )}
        </div>
        <form className="reply-composer" onSubmit={onSend}>
          <Send size={23} />
          <textarea
            ref={composerRef}
            value={draft} rows={1} placeholder={t.chat.placeholder(character.name)}
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}
          />
          <button
            type={sending ? 'button' : 'submit'}
            disabled={!sending && (!draft.trim() || platformBlocked || !conversationReady)}
            aria-label={sending ? t.chat.stopGeneration : t.chat.sendMessage}
            className={sending ? 'stop-generation' : undefined}
            onClick={sending ? onStop : undefined}
          >
            {sending ? <><Square size={16} /> {t.chat.stop}</> : t.common.send}
          </button>
        </form>
      </footer>
    </section>
  );
}

/** Inline editor for one profile field. Escape abandons, the button commits. */
function InlineField({
  label,
  hint,
  value,
  placeholder,
  rows,
  onSave,
  children
}: {
  label: string;
  hint?: string;
  value: string;
  placeholder: string;
  rows: number;
  onSave: (next: string) => Promise<void>;
  children: ReactNode;
}) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) return;
    setDraft(value);
    setError(null);
  }, [editing, value]);

  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);

  async function commit() {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft.trim());
      setEditing(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t.profile.saveFailed);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="info-block">
      <div className="info-block-head">
        <h2>{label}</h2>
        {!editing && (
          <button type="button" className="info-edit" onClick={() => setEditing(true)} aria-label={t.profile.editField(label)}>
            <Pencil size={14} />
          </button>
        )}
      </div>
      {editing ? (
        <div className="info-editor">
          <textarea
            ref={ref}
            rows={rows}
            value={draft}
            placeholder={placeholder}
            aria-label={label}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setEditing(false);
              }
            }}
          />
          {hint && <small>{hint}</small>}
          {error && <p className="inline-error">{error}</p>}
          <div className="editor-actions">
            <button type="button" className="editor-cancel" onClick={() => setEditing(false)} disabled={saving}>
              {t.common.cancel}
            </button>
            <button type="button" className="editor-save" onClick={() => void commit()} disabled={saving}>
              {saving ? t.common.saving : t.common.save}
            </button>
          </div>
        </div>
      ) : (
        children
      )}
    </section>
  );
}

function splitTraits(text: string): string[] | null {
  const parts = text
    .split(/[、,，/／·|｜;；]/)
    .map((item) => item.trim().replace(/^[「『"']+|[。.!！「』"']+$/g, '').trim())
    .filter(Boolean);
  if (parts.length >= 2 && parts.length <= 6 && parts.every((part) => part.length <= 8)) return parts;
  return null;
}

/**
 * One page per character.
 *
 * There used to be a second "角色设置" page that repeated the avatar and the
 * summary and hid 编辑角色设定 at the bottom of a list — so reaching the editor
 * meant opening a page, scrolling past what you had just read, and clicking
 * again. Editing now lives in the header, the card operations live behind the
 * overflow menu, and the fields the profile shows can be changed where they are
 * shown.
 */
function ProfilePage({
  character, partition, relationship, memoryCount, onChat, onMemories, onPersona, onWorldbooks,
  onEdit, onImport, onExport, onDelete, onFieldSaved
}: {
  character: Character;
  partition: string;
  relationship: string | null;
  memoryCount: number | null;
  onChat: () => void;
  onMemories: () => void;
  onPersona: () => void;
  onWorldbooks: () => void;
  onEdit: () => void;
  onImport: () => void;
  onExport: () => Promise<void>;
  onDelete: () => Promise<void>;
  onFieldSaved: () => Promise<void>;
}) {
  const t = useT();
  const traits = character.personality_summary ? splitTraits(character.personality_summary) : null;
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setMenuOpen(false);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuOpen]);

  async function saveField(patch: Partial<CharacterModel>) {
    await patchCharacterCard(partition, character.character_id, patch);
    await onFieldSaved();
  }

  async function confirmDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDelete();
    } catch (error) {
      setDeleteError(error instanceof Error ? error.message : t.profile.deleteFailed);
      setDeleting(false);
    }
  }

  return (
    <section className="main-paper profile-paper">
      <div className="detail-topbar">
        <button className="detail-back" onClick={onChat}><ArrowLeft size={19} /> {t.profile.backToChat}</button>
        <div className="detail-topbar-actions">
          <button className="topbar-action" onClick={onEdit}>
            <Pencil size={15} /> {t.profile.edit}
          </button>
          <div className="overflow-menu" onClick={(event) => event.stopPropagation()}>
            <button
              className="topbar-action topbar-action-icon"
              aria-label={t.profile.moreActions}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <MoreHorizontal size={17} />
            </button>
            {menuOpen && (
              <div className="overflow-items" role="menu">
                <button role="menuitem" onClick={() => { setMenuOpen(false); onImport(); }}>
                  <Upload size={15} /> {t.profile.updateFromCard}
                </button>
                <button role="menuitem" onClick={() => { setMenuOpen(false); void onExport(); }}>
                  <Download size={15} /> {t.profile.exportCard}
                </button>
                {character.is_owned && (
                  <button role="menuitem" className="overflow-danger" onClick={() => { setMenuOpen(false); setConfirming(true); }}>
                    <Trash2 size={15} /> {t.profile.deleteCharacter}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="detail-scroll">
        <div className="detail-column">
          <header className="profile-hero">
            <Avatar character={character} className="profile-avatar" />
            <div className="profile-id">
              <h1>{character.name}</h1>
              <p>{character.profile_summary || t.profile.noSummary}</p>
            </div>
          </header>

          <div className="profile-info">
            <InlineField
              label={t.profile.summary}
              value={character.profile_summary}
              placeholder={t.profile.summaryPlaceholder}
              rows={4}
              onSave={(next) => saveField({ description: next })}
            >
              <p>{character.profile_summary || t.profile.noSummary}</p>
            </InlineField>

            <InlineField
              label={t.profile.personality}
              hint={t.profile.personalityHint}
              value={character.personality_summary}
              placeholder={t.profile.personalityPlaceholder}
              rows={3}
              onSave={(next) => saveField({ personality: next })}
            >
              {traits
                ? <div className="trait-chips">{traits.map((trait) => <span key={trait}>{trait}</span>)}</div>
                : <p>{character.personality_summary || t.profile.noPersonality}</p>}
            </InlineField>

            {/* Written by the Cloud's post-turn worker, so the page says what
                produces it instead of promising something that never appears. */}
            <section className="info-block">
              <h2>{t.profile.relationship}</h2>
              {relationship ? (
                <>
                  <p>{relationship}</p>
                  <small className="info-note">{t.profile.relationshipUpdated}</small>
                </>
              ) : (
                <p className="muted">
                  {t.profile.relationshipEmpty(character.name)}
                </p>
              )}
            </section>
          </div>

          <nav className="profile-actions">
            <button onClick={onMemories} aria-label={t.profile.memories}>
              <span className="pa-icon"><Brain size={22} /></span>
              <span className="pa-copy">
                <strong>{t.profile.memories}</strong>
                <small>
                  {memoryCount === null
                    ? t.profile.memoriesHint
                    : memoryCount > 0
                      ? t.profile.memoriesCount(memoryCount, character.name)
                      : t.profile.memoriesNone}
                </small>
              </span>
              <ChevronRight size={19} />
            </button>
            <button onClick={onPersona} aria-label={t.profile.persona}>
              <span className="pa-icon"><UserRound size={22} /></span>
              <span className="pa-copy">
                <strong>{t.profile.persona}</strong>
                <small>{t.profile.personaHint}</small>
              </span>
              <ChevronRight size={19} />
            </button>
            <button onClick={onWorldbooks} aria-label={t.profile.worldbooks}>
              <span className="pa-icon"><BookOpen size={22} /></span>
              <span className="pa-copy">
                <strong>{t.profile.worldbooks}</strong>
                <small>{t.profile.worldbooksHint}</small>
              </span>
              <ChevronRight size={19} />
            </button>
          </nav>
        </div>
      </div>

      {confirming && (
        <div className="modal-backdrop" onClick={() => !deleting && setConfirming(false)}>
          <div className="confirm-dialog" onClick={(event) => event.stopPropagation()}>
            <h2>{t.profile.deleteTitle(character.name)}</h2>
            <p>{t.profile.deleteBody}</p>
            {deleteError && <p className="confirm-error">{deleteError}</p>}
            <div className="confirm-actions">
              <button className="confirm-cancel" onClick={() => setConfirming(false)} disabled={deleting}>{t.common.cancel}</button>
              <button className="confirm-delete" onClick={() => void confirmDelete()} disabled={deleting}>
                {deleting ? t.profile.deleting : t.profile.deleteCharacter}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

interface MemoryItem {
  memory_id: string;
  content: string;
  memory_kind: string;
  status?: string;
  created_by?: string;
  created_at?: string;
}

// The kinds the Cloud actually stores. The keys are its enum; the labels come
// from the dictionary, so an unrecognised kind still falls into "other" rather
// than being shown as a raw enum name, in whichever language is active.
const MEMORY_KIND_KEYS = [
  'FACT',
  'PREFERENCE',
  'EXPERIENCE',
  'COMMITMENT',
  'CORRECTION',
  'OTHER'
] as const;

function MemoryPage({ character, onBack, onChat, onCountChange }: {
  character: Character;
  onBack: () => void;
  onChat: () => void;
  onCountChange: (count: number) => void;
}) {
  const t = useT();
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<MemoryItem | null>(null);
  const memoryKinds = MEMORY_KIND_KEYS.map((key) => ({ key, ...t.memory.kinds[key] }));

  async function load() {
    setLoading(true);
    try {
      const result = await api<{ memories: MemoryItem[] }>(`/v1/characters/${character.character_id}/memories`);
      setMemories(result.memories);
      onCountChange(result.memories.length);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, [character.character_id]);

  async function remove(memory: MemoryItem) {
    await api(`/v1/memories/${memory.memory_id}`, { method: 'DELETE' });
    setPendingDelete(null);
    await load();
  }

  const grouped = memoryKinds.map((kind) => ({
    ...kind,
    items: memories.filter((memory) => (memory.memory_kind || 'OTHER') === kind.key)
  })).filter((group) => group.items.length > 0);
  const unknown = memories.filter(
    (memory) => !memoryKinds.some((kind) => kind.key === (memory.memory_kind || 'OTHER'))
  );

  return (
    <section className="main-paper memory-paper">
      <div className="detail-topbar">
        <button className="detail-back" onClick={onBack}><ArrowLeft size={19} /> {t.memory.backToProfile}</button>
        <span className="detail-title">{t.memory.title}</span>
      </div>
      <div className="detail-scroll">
        <div className="detail-column">
          <div className="memory-head">
            <div>
              <h1>{t.memory.title}</h1>
              {/* Answers the only question that matters here: what is this for? */}
              <p>{t.memory.purpose(character.name)}</p>
            </div>
            <span className="memory-count">{memories.length}</span>
          </div>

          {loading ? (
            <p className="import-state"><LoaderCircle className="spin" size={18} /> {t.memory.loading}</p>
          ) : memories.length > 0 ? (
            <>
              {[...grouped, ...(unknown.length ? [{ key: 'UNSORTED', ...t.memory.kinds.OTHER, items: unknown }] : [])].map((group) => (
                <section className="memory-group" key={group.key}>
                  <header>
                    <h2>{group.label}</h2>
                    <small>{group.blurb} · {group.items.length}</small>
                  </header>
                  <div className="memory-list">
                    {group.items.map((memory) => (
                      <article key={memory.memory_id}>
                        <div className="memory-body">
                          <p>{memory.content}</p>
                          <div className="memory-meta">
                            <span>{memory.created_by === 'USER' ? t.memory.addedByYou : t.memory.addedAutomatically}</span>
                            {memory.status === 'CANDIDATE' && <span className="memory-tag">{t.memory.unconfirmed}</span>}
                            {memory.created_at && (
                              <time>{new Date(memory.created_at).toLocaleDateString('zh-CN')}</time>
                            )}
                          </div>
                        </div>
                        <button aria-label={t.memory.deleteAria(memory.content.slice(0, 12))} onClick={() => setPendingDelete(memory)}>
                          <Trash2 size={17} />
                        </button>
                      </article>
                    ))}
                  </div>
                </section>
              ))}
            </>
          ) : (
            <div className="memory-empty">
              <span className="memory-empty-art"><Brain size={44} /></span>
              <strong>{t.memory.emptyTitle}</strong>
              <p>{t.memory.emptyBody(character.name)}</p>
              <button className="gold-button" onClick={onChat}><MessageCircle size={18} /> {t.memory.goChat}</button>
            </div>
          )}
        </div>
      </div>

      {pendingDelete && (
        <div className="modal-backdrop" onClick={() => setPendingDelete(null)}>
          <div className="confirm-dialog" onClick={(event) => event.stopPropagation()}>
            <h2>{t.memory.deleteTitle}</h2>
            <p>{t.memory.deleteBody(character.name)}</p>
            <div className="confirm-actions">
              <button className="confirm-cancel" onClick={() => setPendingDelete(null)}>{t.common.cancel}</button>
              <button className="confirm-delete" onClick={() => void remove(pendingDelete)}>{t.common.delete}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
