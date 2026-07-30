import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowLeft, Brain, Check, ChevronDown, ChevronRight, CircleAlert, Copy, Download,
  KeyRound, LoaderCircle, MessageCircle, MoreHorizontal, Pencil, Plus, Send, Settings,
  Trash2, Upload, UserRound, Volume2, VolumeX
} from 'lucide-react';
import { AccountSyncPanel } from './components/CloudPanel';
import { ProviderSettings } from './components/ProviderSettings';
import { AppSettingsPanel } from './components/AppSettingsPanel';
import { CharacterImport } from './components/CharacterImport';
import { CharacterEditor } from './components/CharacterEditor';
import { RelationshipImport } from './components/RelationshipImport';
import { LoginSync } from './components/LoginSync';
import { AboutPage } from './pages/AboutPage';
import { SupportPage } from './pages/SupportPage';
import {
  ApiError, api, deleteCharacter, fetchCharacterDetail, generateTurn, logout, saveTurnBubble,
  type AnonymousIdentity, type Character, type Message, type ModelConfiguration
} from './lib/api';
import { patchCharacterCard, type CharacterModel } from './lib/character-card';
import { analytics, type AnalyticsPageName } from './lib/analytics';
import {
  fetchCloudStatus,
  quotaLabel,
  readCachedStatus,
  reportSyncCheckpoint,
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

// 'settings' is gone: the character settings page repeated the profile and hid
// the editor at the bottom of it. Editing lives on the profile now.
type View = 'chat' | 'profile' | 'memories';

/**
 * Reply suggestions are a paid model call, so they are never issued on the raw
 * click. A reader flicking through contacts settles within a few hundred
 * milliseconds; only the conversation they land on is worth spending on.
 */
const SUGGESTION_DEBOUNCE_MS = 350;

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

function avatarUrl(character: Character) {
  const version = character.version ? `?v=${character.version}` : '';
  // Avatars are served by LiteTavern Cloud, which may live on another origin.
  return cloudUrl(`/v1/characters/${character.character_id}/avatar${version}`);
}

function Avatar({ character, className = '' }: { character: Character; className?: string }) {
  return (
    <span className={`hsr-avatar ${className}`} aria-hidden="false">
      <span className="avatar-fallback">{character.name.slice(0, 1)}</span>
      <img src={avatarUrl(character)} alt={`${character.name}头像`} onError={(event) => { event.currentTarget.hidden = true; }} />
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
  return <ProductApp />;
}

function ProductApp() {
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
  const [importOpen, setImportOpen] = useState(false);
  const [importCharacterId, setImportCharacterId] = useState<string | undefined>();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorCharacterId, setEditorCharacterId] = useState<string | undefined>();
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [migrationCharacterId, setMigrationCharacterId] = useState<string | undefined>();
  const [configurations, setConfigurations] = useState<ModelConfiguration[]>([]);
  const [usageMode, setUsageMode] = useState<'PLATFORM' | 'BYOK'>('PLATFORM');
  const [selectedConfigurationId, setSelectedConfigurationId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [, setErrorCode] = useState<string | null>(null);
  const [freeQuotaRemaining, setFreeQuotaRemaining] = useState<number | null>(null);
  const [freeQuotaEnabled, setFreeQuotaEnabled] = useState(true);
  const [account, setAccount] = useState<AnonymousIdentity | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [cloud, setCloud] = useState<CloudStatus | null>(() => readCachedStatus());
  const [cloudOffline, setCloudOffline] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [analyticsReady, setAnalyticsReady] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggesting, setSuggesting] = useState(false);
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
  const suggestAbortRef = useRef<AbortController | null>(null);
  // Identifies the conversation state the current suggestions were (or are being)
  // fetched for. Re-requesting the same key would buy an identical answer twice.
  const suggestionKeyRef = useRef<string>('');
  const suggestionTimerRef = useRef<number>(0);
  // Monotonic token for character opens: only the newest open may write state, so a
  // slow earlier request can never resurrect a contact the reader has left.
  const openTokenRef = useRef(0);
  // Multi-bubble turn playback. The controller is a stable singleton so a new turn
  // (or a tab-visibility change) can interrupt/pause the one in flight.
  const playbackRef = useRef<TurnPlaybackController | null>(null);
  const turnIdRef = useRef<string>('');
  const scheduleSuggestionsRef = useRef<(id: string, key: string) => void>(() => {});

  useEffect(() => { conversationIdRef.current = conversationId; }, [conversationId]);
  useEffect(() => { activeRef.current = active; }, [active]);

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
      onDone: () => {
        const conv = conversationIdRef.current;
        // Skipped outright when the turn already carried its own suggestions:
        // `submit` claims this key, so one turn never costs two model calls.
        if (conv) scheduleSuggestionsRef.current(conv, `turn:${turnIdRef.current}`);
      },
      onError: (reason) => {
        setTyping(false);
        const message = reason instanceof Error ? reason.message : '发送失败，请稍后重试。';
        const apiError = reason instanceof ApiError ? reason : null;
        setError(message);
        setErrorCode(apiError?.code ?? 'GENERATION_FAILED');
        analytics.blockingError(
          analyticsErrorCode(apiError?.code ?? 'GENERATION_FAILED'),
          'chat',
          {
            errorStage: 'generation',
            retryable: apiError?.retryable ?? false,
            ...(apiError?.requestId ? { requestId: apiError.requestId } : {}),
            ...(activeRef.current
              ? { characterId: activeRef.current.character_id }
              : {}),
            ...(conversationIdRef.current
              ? { conversationId: conversationIdRef.current }
              : {})
          }
        );
      }
    });
    playbackRef.current = controller;
    const onVisibility = () => {
      if (document.hidden) controller.pause();
      else controller.resume();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.clearTimeout(suggestionTimerRef.current);
      suggestAbortRef.current?.abort();
      controller.interrupt();
    };
  }, []);

  async function openCharacter(
    character: Character,
    nextView: View = 'chat',
    trackSelection = false
  ) {
    // Abandon any in-flight turn so its bubbles never land in the new conversation.
    playbackRef.current?.interrupt();
    const token = ++openTokenRef.current;
    // A pending suggestion request belongs to the conversation being left.
    window.clearTimeout(suggestionTimerRef.current);
    suggestAbortRef.current?.abort();
    setTyping(false);
    setActive(character);
    setView(nextView);
    setError(null);
    setErrorCode(null);
    setSuggestions([]);
    const created = await api<{ conversation_id: string }>('/v1/conversations', {
      method: 'POST', body: JSON.stringify({ character_id: character.character_id })
    });
    // The reader has already moved on; writing this state back would drag them
    // to a contact they left, so the response is recorded and otherwise dropped.
    cacheConversationId(character.character_id, created.conversation_id);
    if (token !== openTokenRef.current) return;
    conversationIdRef.current = created.conversation_id;
    setConversationId(created.conversation_id);
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
    const lastMessage = loaded[loaded.length - 1];
    if (lastMessage) {
      scheduleSuggestions(created.conversation_id, `open:${created.conversation_id}:${lastMessage.message_id}`);
    }
  }

  /**
   * Degraded open: LiteTavern Cloud is unreachable, so the last conversation this
   * browser read for the character is replayed from cache. Nothing is written and
   * the banner tells the user the state is stale, not lost.
   */
  function openCharacterOffline(character: Character) {
    playbackRef.current?.interrupt();
    openTokenRef.current += 1;
    window.clearTimeout(suggestionTimerRef.current);
    setTyping(false);
    setActive(character);
    setView('chat');
    setSuggestions([]);
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
    try {
      const result = await fetchCloudStatus();
      if (result.status) setCloud(result.status);
      setCloudOffline(result.offline);
      return result.status;
    } catch {
      return null;
    }
  }

  // Empty-bodied messages (a failed mid-stream reply, or a character with no opening
  // line) would otherwise render as an endless "typing" bubble, so they are dropped.
  async function fetchMessages(targetConversationId: string): Promise<Message[]> {
    const response = await api<{ messages: Message[] }>(`/v1/conversations/${targetConversationId}/messages`);
    return response.messages.filter((message) => message.content_text.trim() !== '');
  }

  async function refreshCharacters(openImported = false) {
    const response = await api<{ characters: Character[] }>('/v1/characters');
    setCharacters(response.characters);
    if (openImported && response.characters[0]) {
      // After an import or an edit, land back on the profile that was just
      // changed so the result is visible.
      const next = response.characters.find((item) => item.character_id === active?.character_id) ?? response.characters[0];
      await openCharacter(next, active ? 'profile' : 'chat');
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
      setFreeQuotaRemaining(identityResponse.user.free_quota_remaining);
      setFreeQuotaEnabled(identityResponse.user.free_quota_enabled);
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
    const [characterResponse, configurationResponse] = await Promise.all([
      api<{ characters: Character[] }>('/v1/characters'),
      api<{ configurations: ModelConfiguration[] }>('/v1/model-configurations')
    ]);
    setCharacters(characterResponse.characters);
    cacheCharacters(characterResponse.characters);
    setConfigurations(configurationResponse.configurations);
    if (configurationResponse.configurations[0]) {
      setSelectedConfigurationId(configurationResponse.configurations[0].model_configuration_id);
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
    setFreeQuotaRemaining(user.free_quota_remaining);
    setFreeQuotaEnabled(user.free_quota_enabled);
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
      setFreeQuotaRemaining(identityResponse.user.free_quota_remaining);
      setFreeQuotaEnabled(identityResponse.user.free_quota_enabled);
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

  // Resolve the model selector (usage mode + BYOK credentials) shared by both
  // message sending and reply-suggestion requests.
  async function resolveModelSelector(): Promise<Record<string, unknown>> {
    if (usageMode !== 'BYOK') return { usage_mode: 'PLATFORM' };
    const configuration = configurations.find((item) => item.model_configuration_id === selectedConfigurationId);
    if (!configuration) throw new Error('请先添加一个用户自带模型。');
    const key = await credentialStore.readSecret(configuration.credential_id);
    if (!key) throw new Error('当前浏览器中找不到该配置的 API Key，请重新绑定。');
    return {
      usage_mode: 'BYOK',
      model_configuration_id: configuration.model_configuration_id,
      credential: { credential_id: configuration.credential_id, api_key: key }
    };
  }

  /**
   * Requests suggestions for one specific conversation state. `key` names that
   * state, so the same answer is never bought twice.
   */
  async function loadSuggestions(targetConversationId: string, key: string) {
    // The reader moved on while the debounce was pending.
    if (conversationIdRef.current !== targetConversationId) return;
    suggestAbortRef.current?.abort();
    const controller = new AbortController();
    suggestAbortRef.current = controller;
    setSuggesting(true);
    try {
      const selector = await resolveModelSelector();
      const response = await api<{ suggestions: string[] }>(
        `/v1/conversations/${targetConversationId}/reply-suggestions`,
        {
          method: 'POST',
          body: JSON.stringify(selector),
          signal: controller.signal
        }
      );
      if (conversationIdRef.current === targetConversationId) {
        setSuggestions(response.suggestions.slice(0, 3));
      }
    } catch (reason) {
      if ((reason as Error)?.name === 'AbortError') return;
      // A failed request bought nothing, so the key is released and the next
      // message (or a reopen) may try again.
      if (suggestionKeyRef.current === key) suggestionKeyRef.current = '';
      if (conversationIdRef.current === targetConversationId) setSuggestions([]);
    } finally {
      if (suggestAbortRef.current === controller) {
        suggestAbortRef.current = null;
        setSuggesting(false);
      }
    }
  }

  /**
   * Claims a conversation state and, after a short settle, pays for suggestions
   * for it. Already-claimed states return immediately — that is what stops one
   * turn costing two model calls and a restless clicker costing one per click.
   */
  function scheduleSuggestions(targetConversationId: string, key: string) {
    if (suggestionKeyRef.current === key) return;
    suggestionKeyRef.current = key;
    window.clearTimeout(suggestionTimerRef.current);
    suggestionTimerRef.current = window.setTimeout(() => {
      void loadSuggestions(targetConversationId, key);
    }, SUGGESTION_DEBOUNCE_MS);
  }

  useEffect(() => {
    scheduleSuggestionsRef.current = scheduleSuggestions;
  });

  // `editOfMessageId` re-sends an earlier user message: that message and everything
  // after it leaves the active branch, and this turn continues from the new text.
  // The turn is generated once and then played out as 1–4 bubbles by the controller;
  // sending again interrupts any bubbles not yet shown.
  async function submit(rawText: string, editOfMessageId?: string) {
    const text = rawText.trim();
    const controller = playbackRef.current;
    if (!text || !conversationId || !controller) return;
    // Ignore repeat sends only while awaiting the model; during playback a new send
    // is allowed and interrupts the remaining bubbles.
    if (controller.getState() === 'GENERATING') return;
    // Blocked only when the server has told us there is nothing left to spend. The
    // Cloud status is authoritative; the legacy counter is the fallback while the
    // first status response is still in flight.
    const platformExhausted = cloud
      ? cloud.quota.source === 'NONE' || cloud.quota.available === 0
      : freeQuotaRemaining === 0;
    if (usageMode === 'PLATFORM' && (!freeQuotaEnabled || platformExhausted)) {
      const code = freeQuotaEnabled
        ? 'FREE_QUOTA_EXHAUSTED'
        : 'FREE_SERVICE_DISABLED';
      setErrorCode(code);
      setError(
        freeQuotaEnabled
          ? 'LiteTavern Cloud 的额度已用完。你可以接入自己的模型继续聊天。'
          : 'LiteTavern Cloud 平台模型当前已关闭。你可以接入自己的模型继续聊天。'
      );
      analytics.blockingError(analyticsErrorCode(code), 'chat', {
        errorStage: 'quota_check',
        retryable: false,
        ...(active ? { characterId: active.character_id } : {}),
        ...(conversationId ? { conversationId } : {})
      });
      return;
    }
    playClick();
    const targetConversationId = conversationId;
    if (!editOfMessageId) setDraft('');
    setSuggestions([]);
    setError(null);
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
    const userMessage: Message = { message_id: createId(), role: 'USER', content_text: text, status: 'COMPLETED' };
    setMessages((current) => {
      const index = editOfMessageId ? current.findIndex((message) => message.message_id === editOfMessageId) : -1;
      const kept = index >= 0 ? current.slice(0, index) : current;
      return [...kept, userMessage];
    });

    // startTurn bumps the controller's version, so an earlier turn's pending bubbles
    // are abandoned (already-shown ones stay). The model call happens inside generate,
    // letting the controller fold its latency into the first bubble's lead time.
    await controller.startTurn(async () => {
      const selector = await resolveModelSelector();
      const payload = {
        ...selector,
        input: { type: 'text', text },
        ...(editOfMessageId ? { edit_of_message_id: editOfMessageId } : {})
      };
      const plan = await generateTurn(targetConversationId, payload);
      turnIdRef.current = plan.turn_id;
      if (plan.free_quota_remaining !== undefined) {
        setFreeQuotaRemaining(plan.free_quota_remaining);
      }
      // The reply carries the post-deduction quota, so the badge stays honest
      // without an extra round trip.
      if (plan.cloud_quota) {
        setCloud((current) =>
          current ? { ...current, quota: { ...current.quota, ...plan.cloud_quota } } : current
        );
      }
      // A turn that answered with its own suggestions has already been paid for;
      // claiming the key makes the `onDone` follow-up a no-op.
      if (plan.suggestions?.length) {
        suggestionKeyRef.current = `turn:${plan.turn_id}`;
        setSuggestions(plan.suggestions.slice(0, 3));
      } else {
        setSuggestions([]);
      }
      return plan.messages;
    });
  }

  function send(event: FormEvent) {
    event.preventDefault();
    void submit(draft);
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
        {...(view === 'memories' && active ? { title: `与${active.name}的记忆` } : {})}
      />

      <section className="hsr-stage">
        {cloudOffline && (
          <p className="cloud-offline-banner" role="status">
            LiteTavern Cloud 暂时不可用。本地角色、已缓存的对话和自带模型仍可使用；
            未同步的内容会在恢复后重试，数据没有丢失。
          </p>
        )}
        {view === 'chat' && contactRail}
        {!active ? (
          <EmptyCharacter />
        ) : view === 'chat' ? (
          <ChatPage
            character={active} messages={messages} draft={draft} sending={sending} error={error}
            freeQuotaRemaining={freeQuotaRemaining} freeQuotaEnabled={freeQuotaEnabled}
            cloud={cloud}
            usageMode={usageMode} configurations={configurations} selectedConfigurationId={selectedConfigurationId}
            suggestions={suggestions} suggesting={suggesting} typing={typing}
            onProfile={() => setView('profile')} onDraft={setDraft} onSend={send} onPick={(text) => void submit(text)}
            onEditSubmit={(messageId, text) => void submit(text, messageId)}
            onUsageMode={(mode) => {
              setUsageMode(mode);
              if (mode === 'BYOK') {
                analytics.criticalAction('byok_selected', 'chat', { result: 'success' });
              }
            }}
            onConfiguration={setSelectedConfigurationId}
            onProvider={() => openProviderSettings('byok')}
            onPlatformQuota={() => openProviderSettings('platform')}
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
            onEdit={() => {
              setEditorCharacterId(active.character_id);
              setEditorOpen(true);
            }}
            onImport={() => openCharacterImport(active.character_id)}
            onExportHref={cloudUrl(`/v1/characters/${active.character_id}/export`)}
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
        offline={cloudOffline}
        freeQuotaEnabled={freeQuotaEnabled}
        usageMode={usageMode}
        initialSection={providerInitialSection}
        onUsageMode={setUsageMode}
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
        onImported={() => refreshCharacters(true)}
      />
      <CharacterEditor
        open={editorOpen}
        {...(editorCharacterId ? { characterId: editorCharacterId } : {})}
        onClose={() => setEditorOpen(false)}
        onSaved={() => refreshCharacters(true)}
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
  const registered = account?.registered ?? account?.identity_type === 'EMAIL';
  return (
    <header className="top-chrome">
      <div className="sms-title"><SmsIcon size={30} /><span><strong>短信</strong>{title && <small>{title}</small>}</span></div>
      <div className="chrome-actions">
        <button type="button" className="chrome-nav" onClick={onProvider} aria-label="模型服务">
          <KeyRound size={16} /><span className="chrome-action-label">模型服务</span>
        </button>
        <button type="button" className="chrome-nav" onClick={onSettings} aria-label="设置">
          <Settings size={16} /><span className="chrome-action-label">设置</span>
        </button>
        <button
          type="button"
          className={registered ? 'account-chip account-entry' : 'chrome-login account-entry'}
          onClick={onAccount}
          aria-label={registered ? '管理账号与同步' : '登录'}
          title={registered ? account?.email ?? undefined : undefined}
        >
          <UserRound size={16} />
          <span className="account-email">{registered ? account?.email || '账号' : '登录'}</span>
          {syncError && <span className="sync-warning">同步异常</span>}
        </button>
        {onToggleMute && (
          <button className="chrome-mute" onClick={onToggleMute} aria-label={muted ? '开启音效' : '关闭音效'} aria-pressed={muted}>
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
  return (
    <aside className={`contact-rail rail-${tone}`}>
      <div className="contact-scroll">
        {characters.map((character) => (
          <button key={character.character_id} className={`contact-item ${active?.character_id === character.character_id ? 'selected' : ''}`} onClick={() => onSelect(character)}>
            <Avatar character={character} />
            <span className="contact-copy"><strong>{character.name}</strong><small>{character.last_message || character.first_message || character.profile_summary || '等待新的消息'}</small></span>
            <ChevronRight size={24} />
          </button>
        ))}
        {!characters.length && <div className="empty-contacts"><MessageCircle size={28} /><strong>还没有联系人</strong><span>从下方新建角色；角色卡可从顶部设置导入</span></div>}
      </div>
      <div className="rail-actions">
        <button className="rail-action" onClick={onCreate}><Plus size={21} /> 新建角色</button>
      </div>
    </aside>
  );
}

function EmptyCharacter() {
  return (
    <section className="main-paper empty-paper">
      <MessageCircle size={42} />
      <h1>等待第一条短信</h1>
      <p>从左侧“新建角色”开始；已有角色卡可在“设置 → 数据导入与迁移”中导入。</p>
    </section>
  );
}

function autoGrow(element: HTMLTextAreaElement) {
  element.style.height = 'auto';
  element.style.height = `${element.scrollHeight}px`;
}

// Copy is always available; editing is held back while a reply streams so an edit
// can never race the generation it would invalidate.
function MessageActions({ text, editable = false, onEdit }: { text: string; editable?: boolean; onEdit?: () => void }) {
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
      <button type="button" onClick={() => void copy()} title={copied ? '已复制' : '复制'} aria-label={copied ? '已复制' : '复制消息'}>
        {copied ? <Check size={16} /> : <Copy size={16} />}
      </button>
      {editable && onEdit && (
        <button type="button" onClick={onEdit} title="编辑消息" aria-label="编辑消息">
          <Pencil size={16} />
        </button>
      )}
    </div>
  );
}

function MessageEditor({ initial, onCancel, onSubmit }: {
  initial: string; onCancel: () => void; onSubmit: (text: string) => void;
}) {
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
        ref={ref} value={value} rows={1} aria-label="编辑消息内容"
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
        <button type="button" className="editor-cancel" onClick={onCancel}>取消</button>
        <button type="button" className="editor-save" disabled={!dirty} onClick={() => onSubmit(value)}>发送</button>
      </div>
    </div>
  );
}

function ChatPage({ character, messages, draft, sending, error, freeQuotaRemaining, freeQuotaEnabled, cloud, usageMode, configurations, selectedConfigurationId, suggestions, suggesting, typing, onProfile, onDraft, onSend, onPick, onEditSubmit, onUsageMode, onConfiguration, onProvider, onPlatformQuota }: {
  character: Character; messages: Message[]; draft: string; sending: boolean; error: string | null;
  freeQuotaRemaining: number | null; freeQuotaEnabled: boolean;
  cloud: CloudStatus | null;
  usageMode: 'PLATFORM' | 'BYOK'; configurations: ModelConfiguration[]; selectedConfigurationId: string;
  suggestions: string[]; suggesting: boolean; typing: boolean;
  onProfile: () => void; onDraft: (value: string) => void; onSend: (event: FormEvent) => void; onPick: (text: string) => void;
  onEditSubmit: (messageId: string, text: string) => void;
  onUsageMode: (mode: 'PLATFORM' | 'BYOK') => void; onConfiguration: (id: string) => void; onProvider: () => void;
  onPlatformQuota: () => void;
}) {
  const lastLine = [...messages].reverse().find((message) => message.role === 'ASSISTANT' && message.content_text.trim())?.content_text
    || character.first_message || character.profile_summary || '角色档案';

  // The server decides whether anything is left to spend; the legacy counter only
  // covers the moment before the first Cloud status arrives.
  const platformExhausted = cloud
    ? cloud.quota.source === 'NONE' || cloud.quota.available === 0
    : freeQuotaRemaining === 0;
  const officialBlocked =
    usageMode === 'PLATFORM' && (!freeQuotaEnabled || platformExhausted);
  const noAvailableModel =
    (!freeQuotaEnabled || platformExhausted) && configurations.length === 0;

  const scrollRef = useRef<HTMLDivElement>(null);
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
  useEffect(() => { if (pinnedRef.current) scrollToBottom('smooth'); }, [suggestions.length, suggesting]);
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
      <button className="chat-heading" onClick={onProfile} aria-label={`打开${character.name}档案`}>
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
                        {...(message.role === 'USER' ? { onEdit: () => setEditingId(message.message_id) } : {})}
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
          {!messages.length && !typing && <div className="chat-placeholder">开始你们的第一段对话。</div>}
          {error && <p className="inline-error"><CircleAlert size={17} />{error}</p>}
        </div>
        {!pinned && (
          <button className="scroll-bottom" aria-label="滚动到底部" onClick={() => scrollToBottom('smooth')}>
            <ChevronDown size={20} />
          </button>
        )}
      </div>
      <footer className="reply-area">
        {noAvailableModel && (
          <div className="quota-notice" role="status">
            <span>
              <CircleAlert size={16} />
              当前没有可用模型。请接入自己的模型，或查看 LiteTavern Cloud 的平台额度。
            </span>
            <div className="quota-notice-actions">
              <button type="button" onClick={onProvider}>接入自己的模型</button>
              <button type="button" onClick={onPlatformQuota}>查看 LiteTavern Cloud 额度</button>
            </div>
          </div>
        )}
        {(suggestions.length > 0 || suggesting) && (
          <div className="reply-suggestions" role="group" aria-label="快捷回复">
            {suggesting && suggestions.length === 0 ? (
              <span className="suggestion-hint"><LoaderCircle className="spin" size={14} /> 正在想几句回复…</span>
            ) : (
              suggestions.map((text) => (
                <button key={text} className="suggestion-chip" disabled={sending} onClick={() => onPick(text)}>{text}</button>
              ))
            )}
          </div>
        )}
        <div className="model-bar">
          {/* A mode switch, not a meter — the remaining allowance lives in the
              status chip so the two never disagree. */}
          <button
            className={usageMode === 'PLATFORM' ? 'active' : ''}
            onClick={() => onUsageMode('PLATFORM')}
            title={quotaLabel(cloud)}
          >
            LiteTavern Cloud
          </button>
          <button className={usageMode === 'BYOK' ? 'active' : ''} onClick={() => configurations.length ? onUsageMode('BYOK') : onProvider()}>自己的模型</button>
          {usageMode === 'BYOK' && configurations.length > 0 && (
            <select value={selectedConfigurationId} onChange={(event) => onConfiguration(event.target.value)}>
              {configurations.map((item) => <option value={item.model_configuration_id} key={item.model_configuration_id}>{item.display_name} · {item.model_name}</option>)}
            </select>
          )}
        </div>
        <form className="reply-composer" onSubmit={onSend}>
          <Send size={23} />
          <textarea
            value={draft} rows={1} placeholder={`给${character.name}发送短信…`}
            onChange={(event) => onDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }}
          />
          <button disabled={!draft.trim() || sending || officialBlocked} aria-label="发送消息">{sending ? <LoaderCircle className="spin" size={20} /> : '发送'}</button>
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
      setError(reason instanceof Error ? reason.message : '保存失败，请稍后重试。');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="info-block">
      <div className="info-block-head">
        <h2>{label}</h2>
        {!editing && (
          <button type="button" className="info-edit" onClick={() => setEditing(true)} aria-label={`编辑${label}`}>
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
              取消
            </button>
            <button type="button" className="editor-save" onClick={() => void commit()} disabled={saving}>
              {saving ? '保存中…' : '保存'}
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
  character, relationship, memoryCount, onChat, onMemories, onEdit, onImport, onExportHref, onDelete, onFieldSaved
}: {
  character: Character;
  relationship: string | null;
  memoryCount: number | null;
  onChat: () => void;
  onMemories: () => void;
  onEdit: () => void;
  onImport: () => void;
  onExportHref: string;
  onDelete: () => Promise<void>;
  onFieldSaved: () => Promise<void>;
}) {
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
      setDeleteError(error instanceof Error ? error.message : '删除失败，请稍后重试。');
      setDeleting(false);
    }
  }

  return (
    <section className="main-paper profile-paper">
      <div className="detail-topbar">
        <button className="detail-back" onClick={onChat}><ArrowLeft size={19} /> 返回短信</button>
        <div className="detail-topbar-actions">
          <button className="topbar-action" onClick={onEdit}>
            <Pencil size={15} /> 编辑
          </button>
          <div className="overflow-menu" onClick={(event) => event.stopPropagation()}>
            <button
              className="topbar-action topbar-action-icon"
              aria-label="更多操作"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <MoreHorizontal size={17} />
            </button>
            {menuOpen && (
              <div className="overflow-items" role="menu">
                <button role="menuitem" onClick={() => { setMenuOpen(false); onImport(); }}>
                  <Upload size={15} /> 用角色卡更新设定
                </button>
                <a role="menuitem" href={onExportHref}>
                  <Download size={15} /> 导出角色卡
                </a>
                {character.is_owned && (
                  <button role="menuitem" className="overflow-danger" onClick={() => { setMenuOpen(false); setConfirming(true); }}>
                    <Trash2 size={15} /> 删除角色
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
              <p>{character.profile_summary || '角色卡暂未填写简介。'}</p>
            </div>
          </header>

          <div className="profile-info">
            <InlineField
              label="简介"
              value={character.profile_summary}
              placeholder="外貌、身份、背景"
              rows={4}
              onSave={(next) => saveField({ description: next })}
            >
              <p>{character.profile_summary || '角色卡暂未填写简介。'}</p>
            </InlineField>

            <InlineField
              label="核心性格"
              hint="用顿号分隔可显示为标签，例如：温柔、坚定、话少"
              value={character.personality_summary}
              placeholder="温柔、坚定、话少"
              rows={3}
              onSave={(next) => saveField({ personality: next })}
            >
              {traits
                ? <div className="trait-chips">{traits.map((trait) => <span key={trait}>{trait}</span>)}</div>
                : <p>{character.personality_summary || '角色卡暂未填写性格描述。'}</p>}
            </InlineField>

            {/* Written by the Cloud's post-turn worker, so the page says what
                produces it instead of promising something that never appears. */}
            <section className="info-block">
              <h2>你们的关系</h2>
              {relationship ? (
                <>
                  <p>{relationship}</p>
                  <small className="info-note">每次对话结束后自动更新。</small>
                </>
              ) : (
                <p className="muted">
                  你和{character.name}聊过之后，这里会自动出现一段关系摘要，并随对话更新。
                </p>
              )}
            </section>
          </div>

          <nav className="profile-actions">
            <button onClick={onMemories} aria-label="记忆">
              <span className="pa-icon"><Brain size={22} /></span>
              <span className="pa-copy">
                <strong>记忆</strong>
                <small>
                  {memoryCount === null
                    ? '对话中值得记住的片段'
                    : memoryCount > 0
                      ? `${memoryCount} 条，会随对话一起提供给${character.name}`
                      : '还没有记下任何片段'}
                </small>
              </span>
              <ChevronRight size={19} />
            </button>
          </nav>
        </div>
      </div>

      {confirming && (
        <div className="modal-backdrop" onClick={() => !deleting && setConfirming(false)}>
          <div className="confirm-dialog" onClick={(event) => event.stopPropagation()}>
            <h2>删除「{character.name}」？</h2>
            <p>删除后将无法在联系人中找到该角色，聊天记录也会一并移除，此操作无法撤销。</p>
            {deleteError && <p className="confirm-error">{deleteError}</p>}
            <div className="confirm-actions">
              <button className="confirm-cancel" onClick={() => setConfirming(false)} disabled={deleting}>取消</button>
              <button className="confirm-delete" onClick={() => void confirmDelete()} disabled={deleting}>
                {deleting ? '删除中…' : '删除角色'}
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

// The kinds the Cloud actually stores. Anything unrecognised falls into 其他
// rather than being shown as a raw enum name, which is what the page used to do.
const MEMORY_KINDS: { key: string; label: string; blurb: string }[] = [
  { key: 'FACT', label: '事实', blurb: '关于你的确定信息' },
  { key: 'PREFERENCE', label: '偏好', blurb: '你喜欢或不喜欢的' },
  { key: 'EXPERIENCE', label: '共同经历', blurb: '你们一起发生过的事' },
  { key: 'COMMITMENT', label: '约定', blurb: '你们约好的事' },
  { key: 'CORRECTION', label: '更正', blurb: '你纠正过的说法' },
  { key: 'OTHER', label: '其他', blurb: '尚未归类的片段' }
];

function MemoryPage({ character, onBack, onChat, onCountChange }: {
  character: Character;
  onBack: () => void;
  onChat: () => void;
  onCountChange: (count: number) => void;
}) {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<MemoryItem | null>(null);

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

  const grouped = MEMORY_KINDS.map((kind) => ({
    ...kind,
    items: memories.filter((memory) => (memory.memory_kind || 'OTHER') === kind.key)
  })).filter((group) => group.items.length > 0);
  const unknown = memories.filter(
    (memory) => !MEMORY_KINDS.some((kind) => kind.key === (memory.memory_kind || 'OTHER'))
  );

  return (
    <section className="main-paper memory-paper">
      <div className="detail-topbar">
        <button className="detail-back" onClick={onBack}><ArrowLeft size={19} /> 返回资料</button>
        <span className="detail-title">记忆</span>
      </div>
      <div className="detail-scroll">
        <div className="detail-column">
          <div className="memory-head">
            <div>
              <h1>记忆</h1>
              {/* Answers the only question that matters here: what is this for? */}
              <p>这些片段会随对话一起提供给{character.name}，删掉的不再参与。</p>
            </div>
            <span className="memory-count">{memories.length}</span>
          </div>

          {loading ? (
            <p className="import-state"><LoaderCircle className="spin" size={18} /> 正在读取记忆…</p>
          ) : memories.length > 0 ? (
            <>
              {[...grouped, ...(unknown.length ? [{ key: 'UNSORTED', label: '其他', blurb: '尚未归类的片段', items: unknown }] : [])].map((group) => (
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
                            <span>{memory.created_by === 'USER' ? '你添加的' : '自动记下的'}</span>
                            {memory.status === 'CANDIDATE' && <span className="memory-tag">待确认</span>}
                            {memory.created_at && (
                              <time>{new Date(memory.created_at).toLocaleDateString('zh-CN')}</time>
                            )}
                          </div>
                        </div>
                        <button aria-label={`删除记忆：${memory.content.slice(0, 12)}`} onClick={() => setPendingDelete(memory)}>
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
              <strong>还没有记下任何片段</strong>
              <p>
                你和{character.name}每聊完一轮，值得长期记住的信息会被自动挑出来放在这里，
                之后的对话就会带上它们。
              </p>
              <button className="gold-button" onClick={onChat}><MessageCircle size={18} /> 去聊聊</button>
            </div>
          )}
        </div>
      </div>

      {pendingDelete && (
        <div className="modal-backdrop" onClick={() => setPendingDelete(null)}>
          <div className="confirm-dialog" onClick={(event) => event.stopPropagation()}>
            <h2>删除这条记忆？</h2>
            <p>删除后，{character.name}的后续对话不会再带上它。此操作无法撤销。</p>
            <div className="confirm-actions">
              <button className="confirm-cancel" onClick={() => setPendingDelete(null)}>取消</button>
              <button className="confirm-delete" onClick={() => void remove(pendingDelete)}>删除</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
