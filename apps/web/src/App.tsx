import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowLeft, Brain, Check, ChevronDown, ChevronRight, CircleAlert, Copy, Download,
  HeartHandshake, KeyRound, LoaderCircle, MessageCircle, Pencil, Plus, Send, Settings,
  Trash2, Upload, UserRound, Volume2, VolumeX
} from 'lucide-react';
import { CloudPanel } from './components/CloudPanel';
import { ProviderSettings } from './components/ProviderSettings';
import { CharacterImport } from './components/CharacterImport';
import { CharacterEditor } from './components/CharacterEditor';
import { RelationshipImport } from './components/RelationshipImport';
import { LoginSync } from './components/LoginSync';
import { AboutPage } from './pages/AboutPage';
import { SupportPage } from './pages/SupportPage';
import {
  ApiError, api, deleteCharacter, generateTurn, logout, saveTurnBubble,
  type AnonymousIdentity, type Character, type Message, type ModelConfiguration
} from './lib/api';
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
import { publicRouteForPath, siteHref } from './public-routing';

type View = 'chat' | 'profile' | 'memories' | 'settings';

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
  const [importOpen, setImportOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorCharacterId, setEditorCharacterId] = useState<string | undefined>();
  const [migrationOpen, setMigrationOpen] = useState(false);
  const [migrationCharacterId, setMigrationCharacterId] = useState<string | undefined>();
  const [configurations, setConfigurations] = useState<ModelConfiguration[]>([]);
  const [usageMode, setUsageMode] = useState<'PLATFORM' | 'BYOK'>('PLATFORM');
  const [selectedConfigurationId, setSelectedConfigurationId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [freeQuotaRemaining, setFreeQuotaRemaining] = useState<number | null>(null);
  const [freeQuotaEnabled, setFreeQuotaEnabled] = useState(true);
  const [account, setAccount] = useState<AnonymousIdentity | null>(null);
  const [loginOpen, setLoginOpen] = useState(false);
  const [cloud, setCloud] = useState<CloudStatus | null>(() => readCachedStatus());
  const [cloudOffline, setCloudOffline] = useState(false);
  const [cloudOpen, setCloudOpen] = useState(false);
  const [analyticsReady, setAnalyticsReady] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [typing, setTyping] = useState(false);
  const [muted, setMutedState] = useState(isMuted());
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
  // Multi-bubble turn playback. The controller is a stable singleton so a new turn
  // (or a tab-visibility change) can interrupt/pause the one in flight.
  const playbackRef = useRef<TurnPlaybackController | null>(null);
  const turnIdRef = useRef<string>('');
  const loadSuggestionsRef = useRef<(id: string) => void>(() => {});

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
        if (conv) loadSuggestionsRef.current(conv);
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
    setTyping(false);
    setActive(character);
    setView(nextView);
    setError(null);
    setErrorCode(null);
    setSuggestions([]);
    const created = await api<{ conversation_id: string }>('/v1/conversations', {
      method: 'POST', body: JSON.stringify({ character_id: character.character_id })
    });
    setConversationId(created.conversation_id);
    if (trackSelection) {
      analytics.criticalAction('character_selected', 'home', {
        characterId: character.character_id,
        conversationId: created.conversation_id,
        result: 'success'
      });
    }
    cacheConversationId(character.character_id, created.conversation_id);
    const loaded = await fetchMessages(created.conversation_id);
    setMessages(loaded);
    cacheMessages(created.conversation_id, loaded);
    if (loaded.length > 0) void loadSuggestions(created.conversation_id);
  }

  /**
   * Degraded open: LiteTavern Cloud is unreachable, so the last conversation this
   * browser read for the character is replayed from cache. Nothing is written and
   * the banner tells the user the state is stale, not lost.
   */
  function openCharacterOffline(character: Character) {
    playbackRef.current?.interrupt();
    setTyping(false);
    setActive(character);
    setView('chat');
    setSuggestions([]);
    const cachedId = cachedConversationId(character.character_id);
    setConversationId(cachedId);
    setMessages(cachedId ? cachedMessages(cachedId) : []);
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
      const next = response.characters.find((item) => item.character_id === active?.character_id) ?? response.characters[0];
      await openCharacter(next, active ? 'settings' : 'chat');
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
              : view === 'memories'
                ? 'character_memories'
                : 'character_settings';

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

  async function loadSuggestions(targetConversationId: string) {
    // Cancel any in-flight suggestion request — only the latest conversation matters.
    suggestAbortRef.current?.abort();
    const controller = new AbortController();
    suggestAbortRef.current = controller;
    setSuggesting(true);
    try {
      const selector = await resolveModelSelector();
      const response = await api<{ suggestions: string[] }>(
        `/v1/conversations/${targetConversationId}/reply-suggestions`,
        { method: 'POST', body: JSON.stringify(selector), signal: controller.signal }
      );
      if (conversationIdRef.current === targetConversationId) {
        setSuggestions(response.suggestions.slice(0, 3));
      }
    } catch (reason) {
      if ((reason as Error)?.name !== 'AbortError' && conversationIdRef.current === targetConversationId) {
        setSuggestions([]);
      }
    } finally {
      if (suggestAbortRef.current === controller) {
        suggestAbortRef.current = null;
        setSuggesting(false);
      }
    }
  }

  // Keep the playback controller's onDone able to reach the latest loadSuggestions
  // closure (it captures the current usage mode / credentials).
  useEffect(() => { loadSuggestionsRef.current = loadSuggestions; });

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
          ? '你的官方免费回复次数已用完。你可以配置自己的模型服务继续聊天。'
          : '官方免费服务当前已关闭。你可以配置自己的模型服务继续聊天。'
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
      return plan.messages;
    });
  }

  function send(event: FormEvent) {
    event.preventDefault();
    void submit(draft);
  }

  function openProviderSettings() {
    analytics.criticalAction('provider_config_started', analyticsPage, {
      ...(active ? { characterId: active.character_id } : {}),
      ...(conversationId ? { conversationId } : {}),
      result: 'attempted'
    });
    setProviderOpen(true);
  }

  function openCharacterImport() {
    analytics.criticalAction('character_import_started', analyticsPage, {
      ...(active ? { characterId: active.character_id } : {}),
      ...(conversationId ? { conversationId } : {}),
      result: 'attempted'
    });
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
      onSelect={(character) => void openCharacter(character, 'chat', true)}
      onImport={openCharacterImport}
      onCreate={openCharacterCreate}
      onMigrate={() => openRelationshipImport()}
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
        cloud={cloud}
        onLogin={openLogin}
        onLogout={() => void onLogout()}
        onCloud={() => setCloudOpen(true)}
        {...(view === 'memories' && active ? { title: `与${active.name}的回忆` } : view === 'settings' ? { title: 'LiteTavern' } : {})}
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
          <EmptyCharacter
            onImport={openCharacterImport}
            onCreate={openCharacterCreate}
            onMigrate={() => openRelationshipImport()}
          />
        ) : view === 'chat' ? (
          <ChatPage
            character={active} messages={messages} draft={draft} sending={sending} error={error}
            errorCode={errorCode} freeQuotaRemaining={freeQuotaRemaining} freeQuotaEnabled={freeQuotaEnabled}
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
            onProvider={openProviderSettings}
            onCloud={() => setCloudOpen(true)}
          />
        ) : view === 'profile' ? (
          <ProfilePage
            character={active}
            onChat={() => {
              analytics.criticalAction('chat_start_clicked', 'character_detail', {
                characterId: active.character_id,
                ...(conversationId ? { conversationId } : {}),
                result: 'attempted'
              });
              setView('chat');
            }}
            onMemories={() => setView('memories')}
            onSettings={() => setView('settings')}
          />
        ) : view === 'memories' ? (
          <MemoryPage character={active} onBack={() => setView('profile')} onChat={() => setView('chat')} />
        ) : (
          <CharacterSettingsPage
            character={active} configurations={configurations}
            onBack={() => setView('profile')} onImport={openCharacterImport}
            onMigrate={() => openRelationshipImport(active.character_id)}
            onEdit={() => {
              setEditorCharacterId(active.character_id);
              setEditorOpen(true);
            }}
            onProvider={openProviderSettings}
            onDelete={deleteActiveCharacter}
          />
        )}
      </section>

      <ProviderSettings
        open={providerOpen}
        onClose={() => setProviderOpen(false)}
        onConfigurationsChanged={(next) => {
          setConfigurations(next);
          if (!selectedConfigurationId && next[0]) setSelectedConfigurationId(next[0].model_configuration_id);
        }}
      />
      <CharacterImport
        open={importOpen}
        {...(active && view === 'settings' ? { replaceCharacterId: active.character_id } : {})}
        onClose={() => setImportOpen(false)}
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
      <CloudPanel
        open={cloudOpen}
        status={cloud}
        offline={cloudOffline}
        onClose={() => setCloudOpen(false)}
        onStatusChanged={setCloud}
        onLogin={() => {
          setCloudOpen(false);
          openLogin();
        }}
        onProvider={() => {
          setCloudOpen(false);
          openProviderSettings();
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

function TopChrome({ title, muted, onToggleMute, account, cloud, onLogin, onLogout, onCloud }: {
  title?: string; muted?: boolean; onToggleMute?: () => void;
  account?: AnonymousIdentity | null; cloud?: CloudStatus | null;
  onLogin?: () => void; onLogout?: () => void; onCloud?: () => void;
}) {
  const registered = account?.registered ?? account?.identity_type === 'EMAIL';
  return (
    <header className="top-chrome">
      <div className="sms-title"><SmsIcon size={30} /><span><strong>短信</strong>{title && <small>{title}</small>}</span></div>
      <div className="chrome-actions">
        {/* Always reachable, including on the empty state — service status is not a
            chat-only concern. */}
        {onCloud && (
          <button type="button" className="chrome-cloud" onClick={onCloud} aria-label="LiteTavern Cloud 状态">
            {cloud
              ? cloud.quota.source === 'ALPHA'
                ? `Cloud Alpha ${Math.round(cloud.quota.remaining_ratio * 100)}%`
                : cloud.quota.source === 'TRIAL'
                  ? `Cloud 试用 ${cloud.quota.available} 次`
                  : 'LiteTavern Cloud'
              : 'LiteTavern Cloud'}
          </button>
        )}
        <a
          className="chrome-support"
          href={siteHref('/support?source=website&placement=direct')}
        >
          支持 LiteTavern
        </a>
        {account && (
          registered ? (
            <div className="account-chip" title={account.email ?? undefined}>
              <UserRound size={15} />
              <span className="account-email">{account.email}</span>
              <button type="button" className="account-logout" onClick={onLogout}>退出</button>
            </div>
          ) : (
            <button type="button" className="chrome-login" onClick={onLogin} aria-label="登录并同步">
              <UserRound size={16} /> 登录并同步
            </button>
          )
        )}
        {onToggleMute && (
          <button className="chrome-mute" onClick={onToggleMute} aria-label={muted ? '开启音效' : '关闭音效'} aria-pressed={muted}>
            {muted ? <VolumeX size={22} /> : <Volume2 size={22} />}
          </button>
        )}
      </div>
    </header>
  );
}

function ContactRail({ characters, active, tone, onSelect, onImport, onCreate, onMigrate }: {
  characters: Character[]; active: Character | null; tone: 'dark' | 'light';
  onSelect: (character: Character) => void; onImport: () => void; onCreate: () => void;
  onMigrate: () => void;
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
        {!characters.length && <div className="empty-contacts"><MessageCircle size={28} /><strong>还没有联系人</strong><span>先导入你已准备并有权使用的流萤角色卡</span></div>}
      </div>
      <div className="rail-actions">
        <button className="rail-action" onClick={onCreate}><Plus size={21} /> 新建角色</button>
        <button className="rail-action" onClick={onImport}><Upload size={21} /> 导入角色卡</button>
        <button className="rail-action" onClick={onMigrate}><HeartHandshake size={21} /> 迁移角色关系</button>
      </div>
    </aside>
  );
}

function EmptyCharacter({ onImport, onCreate, onMigrate }: { onImport: () => void; onCreate: () => void; onMigrate: () => void }) {
  return (
    <section className="main-paper empty-paper">
      <MessageCircle size={42} />
      <h1>等待第一条短信</h1>
      <p>这里不会预置或杜撰角色。你可以创建自己的角色，也可以导入已准备并有权使用的角色卡。</p>
      <div className="empty-actions">
        <button className="gold-button" onClick={onCreate}><Plus size={19} /> 创建角色</button>
        <button className="secondary-button" aria-label="导入流萤角色卡" onClick={onImport}><Upload size={19} /> 导入角色卡</button>
        <button className="secondary-button" onClick={onMigrate}><HeartHandshake size={19} /> 迁移角色关系</button>
      </div>
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

function ChatPage({ character, messages, draft, sending, error, errorCode, freeQuotaRemaining, freeQuotaEnabled, cloud, usageMode, configurations, selectedConfigurationId, suggestions, suggesting, typing, onProfile, onDraft, onSend, onPick, onEditSubmit, onUsageMode, onConfiguration, onProvider, onCloud }: {
  character: Character; messages: Message[]; draft: string; sending: boolean; error: string | null;
  errorCode: string | null; freeQuotaRemaining: number | null; freeQuotaEnabled: boolean;
  cloud: CloudStatus | null;
  usageMode: 'PLATFORM' | 'BYOK'; configurations: ModelConfiguration[]; selectedConfigurationId: string;
  suggestions: string[]; suggesting: boolean; typing: boolean;
  onProfile: () => void; onDraft: (value: string) => void; onSend: (event: FormEvent) => void; onPick: (text: string) => void;
  onEditSubmit: (messageId: string, text: string) => void;
  onUsageMode: (mode: 'PLATFORM' | 'BYOK') => void; onConfiguration: (id: string) => void; onProvider: () => void;
  onCloud: () => void;
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
  const quotaMessage =
    usageMode === 'PLATFORM' && !freeQuotaEnabled
      ? 'LiteTavern Cloud 平台模型当前已关闭。你可以切换到自己的模型服务继续聊天。'
      : usageMode === 'PLATFORM' && platformExhausted
        ? cloud?.membership_status === 'ALPHA_ACTIVE'
          ? '本期 LiteTavern Cloud Alpha 额度已用完。你可以切换到自己的模型服务继续聊天。'
          : cloud?.registered
            ? '试用额度已用完。你已在 LiteTavern Cloud Alpha 候补名单中，获得资格后即可使用平台额度。也可以切换到自己的模型服务继续聊天。'
            : '试用额度已用完。注册后可加入 LiteTavern Cloud Alpha 候补名单，或切换到自己的模型服务继续聊天。'
        : null;

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
        {quotaMessage && error !== quotaMessage && (
          <div className="quota-notice" role="status">
            <span><CircleAlert size={16} />{quotaMessage}</span>
            <button type="button" onClick={onProvider}>配置自己的模型服务</button>
            <button type="button" onClick={onCloud}>查看 LiteTavern Cloud</button>
            <a href={siteHref('/support?source=website&placement=quota_prompt')}>
              自愿支持 LiteTavern
            </a>
          </div>
        )}
        {(errorCode === 'FREE_QUOTA_EXHAUSTED' ||
          errorCode === 'CLOUD_QUOTA_EXHAUSTED' ||
          errorCode === 'CLOUD_QUOTA_DAILY_LIMIT' ||
          errorCode === 'CLOUD_BUDGET_EXHAUSTED' ||
          errorCode === 'FREE_SERVICE_DISABLED') && (
          <button className="quota-config-link" type="button" onClick={onProvider}>
            配置自己的模型服务
          </button>
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
          <button className={usageMode === 'BYOK' ? 'active' : ''} onClick={() => configurations.length ? onUsageMode('BYOK') : onProvider()}>自带模型</button>
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

function splitTraits(text: string): string[] | null {
  const parts = text
    .split(/[、,，/／·|｜;；]/)
    .map((item) => item.trim().replace(/^[「『"']+|[。.!！「』"']+$/g, '').trim())
    .filter(Boolean);
  if (parts.length >= 2 && parts.length <= 6 && parts.every((part) => part.length <= 8)) return parts;
  return null;
}

function ProfilePage({ character, onChat, onMemories, onSettings }: { character: Character; onChat: () => void; onMemories: () => void; onSettings: () => void }) {
  const traits = character.personality_summary ? splitTraits(character.personality_summary) : null;
  return (
    <section className="main-paper profile-paper">
      <div className="detail-topbar">
        <button className="detail-back" onClick={onChat}><ArrowLeft size={19} /> 返回短信</button>
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

          <nav className="profile-actions">
            <button onClick={onMemories} aria-label="记忆">
              <span className="pa-icon"><Brain size={22} /></span>
              <span className="pa-copy"><strong>记忆</strong><small>与该角色的重要记忆片段</small></span>
              <ChevronRight size={19} />
            </button>
            <button onClick={onSettings} aria-label="角色设置">
              <span className="pa-icon"><Settings size={22} /></span>
              <span className="pa-copy"><strong>角色设置</strong><small>调整短信偏好与回复风格</small></span>
              <ChevronRight size={19} />
            </button>
          </nav>

          <div className="profile-info">
            <section className="info-block">
              <h2>简介</h2>
              <p>{character.profile_summary || '角色卡暂未填写简介。'}</p>
            </section>
            <section className="info-block">
              <h2>核心性格</h2>
              {traits
                ? <div className="trait-chips">{traits.map((trait) => <span key={trait}>{trait}</span>)}</div>
                : <p>{character.personality_summary || '角色卡暂未填写性格描述。'}</p>}
            </section>
            <section className="info-block">
              <h2>关系与共同经历</h2>
              <p className="muted">随着你与{character.name}的对话深入，关系摘要与共同经历会自动沉淀在这里。</p>
            </section>
          </div>
        </div>
      </div>
    </section>
  );
}

interface MemoryItem { memory_id: string; content: string; memory_kind: string; created_at?: string }

function MemoryPage({ character, onBack, onChat }: { character: Character; onBack: () => void; onChat: () => void }) {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  async function load() {
    const result = await api<{ memories: MemoryItem[] }>(`/v1/characters/${character.character_id}/memories`);
    setMemories(result.memories);
  }
  useEffect(() => { void load(); }, [character.character_id]);
  async function remove(memoryId: string) {
    if (!window.confirm('确定删除这条记忆吗？')) return;
    await api(`/v1/memories/${memoryId}`, { method: 'DELETE' });
    await load();
  }
  return (
    <section className="main-paper memory-paper">
      <div className="detail-topbar">
        <button className="detail-back" onClick={onBack}><ArrowLeft size={19} /> 返回资料</button>
        <span className="detail-title">共同回忆</span>
      </div>
      <div className="detail-scroll">
        <div className="detail-column">
          <div className="memory-head">
            <div><h1>共同回忆</h1><p>与{character.name}的特殊回忆</p></div>
            <span className="memory-count">{memories.length}<i>/50</i></span>
          </div>
          {memories.length > 0 ? (
            <>
              <div className="memory-cards">
                {memories.map((memory) => (
                  <article key={memory.memory_id}>
                    <div className="memory-art"><Brain size={36} /></div>
                    <div><h2>{memory.memory_kind || '共同记忆'}</h2><p>{memory.content}</p></div>
                    <time>{memory.created_at ? new Date(memory.created_at).toLocaleDateString('zh-CN') : ''}</time>
                    <button aria-label="删除记忆" onClick={() => void remove(memory.memory_id)}><Trash2 size={19} /></button>
                  </article>
                ))}
              </div>
              <p className="memory-footnote">这些回忆，会帮助你们走向更远的未来。</p>
            </>
          ) : (
            <div className="memory-empty">
              <span className="memory-empty-art"><Brain size={44} /></span>
              <strong>还没有共同回忆</strong>
              <p>与{character.name}的对话里，有意义的片段会自动沉淀成回忆，出现在这里。</p>
              <button className="gold-button" onClick={onChat}><MessageCircle size={18} /> 去聊聊</button>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function SettingRow({ icon, title, description, value, onClick, href, disabled = false }: {
  icon: ReactNode; title: string; description: string; value?: string; onClick?: () => void; href?: string; disabled?: boolean;
}) {
  const content = <>{icon}<span><strong>{title}</strong><small>{description}</small></span>{value && <em>{value}</em>}<ChevronRight /></>;
  if (href) return <a className="setting-row" href={href}>{content}</a>;
  return <button className="setting-row" onClick={onClick} disabled={disabled}>{content}</button>;
}

function CharacterSettingsPage({ character, configurations, onBack, onImport, onMigrate, onEdit, onProvider, onDelete }: {
  character: Character; configurations: ModelConfiguration[]; onBack: () => void; onImport: () => void; onMigrate: () => void; onEdit: () => void; onProvider: () => void; onDelete: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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
    <section className="main-paper settings-paper">
      <div className="detail-topbar">
        <button className="detail-back" onClick={onBack}><ArrowLeft size={19} /> 返回资料</button>
        <span className="detail-title">角色设置</span>
      </div>
      <div className="detail-scroll">
        <div className="detail-column">
          <div className="settings-character">
            <Avatar character={character} className="settings-avatar" />
            <div><h2>{character.name}</h2><p>{character.profile_summary || '角色卡暂未填写简介。'}</p></div>
          </div>
          <div className="settings-groups">
            <label>角色数据</label>
            <section>
              <SettingRow icon={<Pencil />} title="编辑角色设定" description="修改名称、头像、描述与高级角色字段" onClick={onEdit} />
              <SettingRow icon={<Upload />} title="导入角色卡" description="从本地文件更新角色设定与对话数据" onClick={onImport} />
              <SettingRow icon={<Download />} title="导出角色卡" description="将当前角色卡按原始格式导出" href={`/v1/characters/${character.character_id}/export`} />
              <SettingRow icon={<HeartHandshake />} title="迁移角色关系" description="把其他平台整理好的关系、资料与记忆导入这个角色" onClick={onMigrate} />
            </section>
            <label>模型配置</label>
            <section>
              <SettingRow icon={<KeyRound />} title="模型选择" description="选择该角色使用的对话模型" value={configurations[0]?.display_name || 'LiteTavern Cloud 额度'} onClick={onProvider} />
            </section>
            {character.is_owned && (
              <>
                <label>危险操作</label>
                <section>
                  <button className="setting-row setting-row-danger" onClick={() => setConfirming(true)}>
                    <Trash2 className="danger-icon" /><span><strong>删除角色</strong><small>移除该角色及其对话记录，此操作无法撤销</small></span><ChevronRight />
                  </button>
                </section>
              </>
            )}
          </div>
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
