import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  ArrowLeft, Brain, ChevronRight, CircleAlert, Download,
  KeyRound, LoaderCircle, MessageCircle, Send, Settings,
  Trash2, Upload, UserRound
} from 'lucide-react';
import { ProviderSettings } from './components/ProviderSettings';
import { CharacterImport } from './components/CharacterImport';
import { api, streamGeneration, type Character, type Message, type ModelConfiguration } from './lib/api';
import { credentialStore } from './lib/credential-store';
import { createId } from './lib/id';

type View = 'chat' | 'profile' | 'memories' | 'settings';

function avatarUrl(character: Character) {
  return `/v1/characters/${character.character_id}/avatar`;
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
  const [characters, setCharacters] = useState<Character[]>([]);
  const [active, setActive] = useState<Character | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [view, setView] = useState<View>('chat');
  const [providerOpen, setProviderOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [configurations, setConfigurations] = useState<ModelConfiguration[]>([]);
  const [usageMode, setUsageMode] = useState<'PLATFORM' | 'BYOK'>('PLATFORM');
  const [selectedConfigurationId, setSelectedConfigurationId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const started = useRef(false);
  const conversationIdRef = useRef<string | null>(null);
  const suggestAbortRef = useRef<AbortController | null>(null);

  useEffect(() => { conversationIdRef.current = conversationId; }, [conversationId]);

  async function openCharacter(character: Character, nextView: View = 'chat') {
    setActive(character);
    setView(nextView);
    setError(null);
    setSuggestions([]);
    const created = await api<{ conversation_id: string }>('/v1/conversations', {
      method: 'POST', body: JSON.stringify({ character_id: character.character_id })
    });
    setConversationId(created.conversation_id);
    const response = await api<{ messages: Message[] }>(`/v1/conversations/${created.conversation_id}/messages`);
    setMessages(response.messages);
    if (response.messages.length > 0) void loadSuggestions(created.conversation_id);
  }

  async function refreshCharacters(openImported = false) {
    const response = await api<{ characters: Character[] }>('/v1/characters');
    setCharacters(response.characters);
    if (openImported && response.characters[0]) {
      const next = response.characters.find((item) => item.character_id === active?.character_id) ?? response.characters[0];
      await openCharacter(next, active ? 'settings' : 'chat');
    }
  }

  async function bootstrap() {
    await api('/v1/identities/anonymous', { method: 'POST' });
    const [characterResponse, configurationResponse] = await Promise.all([
      api<{ characters: Character[] }>('/v1/characters'),
      api<{ configurations: ModelConfiguration[] }>('/v1/model-configurations')
    ]);
    setCharacters(characterResponse.characters);
    setConfigurations(configurationResponse.configurations);
    if (configurationResponse.configurations[0]) {
      setSelectedConfigurationId(configurationResponse.configurations[0].model_configuration_id);
    }
    if (characterResponse.characters[0]) await openCharacter(characterResponse.characters[0]);
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void bootstrap().catch((reason: Error) => setError(reason.message));
  }, []);

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

  async function submit(rawText: string) {
    const text = rawText.trim();
    if (!text || !conversationId || sending) return;
    const targetConversationId = conversationId;
    setDraft('');
    setSuggestions([]);
    setError(null);
    setSending(true);
    const userMessage: Message = { message_id: createId(), role: 'USER', content_text: text, status: 'COMPLETED' };
    const assistantId = createId();
    setMessages((current) => [...current, userMessage, { message_id: assistantId, role: 'ASSISTANT', content_text: '', status: 'STREAMING' }]);
    try {
      const selector = await resolveModelSelector();
      const payload = { ...selector, input: { type: 'text', text } };
      await streamGeneration(targetConversationId, payload, (delta) => setMessages((current) => current.map((message) => (
        message.message_id === assistantId ? { ...message, content_text: message.content_text + delta } : message
      ))));
      setMessages((current) => current.map((message) => (
        message.message_id === assistantId ? { ...message, status: 'COMPLETED' } : message
      )));
      void loadSuggestions(targetConversationId);
    } catch (reason) {
      setMessages((current) => current.filter((message) => message.message_id !== assistantId));
      setError(reason instanceof Error ? reason.message : '发送失败。');
    } finally {
      setSending(false);
    }
  }

  function send(event: FormEvent) {
    event.preventDefault();
    void submit(draft);
  }

  const contactRail = (
    <ContactRail
      characters={characters}
      active={active}
      tone={view === 'chat' ? 'dark' : 'light'}
      onSelect={(character) => void openCharacter(character)}
      onImport={() => setImportOpen(true)}
    />
  );

  return (
    <main className={`hsr-app view-${view}`}>
      <div className="scene-glow scene-glow-one" />
      <div className="scene-glow scene-glow-two" />
      <TopChrome {...(view === 'memories' && active ? { title: `与${active.name}的回忆` } : view === 'settings' ? { title: 'PomChat' } : {})} />

      <section className="hsr-stage">
        {view === 'chat' && contactRail}
        {!active ? (
          <EmptyCharacter onImport={() => setImportOpen(true)} />
        ) : view === 'chat' ? (
          <ChatPage
            character={active} messages={messages} draft={draft} sending={sending} error={error}
            usageMode={usageMode} configurations={configurations} selectedConfigurationId={selectedConfigurationId}
            suggestions={suggestions} suggesting={suggesting}
            onProfile={() => setView('profile')} onDraft={setDraft} onSend={send} onPick={(text) => void submit(text)}
            onUsageMode={setUsageMode} onConfiguration={setSelectedConfigurationId}
            onProvider={() => setProviderOpen(true)}
          />
        ) : view === 'profile' ? (
          <ProfilePage character={active} onChat={() => setView('chat')} onMemories={() => setView('memories')} onSettings={() => setView('settings')} />
        ) : view === 'memories' ? (
          <MemoryPage character={active} onBack={() => setView('profile')} onChat={() => setView('chat')} />
        ) : (
          <CharacterSettingsPage
            character={active} configurations={configurations}
            onBack={() => setView('profile')} onImport={() => setImportOpen(true)} onProvider={() => setProviderOpen(true)}
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

function TopChrome({ title }: { title?: string }) {
  return (
    <header className="top-chrome">
      <div className="sms-title"><SmsIcon size={30} /><span><strong>短信</strong>{title && <small>{title}</small>}</span></div>
    </header>
  );
}

function ContactRail({ characters, active, tone, onSelect, onImport }: {
  characters: Character[]; active: Character | null; tone: 'dark' | 'light';
  onSelect: (character: Character) => void; onImport: () => void;
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
      <button className="rail-action" onClick={onImport}><Upload size={21} /> 导入角色卡</button>
    </aside>
  );
}

function EmptyCharacter({ onImport }: { onImport: () => void }) {
  return (
    <section className="main-paper empty-paper">
      <MessageCircle size={42} />
      <h1>等待第一条短信</h1>
      <p>这里不会预置或杜撰角色。导入你已准备并有权使用的流萤角色卡后，头像、设定与开场消息会来自卡片本身。</p>
      <button className="gold-button" onClick={onImport}><Upload size={19} /> 导入流萤角色卡</button>
    </section>
  );
}

function ChatPage({ character, messages, draft, sending, error, usageMode, configurations, selectedConfigurationId, suggestions, suggesting, onProfile, onDraft, onSend, onPick, onUsageMode, onConfiguration, onProvider }: {
  character: Character; messages: Message[]; draft: string; sending: boolean; error: string | null;
  usageMode: 'PLATFORM' | 'BYOK'; configurations: ModelConfiguration[]; selectedConfigurationId: string;
  suggestions: string[]; suggesting: boolean;
  onProfile: () => void; onDraft: (value: string) => void; onSend: (event: FormEvent) => void; onPick: (text: string) => void;
  onUsageMode: (mode: 'PLATFORM' | 'BYOK') => void; onConfiguration: (id: string) => void; onProvider: () => void;
}) {
  const lastLine = [...messages].reverse().find((message) => message.role === 'ASSISTANT' && message.content_text.trim())?.content_text
    || character.first_message || character.profile_summary || '角色档案';
  return (
    <section className="main-paper chat-paper">
      <button className="chat-heading" onClick={onProfile} aria-label={`打开${character.name}档案`}>
        <strong>{character.name}</strong><small>{lastLine}</small>
      </button>
      <div className="chat-messages">
        {messages.map((message) => (
          <div key={message.message_id} className={`hsr-message ${message.role === 'USER' ? 'from-user' : 'from-character'}`}>
            {message.role === 'ASSISTANT' && <Avatar character={character} />}
            <div className="message-body">
              {message.role === 'ASSISTANT' && <span className="message-name">{character.name}</span>}
              <div className="message-bubble">{message.content_text || <span className="typing"><i /><i /><i /></span>}</div>
            </div>
            {message.role === 'USER' && <span className="user-avatar"><UserRound size={26} /></span>}
          </div>
        ))}
        {!messages.length && <div className="chat-placeholder">开始你们的第一段对话。</div>}
        {error && <p className="inline-error"><CircleAlert size={17} />{error}</p>}
      </div>
      <footer className="reply-area">
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
          <button className={usageMode === 'PLATFORM' ? 'active' : ''} onClick={() => onUsageMode('PLATFORM')}>官方额度</button>
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
          <button disabled={!draft.trim() || sending} aria-label="发送消息">{sending ? <LoaderCircle className="spin" size={20} /> : '发送'}</button>
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

function CharacterSettingsPage({ character, configurations, onBack, onImport, onProvider }: {
  character: Character; configurations: ModelConfiguration[]; onBack: () => void; onImport: () => void; onProvider: () => void;
}) {
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
              <SettingRow icon={<Upload />} title="导入角色卡" description="从本地文件更新角色设定与对话数据" onClick={onImport} />
              <SettingRow icon={<Download />} title="导出角色卡" description="将当前角色卡按原始格式导出" href={`/v1/characters/${character.character_id}/export`} />
            </section>
            <label>模型配置</label>
            <section>
              <SettingRow icon={<KeyRound />} title="模型选择" description="选择该角色使用的对话模型" value={configurations[0]?.display_name || 'PomChat 官方额度'} onClick={onProvider} />
            </section>
          </div>
        </div>
      </div>
    </section>
  );
}
