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
  ArrowLeft, BookOpen, Brain, Check, ChevronDown, ChevronRight, CircleAlert, Copy,
  Download, KeyRound, LoaderCircle, MessageCircle, MoreHorizontal, Pencil, Plus, Send,
  RotateCcw, Settings, Sparkles, Square,
  Trash2, Upload, UserRound, Volume2, VolumeX
} from 'lucide-react';
import { AccountSyncPanel } from './components/CloudPanel';
import { ProviderSettings } from './components/ProviderSettings';
import { AppSettingsPanel } from './components/AppSettingsPanel';
import { ProductFeedback } from './components/ProductFeedback';
import { ConversationPersonaPanel, PersonaPanel } from './components/PersonaPanel';
import { CharacterWorldbookPanel, WorldbookPanel } from './components/WorldbookPanel';
import { CharacterImport } from './components/CharacterImport';
import { CharacterEditor } from './components/CharacterEditor';
import { RelationshipImport } from './components/RelationshipImport';
import { LoginSync } from './components/LoginSync';
import { AboutPage } from './pages/AboutPage';
import { SupportPage } from './pages/SupportPage';
import {
  ApiError, api, deleteCharacter, fetchCharacterDetail, fetchReplySuggestions, generateTurn, logout, saveTurnBubble,
  streamGeneration,
  type AnonymousIdentity, type Character, type Message, type ModelConfiguration
} from './lib/api';
import { patchCharacterCard, type CharacterModel } from './lib/character-card';
import { t as translate, useT } from './lib/i18n';
import { analytics, type AnalyticsPageName } from './lib/analytics';
import {
  fetchCloudStatus,
  quotaLabel,
  readCachedStatus,
  reportSyncCheckpoint,
  resolveCloudModelServiceState,
  type CloudModelServiceState,
  type CloudStatus
} from './lib/cloud';
import {
  cacheCharacters,
  cacheConversationId,
  cacheMessages,
  cachedCharacters,
  cachedConversationId,
  cachedMessages
} from './lib/local-cache';
import { cloudUrl } from './lib/runtime-config';
import { credentialStore } from './lib/credential-store';
import { copyText } from './lib/clipboard';
import { createId } from './lib/id';
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

// 'settings' is gone: the character settings page repeated the profile and hid
// the editor at the bottom of it. Editing lives on the profile now.
type View = 'chat' | 'profile' | 'memories';

const AdminApp = lazy(() => import('./admin/AdminApp'));

function analyticsErrorCode(code: string): string {
  if (
    code === 'FREE_QUOTA_EXHAUSTED' ||
    code === 'CLOUD_QUOTA_EXHAUSTED' ||
    code === 'CLOUD_QUOTA_DAILY_LIMIT' ||
    code === 'CLOUD_BUDGET_EXHAUSTED'
  ) {
    return 'quota_exhausted';
  }
  if (code === 'PROVIDER_TIMEOUT') return 'generation_timeout';
  if (
    code === 'FREE_SERVICE_UNAVAILABLE' ||
    code === 'FREE_SERVICE_DISABLED' ||
    code === 'PROVIDER_UNAVAILABLE' ||
    code === 'PROVIDER_RATE_LIMITED'
  ) {
    return 'provider_unavailable';
  }
  return 'generation_failed';
}

function isCloudServiceFailure(code: string | undefined): boolean {
  return [
    'FREE_SERVICE_UNAVAILABLE',
    'FREE_SERVICE_DISABLED',
    'PROVIDER_UNAVAILABLE',
    // Older Cloud deployments used this for missing platform configuration.
    'CREDENTIAL_INVALID'
  ].includes(code ?? '');
}

function isCloudQuotaFailure(code: string | undefined): boolean {
  return [
    'FREE_QUOTA_EXHAUSTED',
    'CLOUD_QUOTA_EXHAUSTED',
    'CLOUD_QUOTA_DAILY_LIMIT',
    'CLOUD_BUDGET_EXHAUSTED'
  ].includes(code ?? '');
}

