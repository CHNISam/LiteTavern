import { useEffect, useState } from 'react';
import {
  Check, CircleAlert, Copy, FileJson, Info, LoaderCircle, Trash2, TriangleAlert, Upload, X
} from 'lucide-react';
import { ApiError, api, type Character } from '../lib/api';
import { analytics } from '../lib/analytics';
import { copyText } from '../lib/clipboard';
import {
  DIRECT_MIGRATION_PROMPT, MERGE_MIGRATION_PROMPT, memoryCountBucket
} from '../lib/migration-prompts';

const MAX_FILE_BYTES = 1024 * 1024;

type Step = 'intro' | 'input' | 'review' | 'confirm';

export interface ImportIssue {
  severity: 'FATAL' | 'WARNING' | 'INFO';
  code: string;
  path: string;
  message: string;
}

interface PreviewMemory {
  key: string;
  content: string;
  importance: number;
  approximate_time: string | null;
  tags: string[];
  evidence_summary: string;
  duplicate_of?: string;
}

interface PreviewData {
  character: {
    name: string;
    description: string;
    personality_traits: string[];
    speaking_style: string[];
  };
  user_profile: {
    preferred_name: string;
    facts: string[];
    preferences: string[];
    boundaries: string[];
  };
  relationship: { summary: string; stage: string; interaction_patterns: string[] };
  memories: PreviewMemory[];
  unfinished_threads: string[];
  uncertain_items: { content: string; reason: string }[];
  source_metadata: {
    source_platform: string;
    character_name_on_source: string;
    processed_at: string;
    notes: string;
  };
}

interface ValidateResponse {
  valid: boolean;
  import_id: string | null;
  issues: ImportIssue[];
  preview: PreviewData | null;
  unknown_fields: string[];
}

interface CommitResponse {
  import_id: string;
  character_id: string;
  conversation_id: string;
  created_character: boolean;
  memories_written: number;
  already_committed: boolean;
}

const SEVERITY_LABEL = { FATAL: '错误', WARNING: '警告', INFO: '提示' } as const;

function CopyButton({ label, text, onCopied }: {
  label: string; text: string; onCopied: () => void;
}) {
  const [copied, setCopied] = useState(false);
  async function run() {
    if (!(await copyText(text))) return;
    setCopied(true);
    onCopied();
    window.setTimeout(() => setCopied(false), 1600);
  }
  return (
    <button type="button" className="secondary-button" onClick={() => void run()}>
      {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? '已复制' : label}
    </button>
  );
}

function ListField({ label, items, onChange }: {
  label: string; items: string[]; onChange: (next: string[]) => void;
}) {
  return (
    <label>
      {label}（每行一条）
      <textarea
        aria-label={label}
        rows={Math.min(6, Math.max(2, items.length + 1))}
        value={items.join('\n')}
        onChange={(event) => onChange(event.target.value.split('\n').map((item) => item.trim()).filter(Boolean))}
      />
    </label>
  );
}

