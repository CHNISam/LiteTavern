import { useEffect, useState } from 'react';
import {
  Check, CircleAlert, Copy, FileJson, Info, LoaderCircle, Trash2, TriangleAlert, Upload, X
} from 'lucide-react';
import { ApiError, api, type Character } from '../lib/api';
import { EMPTY_CHARACTER, type CharacterModel } from '../lib/character-card';
import { analytics } from '../lib/analytics';
import { copyText } from '../lib/clipboard';
import { t } from '../lib/i18n';
import {
  UNIFIED_RELATIONSHIP_MIGRATION_PROMPT, memoryCountBucket
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
  relationship: {
    summary: string;
    stage: string;
    user_addressing: string[];
    interaction_patterns: string[];
  };
  memories: PreviewMemory[];
  unfinished_threads: string[];
  uncertain_items: { content: string; reason: string }[];
  source_metadata: {
    source_platform: string;
    character_name_on_source: string;
    processed_at: string | null;
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

const severityLabel = () => t().migration.severity;

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
      {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? t().migration.copied : label}
    </button>
  );
}

function ListField({ label, items, onChange }: {
  label: string; items: string[]; onChange: (next: string[]) => void;
}) {
  return (
    <label>
      {t().migration.perLine(label)}
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
            <strong>{severityLabel()[issue.severity]}</strong>
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
  onImported: (result: CommitResponse, localCharacter?: CharacterModel) => Promise<void>;
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
      setError(t().migration.jsonOnly);
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError(t().migration.tooLarge(Math.round(file.size / 1024), MAX_FILE_BYTES / 1024));
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
      const message = reason instanceof ApiError ? reason.message : t().migration.validateFailed;
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
            character: draft.character,
            user_profile: draft.user_profile,
            relationship: draft.relationship,
            memories: selectedMemories.map((memory) => ({
              content: memory.content,
              importance: memory.importance,
              approximate_time: memory.approximate_time,
              tags: memory.tags,
              evidence_summary: memory.evidence_summary
            })),
            unfinished_threads: draft.unfinished_threads,
            uncertain_items: draft.uncertain_items,
            source_metadata: draft.source_metadata,
            schema_version: 'litetavern_relationship_import_v1'
          }
        })
      });
      track('relationship_import_completed', 'success', {
        import_target: response.created_character ? 'new_character' : 'existing_character',
        memory_count_bucket: memoryCountBucket(response.memories_written)
      });
      const shouldSaveLocalCharacter = mode === 'CREATE' || updateExisting;
      const localCharacter: CharacterModel | undefined = shouldSaveLocalCharacter
        ? {
            ...EMPTY_CHARACTER,
            name: draft.character.name,
            description: draft.character.description,
            personality: [
              draft.character.personality_traits.length
                ? `Personality: ${draft.character.personality_traits.join(', ')}` : '',
              draft.character.speaking_style.length
                ? `Speaking style: ${draft.character.speaking_style.join(', ')}` : ''
            ].filter(Boolean).join('\n')
          }
        : undefined;
      await onImported(response, localCharacter);
      onClose();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : t().migration.importFailed);
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
        aria-label={t().migration.dialogLabel}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="settings-header">
          <div><span className="eyebrow">{t().migration.eyebrow}</span><h2>{t().migration.title}</h2></div>
          <button className="icon-button" onClick={onClose} aria-label={t().common.close}><X size={19} /></button>
        </header>

        <div className="migration-content">
          {step === 'intro' && (
            <>
              <ol className="migration-steps">
                <li>{t().migration.steps.noAccountAccess}</li>
                <li>{t().migration.steps.exportYourself}</li>
                <li>{t().migration.steps.usePrompt}</li>
                <li>{t().migration.steps.structuredOnly}</li>
                <li>{t().migration.steps.privacyRisk}</li>
              </ol>
              <div className="migration-actions">
                <CopyButton
                  label={t().migration.copyPrompt}
                  text={UNIFIED_RELATIONSHIP_MIGRATION_PROMPT}
                  onCopied={() => track('relationship_import_prompt_copied', 'success', { prompt_kind: 'unified' })}
                />
              </div>
              <button className="primary-button" onClick={() => setStep('input')}>{t().migration.enterImport}</button>
              <p className="privacy-footnote">
                {t().migration.noKeyNeeded}
              </p>
            </>
          )}

          {step === 'input' && (
            <>
              <label className="drop-zone">
                <input
                  aria-label={t().migration.chooseFileAria}
                  type="file"
                  accept=".json,application/json"
                  onChange={(event) => void readFile(event.target.files?.[0] ?? null)}
                />
                <Upload size={24} />
                <strong>{fileName ?? t().migration.choosePlaceholder}</strong>
                <span>{t().migration.fileHint(MAX_FILE_BYTES / 1024)}</span>
              </label>
              <label>
                {t().migration.orPaste}
                <textarea
                  aria-label={t().migration.pasteAria}
                  rows={10}
                  value={rawText}
                  placeholder='{"schema_version": "litetavern_relationship_import_v1", ...}'
                  onChange={(event) => { setRawText(event.target.value); setFileName(null); }}
                />
              </label>
              {error && <p className="inline-error">{error}</p>}
              <div className="migration-actions">
                <button className="secondary-button" onClick={() => setStep('intro')}>{t().migration.backToIntro}</button>
                <button
                  className="primary-button"
                  disabled={busy || !rawText.trim()}
                  onClick={() => void validate()}
                >
                  {busy ? <LoaderCircle className="spin" size={17} /> : <FileJson size={17} />} {t().migration.validate}
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
                  <button className="primary-button" onClick={() => setStep('input')}>{t().migration.backToJson}</button>
                </div>
              ) : (
                <>
                  <div className="editor-section">
                    <h3>{t().migration.sectionCharacter}</h3>
                    <label>{t().migration.characterName}<input aria-label={t().migration.characterName} value={draft.character.name} maxLength={200} onChange={(event) => editDraft({ character: { ...draft.character, name: event.target.value } })} /></label>
                    <label>{t().migration.characterDescription}<textarea aria-label={t().migration.characterDescription} rows={4} value={draft.character.description} onChange={(event) => editDraft({ character: { ...draft.character, description: event.target.value } })} /></label>
                    <ListField label={t().migration.personalityTraits} items={draft.character.personality_traits} onChange={(next) => editDraft({ character: { ...draft.character, personality_traits: next } })} />
                    <ListField label={t().migration.speakingStyle} items={draft.character.speaking_style} onChange={(next) => editDraft({ character: { ...draft.character, speaking_style: next } })} />
                  </div>

                  <div className="editor-section">
                    <h3>{t().migration.sectionYou}</h3>
                    <label>{t().migration.preferredName}<input aria-label={t().migration.preferredName} value={draft.user_profile.preferred_name} onChange={(event) => editDraft({ user_profile: { ...draft.user_profile, preferred_name: event.target.value } })} /></label>
                    <ListField label={t().migration.userFacts} items={draft.user_profile.facts} onChange={(next) => editDraft({ user_profile: { ...draft.user_profile, facts: next } })} />
                    <ListField label={t().migration.userPreferences} items={draft.user_profile.preferences} onChange={(next) => editDraft({ user_profile: { ...draft.user_profile, preferences: next } })} />
                    <ListField label={t().migration.boundaries} items={draft.user_profile.boundaries} onChange={(next) => editDraft({ user_profile: { ...draft.user_profile, boundaries: next } })} />
                  </div>

                  <div className="editor-section">
                    <h3>{t().migration.sectionRelationship}</h3>
                    <label>{t().migration.relationshipSummary}<textarea aria-label={t().migration.relationshipSummary} rows={4} value={draft.relationship.summary} onChange={(event) => editDraft({ relationship: { ...draft.relationship, summary: event.target.value } })} /></label>
                    <label>{t().migration.relationshipStage}<input aria-label={t().migration.relationshipStage} value={draft.relationship.stage} onChange={(event) => editDraft({ relationship: { ...draft.relationship, stage: event.target.value } })} /></label>
                    <ListField label={t().migration.userAddressing} items={draft.relationship.user_addressing} onChange={(next) => editDraft({ relationship: { ...draft.relationship, user_addressing: next } })} />
                    <ListField label={t().migration.interactionPatterns} items={draft.relationship.interaction_patterns} onChange={(next) => editDraft({ relationship: { ...draft.relationship, interaction_patterns: next } })} />
                    <ListField label={t().migration.unfinishedThreads} items={draft.unfinished_threads} onChange={(next) => editDraft({ unfinished_threads: next })} />
                  </div>

                  <div className="editor-section">
                    <h3>{t().migration.memoriesHeading(selectedMemories.length, draft.memories.length)}</h3>
                    {draft.memories.map((memory) => (
                      <article key={memory.key} className={`migration-memory ${skipped[memory.key] ? 'is-skipped' : ''}`}>
                        <div className="memory-toolbar">
                          <label className="memory-toggle">
                            <input
                              type="checkbox"
                              aria-label={t().migration.importMemoryAria(memory.key)}
                              checked={!skipped[memory.key]}
                              onChange={(event) => setSkipped((current) => ({ ...current, [memory.key]: !event.target.checked }))}
                            />
                            {t().migration.importThis}
                          </label>
                          <label className="memory-importance">
                            {t().migration.importance(memory.importance)}
                            <input
                              type="range"
                              aria-label={t().migration.importanceAria(memory.key)}
                              min={1}
                              max={10}
                              value={memory.importance}
                              onChange={(event) => editMemory(memory.key, { importance: Number(event.target.value) })}
                            />
                          </label>
                          <button type="button" aria-label={t().migration.deleteMemoryAria(memory.key)} onClick={() => removeMemory(memory.key)}>
                            <Trash2 size={16} />
                          </button>
                        </div>
                        <textarea
                          aria-label={t().migration.memoryContentAria(memory.key)}
                          rows={2}
                          value={memory.content}
                          onChange={(event) => editMemory(memory.key, { content: event.target.value })}
                        />
                        <small>
                          {memory.approximate_time ?? t().migration.timeUnknown}
                          {memory.tags.length > 0 && ` · ${memory.tags.join('、')}`}
                          {memory.duplicate_of && t().migration.duplicateNote}
                        </small>
                      </article>
                    ))}
                    {!draft.memories.length && <p className="muted">{t().migration.noMemories}</p>}
                  </div>

                  {draft.uncertain_items.length > 0 && (
                    <div className="editor-section">
                      <h3>{t().migration.uncertainHeading(draft.uncertain_items.length)}</h3>
                      <p className="muted">{t().migration.uncertainLead}</p>
                      {draft.uncertain_items.map((item, index) => (
                        <article key={`uncertain-${index}`} className="migration-memory">
                          <textarea
                            aria-label={t().migration.uncertainAria(index + 1)}
                            rows={2}
                            value={item.content}
                            onChange={(event) => editDraft({
                              uncertain_items: draft.uncertain_items.map((entry, position) => (
                                position === index ? { ...entry, content: event.target.value } : entry
                              ))
                            })}
                          />
                          <small>{item.reason || t().migration.noReason}</small>
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
                            {t().migration.promoteToMemory}
                          </button>
                        </article>
                      ))}
                      <label className="memory-toggle">
                        <input
                          type="checkbox"
                          checked={keepUncertain}
                          onChange={(event) => setKeepUncertain(event.target.checked)}
                        />
                        {t().migration.keepInRecord}
                      </label>
                    </div>
                  )}

                  <div className="migration-actions">
                    <button className="secondary-button" onClick={() => setStep('input')}>{t().migration.backToJson}</button>
                    <button
                      className="primary-button"
                      disabled={!draft.character.name.trim() || !draft.relationship.summary.trim()}
                      onClick={() => setStep('confirm')}
                    >
                      {t().migration.nextConfirm}
                    </button>
                  </div>
                </>
              )}
            </>
          )}

          {step === 'confirm' && draft && (
            <>
              <div className="editor-section">
                <h3>{t().migration.importTargetHeading}</h3>
                <label className="memory-toggle">
                  <input type="radio" name="import-mode" checked={mode === 'CREATE'} onChange={() => setMode('CREATE')} />
                  {t().migration.createNamed(draft.character.name)}
                </label>
                <label className="memory-toggle">
                  <input
                    type="radio"
                    name="import-mode"
                    checked={mode === 'EXISTING'}
                    disabled={!ownedCharacters.length}
                    onChange={() => setMode('EXISTING')}
                  />
                  {t().migration.importIntoExisting}
                </label>
                {mode === 'EXISTING' && (
                  <>
                    <select aria-label={t().migration.chooseExistingAria} value={targetId} onChange={(event) => setTargetId(event.target.value)}>
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
                      {t().migration.overwriteExisting}
                    </label>
                  </>
                )}
                {!ownedCharacters.length && <p className="muted">{t().migration.noOwnedCharacters}</p>}
              </div>

              <ul className="migration-summary">
                <li>{t().migration.summaryCharacter(
                  mode === 'CREATE'
                    ? t().migration.willCreate
                    : updateExisting
                      ? t().migration.willUpdate
                      : t().migration.willReuse,
                  targetName ? `：${targetName}` : ''
                )}</li>
                <li>{t().migration.summaryMemories(selectedMemories.length)}</li>
                <li>{t().migration.summaryRelationship}</li>
                <li>{t().migration.summaryUncertain(keepUncertain ? draft.uncertain_items.length : 0)}</li>
                <li>{t().migration.summaryConversation}</li>
              </ul>
              <p className="privacy-footnote">
                {t().migration.noFakeHistory}
              </p>
              {error && <p className="inline-error">{error}</p>}
              <div className="migration-actions">
                <button className="secondary-button" onClick={() => setStep('review')}>{t().migration.backToEdit}</button>
                <button
                  className="primary-button"
                  disabled={busy || (mode === 'EXISTING' && !targetId)}
                  onClick={() => void commit()}
                >
                  {busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />} {t().migration.confirmImport}
                </button>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