function avatarUrl(character: Character) {
  const version = character.version ? `?v=${character.version}` : '';
  // Avatars are served by LiteTavern Cloud, which may live on another origin.
  return cloudUrl(`/v1/characters/${character.character_id}/avatar${version}`);
}

function Avatar({ character, className = '' }: { character: Character; className?: string }) {
  const t = useT();
  return (
    <span className={`hsr-avatar ${className}`} aria-hidden="false">
      <span className="avatar-fallback">{character.name.slice(0, 1)}</span>
      <img src={avatarUrl(character)} alt={t.chat.avatarAlt(character.name)} onError={(event) => { event.currentTarget.hidden = true; }} />
    </span>
  );
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
  const t = useT();
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
  const [account, setAccount] = useState<AnonymousIdentity | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [cloud, setCloud] = useState<CloudStatus | null>(() => readCachedStatus());
  const [cloudChecking, setCloudChecking] = useState(true);
  const [cloudRuntimeUnavailable, setCloudRuntimeUnavailable] = useState(false);
  const [cloudOffline, setCloudOffline] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [analyticsReady, setAnalyticsReady] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [quickReplies, setQuickReplies] = useState<QuickReplySettings>(initialQuickReplies);
  const [impersonating, setImpersonating] = useState(false);
  const [typing, setTyping] = useState(false);
  const [muted, setMutedState] = useState(isMuted());
  // Relationship summary and memory count belong to the character, not the
  // conversation, so they are fetched when the profile is opened.
  const [relationship, setRelationship] = useState<string | null>(null);
  const [memoryCount, setMemoryCount] = useState<number | null>(null);
  const started = useRef(false);

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    setMutedState(next);
    if (!next) playClick();
  }
  const conversationIdRef = useRef<string | null>(null);
  const activeRef = useRef<Character | null>(null);
  const usageModeRef = useRef<'PLATFORM' | 'BYOK'>(usageMode);
  // Monotonic token for character opens: only the newest open may write state, so a
  // slow earlier request can never resurrect a contact the reader has left.
  const openTokenRef = useRef(0);
  // Multi-bubble turn playback. The controller is a stable singleton so a new turn
  // (or a tab-visibility change) can interrupt/pause the one in flight.
  const playbackRef = useRef<TurnPlaybackController | null>(null);
  const turnIdRef = useRef<string>('');
  const generationAbortRef = useRef<AbortController | null>(null);
  const streamingRef = useRef(false);

  useEffect(() => { conversationIdRef.current = conversationId; }, [conversationId]);
  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => { usageModeRef.current = usageMode; }, [usageMode]);
  useEffect(() => {
    writeModelPreference({ usageMode, configurationId: selectedConfigurationId });
  }, [selectedConfigurationId, usageMode]);

  const cloudService = resolveCloudModelServiceState(cloud, {
    checking: cloudChecking,
    offline: cloudOffline,
    runtimeUnavailable: cloudRuntimeUnavailable,
    selected: usageMode === 'PLATFORM'
  });

  function reportGenerationFailure(reason: unknown) {
    setTyping(false);
    const apiError = reason instanceof ApiError ? reason : null;
    const platformRequest = usageModeRef.current === 'PLATFORM';
    const serviceFailure = platformRequest && isCloudServiceFailure(apiError?.code);
    const quotaFailure = platformRequest && isCloudQuotaFailure(apiError?.code);
    if (serviceFailure) setCloudRuntimeUnavailable(true);
    if (quotaFailure) {
      setCloud((current) => current ? {
        ...current,
        model_service: { available: false, reason_code: 'QUOTA_EXHAUSTED' }
      } : current);
    }
    const message = serviceFailure
      ? translate().chat.cloudUnavailable
      : quotaFailure
        ? translate().chat.quotaExhausted
        : reason instanceof Error
          ? reason.message
          : translate().chat.sendFailed;
    setError(message);
    setErrorCode(apiError?.code ?? 'GENERATION_FAILED');
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
        const messageId = createId();
        setMessages((current) => [
          ...current,
          { message_id: messageId, role: 'ASSISTANT', content_text: text, status: 'COMPLETED' }
        ]);
        const conv = conversationIdRef.current;
        const turn = turnIdRef.current;
        // "Show one, write one" — persist the bubble the moment it appears. A retry
        // is safe because the server dedupes on this client-supplied message_id.
        if (conv && turn) {
          void saveTurnBubble(conv, turn, { message_id: messageId, text, bubble_no: ctx.sequenceNo }).catch(() => {});
        }
        playClick();
      },
      onTypingChange: setTyping,
      onStateChange: (state) => setSending(state === 'GENERATING'),
      onDone: () => {},
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
    setConversationId(null);
    setMessages([]);
    setActive(character);
    setView(nextView);
    setError(null);
    setErrorCode(null);
    setSuggestions([]);
    const created = await api<{ conversation_id: string; persona_id?: string | null }>(
      '/v1/conversations',
      { method: 'POST', body: JSON.stringify({ character_id: character.character_id }) }
    );
    // The reader has already moved on; writing this state back would drag them
    // to a contact they left, so the response is recorded and otherwise dropped.
    cacheConversationId(character.character_id, created.conversation_id);
    if (token !== openTokenRef.current) return;
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
    cacheMessages(created.conversation_id, loaded);
    if (token !== openTokenRef.current) return;
    setMessages(loaded);
  }

  /**
   * Degraded open: LiteTavern Cloud is unreachable, so the last conversation this
   * browser read for the character is replayed from cache. Nothing is written and
   * the banner tells the user the state is stale, not lost.
   */
  function openCharacterOffline(character: Character) {
    generationAbortRef.current?.abort();
    playbackRef.current?.interrupt();
    openTokenRef.current += 1;
    setTyping(false);
    setActive(character);
    setView('chat');
    setSuggestions([]);
    setConversationPersonaId(null);
    const cachedId = cachedConversationId(character.character_id);
    conversationIdRef.current = cachedId;
    setConversationId(cachedId);
    setMessages(cachedId ? cachedMessages(cachedId) : []);
  }

  /**
   * Pulls the character-scoped state the profile shows. Failures are silent by
   * design: the profile still renders from the list data, and an outage must not
   * replace a readable page with an error.
   */
  async function loadProfileState(characterId: string) {
    try {
      const detail = await fetchCharacterDetail(characterId);
      setRelationship(detail.relationship_summary?.trim() || null);
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
    const response = await api<{ characters: Character[] }>('/v1/characters');
    setCharacters(response.characters);
    cacheCharacters(response.characters);
    const current = activeRef.current;
    if (!current) return;
    const updated = response.characters.find((item) => item.character_id === current.character_id);
    if (updated) setActive(updated);
  }

  async function refreshCloudStatus() {
    setCloudChecking(true);
    try {
      const result = await fetchCloudStatus();
      if (result.status) setCloud(result.status);
      setCloudOffline(result.offline);
      if (!result.offline && result.status?.model_service?.available) {
        setCloudRuntimeUnavailable(false);
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
    const response = await api<{ messages: Message[] }>(`/v1/conversations/${targetConversationId}/messages`);
    return response.messages.filter((message) => message.content_text.trim() !== '');
  }

  async function refreshCharacters(openCharacterId?: string) {
    const response = await api<{ characters: Character[] }>('/v1/characters');
    setCharacters(response.characters);
    if (openCharacterId) {
      // After an import or an edit, land back on the profile that was just
      // changed so the result is visible.
      const next = response.characters.find(
        (item) => item.character_id === openCharacterId
      );
      if (next) await openCharacter(next, active ? 'profile' : 'chat');
    }
  }

  async function deleteActiveCharacter() {
    if (!active) return;
    await deleteCharacter(active.character_id);
    const response = await api<{ characters: Character[] }>('/v1/characters');
    setCharacters(response.characters);
    const next = response.characters[0];
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
    const identityResponse = await api<{ user?: AnonymousIdentity }>(
      '/v1/identities/anonymous',
      { method: 'POST' }
    );
    if (identityResponse.user?.anonymous_id) {
      setAccount(identityResponse.user);
      await analytics.initialize({
        userId: identityResponse.user.user_id,
        anonymousId: identityResponse.user.anonymous_id,
        url: window.location.href,
        referrer: document.referrer,
        appVersion: '0.1.0'
      });
      setAnalyticsReady(true);
    }
    await refreshCloudStatus();
    await migrateLegacyCloudAssets((input, init) =>
      fetch(cloudUrl(String(input)), init)
    ).catch(() => {
      // The migration marker is intentionally not written on failure. A later
      // startup can retry without duplicating already-local assets. Run this
      // after the status refresh so local migration cannot delay Cloud state
      // that is already visible in the shell.
    });
    const [characterResponse, configurationResponse] = await Promise.all([
      api<{ characters: Character[] }>('/v1/characters'),
      api<{ configurations: ModelConfiguration[] }>('/v1/model-configurations')
    ]);
    setCharacters(characterResponse.characters);
    cacheCharacters(characterResponse.characters);
    setConfigurations(configurationResponse.configurations);
    const selectedStillExists = configurationResponse.configurations.some(
      (item) => item.model_configuration_id === initialModelPreference.configurationId
    );
    if (!selectedStillExists && configurationResponse.configurations[0]) {
      setSelectedConfigurationId(configurationResponse.configurations[0].model_configuration_id);
    }
    if (initialModelPreference.usageMode === 'BYOK' && !configurationResponse.configurations.length) {
      setUsageMode('PLATFORM');
    }
    if (characterResponse.characters[0]) await openCharacter(characterResponse.characters[0]);
    void reportSyncCheckpoint({ status: 'SYNCED', clientRevision: Date.now() });
  }

  /**
   * LiteTavern Cloud is unreachable at startup. Rather than showing an empty app (or
   * claiming the data is gone), fall back to the cached contact list and mark the
   * session offline; BYOK and every local view keep working.
   */
  function bootstrapOffline() {
    const cached = cachedCharacters();
    setCloudChecking(false);
    setCloudOffline(true);
    setCharacters(cached);
    if (cached[0]) openCharacterOffline(cached[0]);
    void reportSyncCheckpoint({ status: 'FAILED', errorCode: 'CLOUD_UNREACHABLE' });
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    // The offline banner already states the situation; adding an inline error would
    // say the same thing twice and read as two separate problems.
    void bootstrap().catch(() => bootstrapOffline());
  }, []);

  // After registration / login / merge the session cookie has rotated. Adopt the new
  // account state and pull the (possibly merged) character list without disturbing the
  // conversation the user is currently reading.
  async function onAuthenticated(user: AnonymousIdentity) {
    setAccount(user);
    setLoginOpen(false);
    await refreshCloudStatus();
    const response = await api<{ characters: Character[] }>('/v1/characters');
    setCharacters(response.characters);
    cacheCharacters(response.characters);
  }

  // Sign out: revoke this device's session, then start a brand-new anonymous identity
  // rather than reusing the account just left.
  async function onLogout() {
    await logout();
    playbackRef.current?.interrupt();
    const identityResponse = await api<{ user?: AnonymousIdentity }>(
      '/v1/identities/anonymous',
      { method: 'POST' }
    );
    if (identityResponse.user) {
      setAccount(identityResponse.user);
    }
    setActive(null);
    setConversationId(null);
    setMessages([]);
    setView('chat');
    await refreshCloudStatus();
    const response = await api<{ characters: Character[] }>('/v1/characters');
    setCharacters(response.characters);
    cacheCharacters(response.characters);
    if (response.characters[0]) await openCharacter(response.characters[0]);
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

  // Resolve the model selector used by the single model call for a turn.
  async function resolveModelSelector(): Promise<Record<string, unknown>> {
    if (usageMode !== 'BYOK') return { usage_mode: 'PLATFORM' };
    const configuration = configurations.find((item) => item.model_configuration_id === selectedConfigurationId);
    if (!configuration) throw new Error(t.chat.byokMissingConfiguration);
    const key = await credentialStore.readSecret(configuration.credential_id);
    if (!key) throw new Error(t.chat.byokMissingKey);
    return {
      usage_mode: 'BYOK',
      model_configuration_id: configuration.model_configuration_id,
      credential: { credential_id: configuration.credential_id, api_key: key }
    };
  }

  function updateQuickReplies(next: QuickReplySettings) {
    setQuickReplies(next);
    writeQuickReplySettings(next);
  }

  async function impersonate() {
    if (!conversationId || !active || draft.trim() || sending || impersonating) return;
    if (usageMode === 'PLATFORM' && cloudService.availability !== 'available') {
      setError(
        cloudService.availability === 'quota_exhausted'
          ? t.chat.quotaExhausted
          : t.chat.cloudUnavailable
      );
      return;
    }
    setImpersonating(true);
    setError(null);
    try {
      const selector = await resolveModelSelector();
      const candidates = suggestions.length
        ? suggestions
        : await fetchReplySuggestions(conversationId, selector);
      const candidate = candidates.find((text) => text.trim())?.trim();
      if (!candidate) throw new Error(t.chat.impersonateEmpty);
      setDraft(candidate);
      setSuggestions([]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t.chat.impersonateFailed);
    } finally {
      setImpersonating(false);
    }
  }

  // `editOfMessageId` re-sends an earlier user message: that message and everything
  // after it leaves the active branch, and this turn continues from the new text.
  // The turn is generated once and then played out as 1–4 bubbles by the controller;
  // sending again interrupts any bubbles not yet shown.
  async function submit(rawText: string, editOfMessageId?: string) {
    const requestedText = rawText.trim();
    const controller = playbackRef.current;
    if (!requestedText || !conversationId || !active || !controller) return;
    // Ignore repeat sends only while awaiting the model; during playback a new send
    // is allowed and interrupts the remaining bubbles.
    if (streamingRef.current || controller.getState() === 'GENERATING') return;
    // Selection, allowance and live service readiness are separate facts. A cached
    // selection never authorizes a send before the Cloud status check completes.
    if (
      usageMode === 'PLATFORM' &&
      cloudService.availability !== 'available'
    ) {
      const exhausted = cloudService.availability === 'quota_exhausted';
      const code = exhausted
        ? 'FREE_QUOTA_EXHAUSTED'
        : 'FREE_SERVICE_DISABLED';
      setErrorCode(code);
      setError(exhausted ? t.chat.quotaExhausted : t.chat.cloudUnavailable);
      analytics.blockingError(analyticsErrorCode(code), 'chat', {
        errorStage:
          cloudService.availability === 'checking'
            ? 'service_check'
            : exhausted
              ? 'quota_check'
              : 'service_availability',
        retryable: !exhausted,
        ...(active ? { characterId: active.character_id } : {}),
        ...(conversationId ? { conversationId } : {})
      });
      return;
    }
    const turnRequestId = createId();
    const scanMessages = messages.flatMap((message) =>
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
      localContext = await clientContextField(
        active.character_id,
        conversationId,
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
    const targetConversationId = conversationId;
    if (!editOfMessageId) setDraft('');
    setSuggestions([]);
    setError(runtimeWarning);
    setErrorCode(null);
    if (
      !editOfMessageId &&
      !messages.some((message) => message.role === 'USER')
    ) {
      analytics.criticalAction('first_message_submit_attempted', 'chat', {
        ...(active ? { characterId: active.character_id } : {}),
        ...(conversationId ? { conversationId } : {}),
        result: 'attempted'
      });
      // The named program event: the user actually sent their first message in this
      // conversation. Counted separately from the attempt so the funnel is honest.
      analytics.track('first_message_sent', {
        pageName: 'chat',
        ...(active ? { characterId: active.character_id } : {}),
        ...(conversationId ? { conversationId } : {})
      });
    }
    let selector: Record<string, unknown>;
    try {
      selector = await resolveModelSelector();
    } catch (reason) {
      reportGenerationFailure(reason);
      return;
    }
    const userMessage: Message = { message_id: createId(), role: 'USER', content_text: text, status: 'COMPLETED' };
    setMessages((current) => {
      const index = editOfMessageId ? current.findIndex((message) => message.message_id === editOfMessageId) : -1;
      const kept = index >= 0 ? current.slice(0, index) : current;
      return [...kept, userMessage];
    });
    const payload = {
      ...selector,
      input: { type: 'text', text },
      ...localContext,
      ...(editOfMessageId ? { edit_of_message_id: editOfMessageId } : {})
    };

    // Current deployments expose the real SSE route. Keep the legacy structured
    // turn endpoint only as a compatibility fallback for an older Cloud that has no
    // SSE route at all; once a stream starts, this request is never retried elsewhere.
    const abortController = new AbortController();
    const streamingMessageId = `stream-${turnRequestId}`;
    let streamedText = '';
    let streamStarted = false;
    generationAbortRef.current = abortController;
    streamingRef.current = true;
    setSending(true);
    setTyping(true);
    try {
      const result = await streamGeneration(targetConversationId, payload, {
        signal: abortController.signal,
        idempotencyKey: turnRequestId,
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
      streamStarted = true;
      turnIdRef.current = result.generationRequestId ?? turnRequestId;
      if (result.freeQuotaRemaining !== undefined) {
        const remaining = result.freeQuotaRemaining;
        setCloud((current) => current ? {
          ...current,
          quota: {
            ...current.quota,
            available: remaining,
            remaining_ratio: current.quota.total > 0
              ? remaining / current.quota.total
              : 0
          },
          ...(remaining === 0 ? {
            model_service: {
              available: false,
              reason_code: 'QUOTA_EXHAUSTED' as const
            }
          } : {})
        } : current);
      }
      // Replace optimistic ids and the transient STREAMING row with the canonical
      // persisted branch. If this read fails, keep the complete text visible and let
      // the next open recover it from Cloud.
      try {
        const loaded = await fetchMessages(targetConversationId);
        cacheMessages(targetConversationId, loaded);
        if (conversationIdRef.current === targetConversationId) setMessages(loaded);
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
          cacheMessages(targetConversationId, loaded);
          if (conversationIdRef.current === targetConversationId) setMessages(loaded);
        }).catch(() => undefined);
        return;
      }
      const apiError = reason instanceof ApiError ? reason : null;
      const legacyEndpoint =
        !streamedText && [404, 405, 501].includes(apiError?.status ?? 0);
      if (!legacyEndpoint) {
        reportGenerationFailure(reason);
        setMessages((current) => current.filter(
          (message) => message.message_id !== streamingMessageId
        ));
        return;
      }
    } finally {
      if (generationAbortRef.current === abortController) {
        generationAbortRef.current = null;
      }
      streamingRef.current = false;
      setSending(false);
      setTyping(false);
    }

    if (streamStarted) return;

    // startTurn bumps the controller's version, so an earlier turn's pending bubbles
    // are abandoned (already-shown ones stay). The model call happens inside generate,
    // letting the controller fold its latency into the first bubble's lead time.
    await controller.startTurn(async () => {
      const plan = await generateTurn(
        targetConversationId,
        payload,
        turnRequestId
      );
      turnIdRef.current = plan.turn_id;
      if (plan.free_quota_remaining !== undefined) {
        const remaining = plan.free_quota_remaining;
        setCloud((current) =>
          current
            ? {
                ...current,
                quota: {
                  ...current.quota,
                  available: remaining,
                  remaining_ratio:
                    current.quota.total > 0
                      ? remaining / current.quota.total
                      : 0
                },
                ...(remaining === 0
                  ? {
                      model_service: {
                        available: false,
                        reason_code: 'QUOTA_EXHAUSTED' as const
                      }
                    }
                  : {})
              }
            : current
        );
      }
      // The reply carries the post-deduction quota, so the badge stays honest
      // without an extra round trip.
      if (plan.cloud_quota) {
        setCloud((current) =>
          current ? { ...current, quota: { ...current.quota, ...plan.cloud_quota } } : current
        );
      }
      setSuggestions(plan.suggestions?.slice(0, 3) ?? []);
      const scripts = await regexScriptsForCharacter(active.character_id);
      const processedMessages: string[] = [];
      for (const [index, assistantText] of plan.messages.entries()) {
        const result = await applyRegexScriptsBounded(
          assistantText,
          scripts,
          {
            placement: RegexPlacement.AI_OUTPUT,
            depth: index,
            macros: {
              char: active.name,
              description: active.profile_summary,
              personality: active.personality_summary,
              messages: [
                ...macroMessages,
                { role: 'user', content: text },
                ...processedMessages.map((content) => ({
                  role: 'assistant' as const,
                  content
                }))
              ],
              activationSeed: turnRequestId
            }
          }
        );
        if (result.timedOut) {
          setError(t.chat.regexOutputTimeout);
        }
        processedMessages.push(result.text);
      }
      return processedMessages;
    });
  }

  async function exportActiveCharacter() {
    if (!active) return;
    setError(null);
    try {
      const result = await buildLocalCharacterExport(active.character_id);
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
      cacheMessages(targetConversationId, loaded);
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
  async function onRelationshipImported(result: { character_id: string; conversation_id: string }) {
    const response = await api<{ characters: Character[] }>('/v1/characters');
    setCharacters(response.characters);
    const imported = response.characters.find((item) => item.character_id === result.character_id);
    if (!imported) return;
    playbackRef.current?.interrupt();
    setTyping(false);
    setActive(imported);
    setView('chat');
    setError(null);
    setErrorCode(null);
    setSuggestions([]);
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
        syncError={cloudOffline}
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
            cloud={cloud} cloudService={cloudService}
            usageMode={usageMode} configurations={configurations} selectedConfigurationId={selectedConfigurationId}
            suggestions={suggestions} quickReplies={quickReplies}
            typing={typing} impersonating={impersonating}
            onProfile={() => setView('profile')}
            onDraft={(value) => {
              setDraft(value);
              if (value.trim()) setSuggestions([]);
            }}
            onSend={send}
            onStop={stopGeneration}
            onPick={(text) => {
              if (!draft.trim()) setDraft(text);
            }}
            onQuickReply={(text) => {
              if (draft.trim()) return;
              if (quickReplies.behavior === 'SEND') void submit(text);
              else setDraft(text);
            }}
            onImpersonate={() => void impersonate()}
            onEditSubmit={(messageId, text) => void submit(text, messageId)}
            onDeleteMessage={(messageId) => void deleteUserMessage(messageId)}
            onRegenerate={(assistantMessageId) => {
              const assistantIndex = messages.findIndex(
                (message) => message.message_id === assistantMessageId
              );
              const previousUser = messages
                .slice(0, assistantIndex)
                .reverse()
                .find((message) => message.role === 'USER');
              if (previousUser) {
                void submit(previousUser.content_text, previousUser.message_id);
              }
            }}
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
        {...(importCharacterId ? { replaceCharacterId: importCharacterId } : {})}
        onClose={() => {
          setImportOpen(false);
          setImportCharacterId(undefined);
        }}
        onImported={refreshCharacters}
      />
      <CharacterEditor
        open={editorOpen}
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
        onStatusChanged={setCloud}
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
    <aside className={`contact-rail rail-${tone}`}>
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

function ChatPage({ character, messages, draft, sending, error, cloud, cloudService, usageMode, configurations, selectedConfigurationId, suggestions, quickReplies, typing, impersonating, onProfile, onDraft, onSend, onStop, onPick, onQuickReply, onImpersonate, onEditSubmit, onDeleteMessage, onRegenerate, onUsageMode, onConfiguration, onProvider, onPlatformQuota, onRetryCloud }: {
  character: Character; messages: Message[]; draft: string; sending: boolean; error: string | null;
  cloud: CloudStatus | null;
  cloudService: CloudModelServiceState;
  usageMode: 'PLATFORM' | 'BYOK'; configurations: ModelConfiguration[]; selectedConfigurationId: string;
  suggestions: string[]; quickReplies: QuickReplySettings; typing: boolean; impersonating: boolean;
  onProfile: () => void; onDraft: (value: string) => void; onSend: (event: FormEvent) => void; onStop: () => void; onPick: (text: string) => void;
  onQuickReply: (text: string) => void; onImpersonate: () => void;
  onEditSubmit: (messageId: string, text: string) => void;
  onDeleteMessage: (messageId: string) => void;
  onRegenerate: (messageId: string) => void;
  onUsageMode: (mode: 'PLATFORM' | 'BYOK') => void; onConfiguration: (id: string) => void; onProvider: () => void;
  onPlatformQuota: () => void;
  onRetryCloud: () => void;
}) {
  const t = useT();
  const lastLine = [...messages].reverse().find((message) => message.role === 'ASSISTANT' && message.content_text.trim())?.content_text
    || character.first_message || character.profile_summary || t.chat.characterProfile;

  const platformBlocked =
    cloudService.selected && cloudService.availability !== 'available';
  const platformLabel =
    cloudService.availability === 'checking'
      ? t.chat.cloudChecking
      : cloudService.availability === 'unavailable'
        ? t.chat.cloudUnavailableStatus
        : cloudService.availability === 'quota_exhausted'
          ? t.chat.cloudQuotaExhaustedStatus
          : 'LiteTavern Cloud';
  const serviceNoticeOwnsError =
    platformBlocked &&
    (error === t.chat.cloudUnavailable || error === t.chat.quotaExhausted);

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
                    {message.content_text && (
                      <MessageActions
                        text={message.content_text}
                        editable={message.role === 'USER' && !sending}
                        deletable={message.role === 'USER' && !sending}
                        regeneratable={message.role === 'ASSISTANT' && !sending}
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
                : cloudService.availability === 'quota_exhausted'
                  ? t.chat.quotaExhausted
                  : t.chat.cloudUnavailable}
            </span>
            {cloudService.availability !== 'checking' && (
              <div className="quota-notice-actions">
                {cloudService.availability === 'unavailable' && (
                  <button type="button" onClick={onRetryCloud}>{t.chat.retryCloud}</button>
                )}
                <button type="button" onClick={onProvider}>{t.chat.connectOwnModelAction}</button>
                {cloudService.availability === 'quota_exhausted' && (
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
                    (quickReplies.behavior === 'SEND' && platformBlocked)
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
              messages.length === 0 || platformBlocked
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
            disabled={!sending && (!draft.trim() || platformBlocked)}
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
  character, relationship, memoryCount, onChat, onMemories, onPersona, onWorldbooks,
  onEdit, onImport, onExport, onDelete, onFieldSaved
}: {
  character: Character;
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
    await patchCharacterCard(character.character_id, patch);
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