function IssueList({ issues }: { issues: ImportIssue[] }) {
  if (!issues.length) return null;
  return (
    <ul className="import-issues">
      {issues.map((issue, index) => (
        <li key={`${issue.code}-${issue.path}-${index}`} className={`issue-${issue.severity.toLowerCase()}`}>
          {issue.severity === 'FATAL'
            ? <CircleAlert size={15} />
            : issue.severity === 'WARNING' ? <TriangleAlert size={15} /> : <Info size={15} />}
          <span>
            <strong>{SEVERITY_LABEL[issue.severity]}</strong>
            {issue.path && <code>{issue.path}</code>}
            {issue.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function RelationshipImport({ open, characters, defaultCharacterId, onClose, onImported }: {
  open: boolean;
  characters: Character[];
  defaultCharacterId?: string;
  onClose: () => void;
  onImported: (result: CommitResponse) => Promise<void>;
}) {
  const [step, setStep] = useState<Step>('intro');
  const [rawText, setRawText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<ImportIssue[]>([]);
  const [importId, setImportId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PreviewData | null>(null);
  const [skipped, setSkipped] = useState<Record<string, boolean>>({});
  const [keepUncertain, setKeepUncertain] = useState(true);
  const [mode, setMode] = useState<'CREATE' | 'EXISTING'>('CREATE');
  const [targetId, setTargetId] = useState('');
  const [updateExisting, setUpdateExisting] = useState(false);

  // Only characters the caller owns can receive an import; platform characters are
  // never offered as a target.
  const ownedCharacters = characters.filter((character) => character.is_owned);

  useEffect(() => {
    if (!open) return;
    setStep('intro');
    setRawText('');
    setFileName(null);
    setError(null);
    setIssues([]);
    setImportId(null);
    setDraft(null);
    setSkipped({});
    setKeepUncertain(true);
    setUpdateExisting(false);
    const preselected = defaultCharacterId
      && ownedCharacters.some((character) => character.character_id === defaultCharacterId);
    setMode(preselected ? 'EXISTING' : 'CREATE');
    setTargetId(preselected ? defaultCharacterId : (ownedCharacters[0]?.character_id ?? ''));
    analytics.criticalAction('relationship_import_opened', 'relationship_import', {
      result: 'attempted'
    });
    // Deliberately keyed on open/defaultCharacterId only: re-running whenever the
    // character list changes would wipe an import the user is halfway through.
  }, [open, defaultCharacterId]);

  // Only counts, buckets and the chosen branch are tracked. No JSON, character
  // setup, user profile, relationship summary, memory or uncertain-item content
  // ever reaches analytics.
  function track(action: string, result: string, extra: Record<string, string> = {}) {
    analytics.criticalAction(action, 'relationship_import', { result, properties: extra });
  }

  async function readFile(file: File | null) {
    setError(null);
    if (!file) return;
    const isJson = file.name.toLowerCase().endsWith('.json')
      || file.type === 'application/json';
    if (!isJson) {
      setError('只支持 .json 文件。请上传外部模型输出的标准 JSON，不要上传原始聊天记录。');
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError(`文件为 ${Math.round(file.size / 1024)} KB，超过 ${MAX_FILE_BYTES / 1024} KB 上限。`);
      return;
    }
    setFileName(file.name);
    setRawText(await file.text());
  }

  async function validate() {
    setBusy(true);
    setError(null);
    track('relationship_import_validate_started', 'attempted');
    try {
      const response = await api<ValidateResponse>('/v1/relationship-imports/validate', {
        method: 'POST',
        body: JSON.stringify({ raw_text: rawText })
      });
      setIssues(response.issues);
      if (!response.valid || !response.preview || !response.import_id) {
        track('relationship_import_validated', 'failure');
        setStep('review');
        setDraft(null);
        return;
      }
      setImportId(response.import_id);
      setDraft(response.preview);
      setSkipped({});
      setStep('review');
      track('relationship_import_validated', 'success', {
        memory_count_bucket: memoryCountBucket(response.preview.memories.length)
      });
    } catch (reason) {
      const message = reason instanceof ApiError ? reason.message : '校验失败，请稍后重试。';
      setError(message);
      track('relationship_import_validated', 'failure');
    } finally {
      setBusy(false);
    }
  }

  const selectedMemories = draft?.memories.filter((memory) => !skipped[memory.key]) ?? [];

  async function commit() {
    if (!draft || !importId) return;
    setBusy(true);
    setError(null);
    track('relationship_import_submitted', 'attempted', {
      import_target: mode === 'CREATE' ? 'new_character' : 'existing_character',
      memory_count_bucket: memoryCountBucket(selectedMemories.length)
    });
    try {
      const response = await api<CommitResponse>('/v1/relationship-imports/commit', {
        method: 'POST',
        body: JSON.stringify({
          import_id: importId,
          mode,
          ...(mode === 'EXISTING' ? { character_id: targetId } : {}),
          update_existing_character: mode === 'EXISTING' && updateExisting,
          keep_uncertain_items: keepUncertain,
          payload: {
            ...draft,
            memories: selectedMemories.map((memory) => ({
              content: memory.content,
              importance: memory.importance,
              approximate_time: memory.approximate_time,
              tags: memory.tags,
              evidence_summary: memory.evidence_summary
            }))
          }
        })
      });
      track('relationship_import_completed', 'success', {
        import_target: response.created_character ? 'new_character' : 'existing_character',
        memory_count_bucket: memoryCountBucket(response.memories_written)
      });
      await onImported(response);
      onClose();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : '导入失败，请稍后重试。');
      track('relationship_import_completed', 'failure');
    } finally {
      setBusy(false);
    }
  }

  function editDraft(patch: Partial<PreviewData>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }

  function editMemory(key: string, patch: Partial<PreviewMemory>) {
    setDraft((current) => current && {
      ...current,
      memories: current.memories.map((memory) => (memory.key === key ? { ...memory, ...patch } : memory))
    });
  }

  function removeMemory(key: string) {
    setDraft((current) => current && {
      ...current,
      memories: current.memories.filter((memory) => memory.key !== key)
    });
  }

  if (!open) return null;
  const targetName = mode === 'CREATE'
    ? draft?.character.name
    : ownedCharacters.find((item) => item.character_id === targetId)?.name;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section
        className="settings-panel migration-panel"
        role="dialog"
        aria-modal="true"
        aria-label="迁移角色关系"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <div><span className="eyebrow">角色数据</span><h2>迁移角色关系</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={19} /></button>
        </header>

        <div className="migration-content">
          {step === 'intro' && (
            <>
              <ol className="migration-steps">
                <li>PomChat 不会读取你在豆包、星野、猫箱等平台的账号，也不会代你抓取任何数据。</li>
                <li>请自行从原平台取得聊天记录。</li>
                <li>复制下面的迁移 Prompt，在你自己使用的 ChatGPT / Claude / Gemini 等模型里整理这段记录。</li>
                <li>PomChat 只接收整理后的结构化 JSON，原始聊天内容不需要上传到 PomChat。</li>
                <li>外部 AI 平台可能会接触到你提交的聊天内容，请自行判断隐私风险。</li>
              </ol>
              <div className="migration-actions">
                <CopyButton
                  label="复制直接迁移 Prompt"
                  text={DIRECT_MIGRATION_PROMPT}
                  onCopied={() => track('relationship_import_prompt_copied', 'success', { prompt_kind: 'direct' })}
                />
                <CopyButton
                  label="复制分批合并 Prompt"
                  text={MERGE_MIGRATION_PROMPT}
                  onCopied={() => track('relationship_import_prompt_copied', 'success', { prompt_kind: 'merge' })}
                />
              </div>
              <button className="primary-button" onClick={() => setStep('input')}>进入导入</button>
              <p className="privacy-footnote">
                迁移不需要配置 API Key，PomChat 全流程不调用外部模型，也不会承担你的整理费用。
              </p>
            </>
          )}

          {step === 'input' && (
            <>
              <label className="drop-zone">
                <input
                  aria-label="选择迁移 JSON 文件"
                  type="file"
                  accept=".json,application/json"
                  onChange={(event) => void readFile(event.target.files?.[0] ?? null)}
                />
                <Upload size={24} />
                <strong>{fileName ?? '选择整理后的 .json 文件'}</strong>
                <span>只接受 .json，最大 {MAX_FILE_BYTES / 1024} KB；不要上传原始聊天记录</span>
              </label>
              <label>
                或直接粘贴 JSON
                <textarea
                  aria-label="粘贴迁移 JSON"
                  rows={10}
                  value={rawText}
                  placeholder='{"schema_version": "pomchat_relationship_import_v1", ...}'
                  onChange={(event) => { setRawText(event.target.value); setFileName(null); }}
                />
              </label>
              {error && <p className="inline-error">{error}</p>}
              <div className="migration-actions">
                <button className="secondary-button" onClick={() => setStep('intro')}>返回说明</button>
                <button
                  className="primary-button"
                  disabled={busy || !rawText.trim()}
                  onClick={() => void validate()}
                >
                  {busy ? <LoaderCircle className="spin" size={17} /> : <FileJson size={17} />} 校验数据
                </button>
              </div>
            </>
          )}

          {step === 'review' && (
            <>
              <IssueList issues={issues} />
              {error && <p className="inline-error">{error}</p>}
              {!draft ? (
                <div className="migration-actions">
                  <button className="primary-button" onClick={() => setStep('input')}>返回修改 JSON</button>
                </div>
              ) : (
                <>
                  <div className="editor-section">
                    <h3>角色</h3>
                    <label>角色名称<input aria-label="角色名称" value={draft.character.name} maxLength={200} onChange={(event) => editDraft({ character: { ...draft.character, name: event.target.value } })} /></label>
                    <label>角色描述<textarea aria-label="角色描述" rows={4} value={draft.character.description} onChange={(event) => editDraft({ character: { ...draft.character, description: event.target.value } })} /></label>
                    <ListField label="性格特征" items={draft.character.personality_traits} onChange={(next) => editDraft({ character: { ...draft.character, personality_traits: next } })} />
                    <ListField label="说话风格" items={draft.character.speaking_style} onChange={(next) => editDraft({ character: { ...draft.character, speaking_style: next } })} />
                  </div>

                  <div className="editor-section">
                    <h3>你的资料</h3>
                    <label>角色对你的称呼<input aria-label="角色对你的称呼" value={draft.user_profile.preferred_name} onChange={(event) => editDraft({ user_profile: { ...draft.user_profile, preferred_name: event.target.value } })} /></label>
                    <ListField label="用户事实" items={draft.user_profile.facts} onChange={(next) => editDraft({ user_profile: { ...draft.user_profile, facts: next } })} />
                    <ListField label="用户偏好" items={draft.user_profile.preferences} onChange={(next) => editDraft({ user_profile: { ...draft.user_profile, preferences: next } })} />
                    <ListField label="互动边界" items={draft.user_profile.boundaries} onChange={(next) => editDraft({ user_profile: { ...draft.user_profile, boundaries: next } })} />
                  </div>

                  <div className="editor-section">
                    <h3>关系</h3>
                    <label>关系摘要<textarea aria-label="关系摘要" rows={4} value={draft.relationship.summary} onChange={(event) => editDraft({ relationship: { ...draft.relationship, summary: event.target.value } })} /></label>
                    <label>当前关系阶段<input aria-label="当前关系阶段" value={draft.relationship.stage} onChange={(event) => editDraft({ relationship: { ...draft.relationship, stage: event.target.value } })} /></label>
                    <ListField label="互动模式" items={draft.relationship.interaction_patterns} onChange={(next) => editDraft({ relationship: { ...draft.relationship, interaction_patterns: next } })} />
                    <ListField label="未完成事项" items={draft.unfinished_threads} onChange={(next) => editDraft({ unfinished_threads: next })} />
                  </div>

                  <div className="editor-section">
                    <h3>长期记忆（{selectedMemories.length}/{draft.memories.length}）</h3>
                    {draft.memories.map((memory) => (
                      <article key={memory.key} className={`migration-memory ${skipped[memory.key] ? 'is-skipped' : ''}`}>
                        <div className="memory-toolbar">
                          <label className="memory-toggle">
                            <input
                              type="checkbox"
                              aria-label={`导入记忆 ${memory.key}`}
                              checked={!skipped[memory.key]}
                              onChange={(event) => setSkipped((current) => ({ ...current, [memory.key]: !event.target.checked }))}
                            />
                            导入这条
                          </label>
                          <label className="memory-importance">
                            重要度 {memory.importance}
                            <input
                              type="range"
                              aria-label={`记忆 ${memory.key} 重要度`}
                              min={1}
                              max={10}
                              value={memory.importance}
                              onChange={(event) => editMemory(memory.key, { importance: Number(event.target.value) })}
                            />
                          </label>
                          <button type="button" aria-label={`删除记忆 ${memory.key}`} onClick={() => removeMemory(memory.key)}>
                            <Trash2 size={16} />
                          </button>
                        </div>
                        <textarea
                          aria-label={`记忆 ${memory.key} 内容`}
                          rows={2}
                          value={memory.content}
                          onChange={(event) => editMemory(memory.key, { content: event.target.value })}
                        />
                        <small>
                          {memory.approximate_time ?? '时间未知'}
                          {memory.tags.length > 0 && ` · ${memory.tags.join('、')}`}
                          {memory.duplicate_of && ' · 与前面某条内容重复'}
                        </small>
                      </article>
                    ))}
                    {!draft.memories.length && <p className="muted">这份数据没有长期记忆。</p>}
                  </div>

                  {draft.uncertain_items.length > 0 && (
                    <div className="editor-section">
                      <h3>不确定信息（{draft.uncertain_items.length}）</h3>
                      <p className="muted">这些内容默认不会写入正式记忆。你可以在这里修改，或把它保留在迁移记录里以后再看。</p>
                      {draft.uncertain_items.map((item, index) => (
                        <article key={`uncertain-${index}`} className="migration-memory">
                          <textarea
                            aria-label={`不确定信息 ${index + 1}`}
                            rows={2}
                            value={item.content}
                            onChange={(event) => editDraft({
                              uncertain_items: draft.uncertain_items.map((entry, position) => (
                                position === index ? { ...entry, content: event.target.value } : entry
                              ))
                            })}
                          />
                          <small>{item.reason || '未说明原因'}</small>
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => {
                              editDraft({
                                uncertain_items: draft.uncertain_items.filter((_, position) => position !== index),
                                memories: [
                                  ...draft.memories,
                                  {
                                    key: `u${index}-${draft.memories.length}`,
                                    content: item.content,
                                    importance: 5,
                                    approximate_time: null,
                                    tags: [],
                                    evidence_summary: ''
                                  }
                                ]
                              });
                            }}
                          >
                            转为正式记忆
                          </button>
                        </article>
                      ))}
                      <label className="memory-toggle">
                        <input
                          type="checkbox"
                          checked={keepUncertain}
                          onChange={(event) => setKeepUncertain(event.target.checked)}
                        />
                        保留在迁移记录中，供以后查看
                      </label>
                    </div>
                  )}

                  <div className="migration-actions">
                    <button className="secondary-button" onClick={() => setStep('input')}>返回修改 JSON</button>
                    <button
                      className="primary-button"
                      disabled={!draft.character.name.trim() || !draft.relationship.summary.trim()}
                      onClick={() => setStep('confirm')}
                    >
                      下一步：确认导入
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {step === 'confirm' && draft && (
            <>
              <div className="editor-section">
                <h3>导入到</h3>
                <label className="memory-toggle">
                  <input type="radio" name="import-mode" checked={mode === 'CREATE'} onChange={() => setMode('CREATE')} />
                  创建新角色「{draft.character.name}」
                </label>
                <label className="memory-toggle">
                  <input
                    type="radio"
                    name="import-mode"
                    checked={mode === 'EXISTING'}
                    disabled={!ownedCharacters.length}
                    onChange={() => setMode('EXISTING')}
                  />
                  导入到我已有的角色
                </label>
                {mode === 'EXISTING' && (
                  <>
                    <select aria-label="选择已有角色" value={targetId} onChange={(event) => setTargetId(event.target.value)}>
                      {ownedCharacters.map((character) => (
                        <option key={character.character_id} value={character.character_id}>{character.name}</option>
                      ))}
                    </select>
                    <label className="memory-toggle">
                      <input
                        type="checkbox"
                        checked={updateExisting}
                        onChange={(event) => setUpdateExisting(event.target.checked)}
                      />
                      同时用迁移资料覆盖该角色的名称、描述与性格
                    </label>
                  </>
                )}
                {!ownedCharacters.length && <p className="muted">你还没有自己创建的角色，只能创建新角色。</p>}
              </div>

              <ul className="migration-summary">
                <li>将{mode === 'CREATE' ? '创建' : updateExisting ? '更新' : '沿用'} 1 个角色{targetName ? `：${targetName}` : ''}</li>
                <li>将写入 {selectedMemories.length} 条长期记忆</li>
                <li>将更新 1 份关系摘要</li>
                <li>将保留 {keepUncertain ? draft.uncertain_items.length : 0} 条不确定信息</li>
                <li>将创建 1 个新的 PomChat 会话</li>
              </ul>
              <p className="privacy-footnote">
                旧平台的聊天记录不会被伪造成 PomChat 的历史消息，新会话只会有一条迁移说明。
              </p>
              {error && <p className="inline-error">{error}</p>}
              <div className="migration-actions">
                <button className="secondary-button" onClick={() => setStep('review')}>返回修改</button>
                <button
                  className="primary-button"
                  disabled={busy || (mode === 'EXISTING' && !targetId)}
                  onClick={() => void commit()}
                >
                  {busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />} 确认导入
                </button>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
